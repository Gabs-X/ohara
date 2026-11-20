// Modo entrevista: ouve o áudio do PC (a voz de quem entrevista no Teams), transcreve em inglês com o
// Whisper local e, a cada pergunta, pede ao Claude (modelo rápido) tópicos curtos de resposta baseados no
// seu currículo e na vaga (contexto.md). O seu microfone também é transcrito, só para a transcrição salva
// (e o contexto do Claude) terem as suas respostas. Nada é gravado em áudio; só o texto vai para um .md.
//
// Velocidade: ao clicar em "Começar a ouvir", o whisper-server (modelo carregado uma vez) e um processo do
// Claude (entrada em stream-json, sem MCP nem ferramentas) já ficam abertos. Cada pergunta só manda uma
// mensagem nova para eles: ~0,5 s até a primeira palavra do Claude, contra ~3 s abrindo o processo a cada vez.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { killTree, shorten } = require('./providers/common');
const { claudeEnv, friendlyError } = require('./providers/claude');

// O Whisper "inventa" estas frases em trechos de silêncio ou ruído.
const HALLUCINATIONS = [
  /^\(?\[?(blank_audio|silence|music|applause|laughter|inaudible|no speech)\]?\)?\.?$/i,
  /^(thank you|thanks|thanks for watching|thank you for watching|you|bye|okay|ok|so|uh|um|hmm|yeah)[.!?]*$/i,
  /^[.\s…-]*$/,
];

function cleanTranscript(text) {
  // O Whisper marca troca de quem fala com "- " no começo.
  const s = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[-–—]\s*/, '');
  if (!s || HALLUCINATIONS.some((re) => re.test(s))) return '';
  return s;
}

const wordCount = (s) => (String(s).match(/[\p{L}\p{N}']+/gu) || []).length;
const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

// Com alto-falante, o microfone também capta a voz de quem entrevista. Fala do microfone cujas palavras
// quase todas acabaram de aparecer no áudio do PC é eco, não você.
function isEcho(text, recentTheirs) {
  const mine = words(text);
  if (!mine.length) return true;
  const theirs = new Set(recentTheirs.flatMap(words));
  return mine.filter((w) => theirs.has(w)).length / mine.length >= 0.7;
}

const speakerLabel = (l) => (l.speaker === 'me' ? 'Candidate' : 'Interviewer');

// Vale chamar a IA? Fala muito curta e sem cara de pergunta ("Great.", "Sure, sure.") não gasta cota.
const QUESTION_HINT = /\?|\b(what|why|how|when|where|which|who|tell me|walk me|describe|explain|give me|can you|could you|would you|do you|did you|have you|are you|is there|share)\b/i;
function worthAnalyzing(text, minWords = 4) {
  const s = String(text || '').trim();
  if (!s) return false;
  return wordCount(s) >= minWords || QUESTION_HINT.test(s);
}

// Instruções fixas + perfil: vão uma vez só, como prompt de sistema do processo que fica aberto.
function buildSystemPrompt(context) {
  return [
    'You are a live interview copilot for a candidate in a job interview in English on Microsoft Teams.',
    'Each user message brings the recent transcript of the call (speech-to-text, may contain recognition errors),',
    'with "Interviewer:" and "Candidate:" lines (what the candidate already answered), and the LATEST interviewer speech.',
    'Use what the candidate already said to understand follow-ups ("can you elaborate on that?").',
    '',
    'Task: decide if the LATEST speech asks the candidate something (a question, a request like "tell me about...",',
    'or a follow-up). Small talk that expects an answer ("how are you today?") counts as a question.',
    'If the LATEST speech is marked as a continuation, it is the same question with more words: answer the full question again.',
    '',
    'If it does NOT ask anything (statements, the interviewer talking about the company, greetings that need no answer),',
    'reply with exactly: NONE',
    '',
    'If it DOES, reply in exactly this format and nothing else:',
    'PT: <the question translated to Brazilian Portuguese, one short line>',
    '- <talking point in simple, natural spoken English>',
    '- <talking point>',
    '- <talking point>',
    '',
    'Rules for the talking points:',
    '- 3 to 4 bullets, max 14 words each, easy to say out loud for a non-native speaker (B1/B2 level vocabulary).',
    '- Short spoken phrases, not full essays: the candidate glances at them while talking.',
    '- First bullet = the direct answer. Use concrete facts from the profile (companies, projects, technologies, results).',
    '- Behavioral questions: follow STAR briefly (situation, action, result).',
    '- Never invent employers, dates, numbers, certifications or experience that is not in the profile.',
    '  Respect the dates in the profile exactly (e.g. a degree that ended is finished, a job that ended is past).',
    '  If the profile has nothing about it, give an honest answer (eager to learn, related experience).',
    '- "How would you / how do you approach" questions: describe a confident, senior approach with industry best practices',
    '  (that is knowledge, not a claim), then tie it to one real example from the profile. Only claim as experience what is in the profile.',
    '- Every bullet is something the candidate says out loud. Never put notes or instructions to him in the bullets.',
    '- Stay consistent with what you suggested earlier in this interview.',
    '- No markdown besides the "- " bullets. No intro, no closing remarks.',
    '',
    '<profile>',
    String(context || '(no profile provided)').trim(),
    '</profile>',
  ].join('\n');
}

// Retomada (Parar → Começar, ou o Claude reabriu): o processo novo não lembra de nada, então a primeira
// mensagem leva tudo o que já aconteceu na entrevista, para as respostas continuarem coerentes.
function buildEarlier({ lines, cards }) {
  if (!lines.length && !cards.length) return '';
  const qa = cards.filter((c) => c.bullets?.length).map((c) => `Q: ${c.original}\nSuggested: ${c.bullets.join(' / ')}`);
  return [
    '<earlier_in_this_interview>',
    'Everything said so far:',
    ...lines.map((l) => `${speakerLabel(l)}: ${l.text}`),
    ...(qa.length ? ['', 'Talking points you already suggested (stay consistent with them):', ...qa] : []),
    '</earlier_in_this_interview>',
    '',
  ].join('\n');
}

function buildTurn({ history, latest, continuation = false, earlier = '' }) {
  return [
    ...(earlier ? [earlier] : []),
    '<recent_transcript>',
    history.length ? history.join('\n') : '(start of interview)',
    '</recent_transcript>',
    '',
    continuation ? '<latest_interviewer_speech continuation="true">' : '<latest_interviewer_speech>',
    latest,
    '</latest_interviewer_speech>',
  ].join('\n');
}

// Lê a resposta (inclusive pela metade, enquanto chega em fluxo).
function parseAnswer(text) {
  const s = String(text || '').trim();
  if (!s) return { pending: true };
  if (/^NONE\b/i.test(s)) return { none: true };
  if ('NONE'.startsWith(s.toUpperCase())) return { pending: true }; // "NO" chegando
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  let questionPt = '';
  const bullets = [];
  for (const l of lines) {
    const pt = l.match(/^PT:\s*(.*)$/i);
    if (pt) questionPt = pt[1].trim();
    else if (/^[-*•]\s*/.test(l)) bullets.push(l.replace(/^[-*•]\s*/, '').replace(/\*\*/g, ''));
    else if (bullets.length) bullets[bullets.length - 1] += ` ${l}`;
  }
  return { questionPt, bullets };
}

const DEFAULT_CONTEXT = `# Contexto da entrevista
Edite este arquivo antes da entrevista: a Ohara manda ele inteiro para a IA a cada pergunta.
Quanto mais concreto (projetos, números, resultados), melhores as respostas.

## Vaga
(cole aqui a descrição da vaga e o nome da empresa)

## Currículo
(cole aqui o seu currículo)
`;

/**
 * Um processo do Claude Code aberto durante toda a entrevista (entrada e saída em stream-json).
 * Cada ask() manda uma mensagem e espera o "result" dela; pedidos ficam em fila.
 */
class ClaudeSession {
  constructor({ bin, model, env, systemPrompt, onLimits }) {
    Object.assign(this, { bin, model, env, systemPrompt, onLimits });
    this.proc = null;
    this.current = null; // { onDelta, resolve, text }
    this.queue = [];
    this.stderr = '';
    this.turns = 0; // mensagens já respondidas por este processo (0 = não lembra de nada)
  }

  start() {
    if (this.proc) return;
    this.turns = 0;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', this.model, '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config',
      '--system-prompt', this.systemPrompt];
    const proc = spawn(this.bin, args, { cwd: os.tmpdir(), env: { ...process.env, ...this.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line.replace(/^﻿/, '').trim()); } catch { return; }
      this.#onEvent(ev);
    });
    proc.on('error', (err) => this.#fail(err.message));
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.#fail(shorten(this.stderr, 200) || `o Claude fechou (código ${code})`);
    });
  }

  #onEvent(ev) {
    if (ev.type === 'rate_limit_event') this.onLimits?.(ev.rate_limit_info);
    const cur = this.current;
    if (!cur) return;
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
      cur.text += ev.event.delta.text;
      cur.onDelta?.(cur.text);
    }
    if (ev.type === 'result') {
      if (!ev.is_error) this.turns++;
      if (!cur.text && ev.result) cur.text = ev.result;
      this.#finish({ text: cur.text, error: ev.is_error ? friendlyError(ev.result || ev.subtype) : null });
    }
  }

  #finish(r) {
    const cur = this.current;
    this.current = null;
    cur?.resolve(r);
    this.#next();
  }

  #fail(msg) {
    if (this.current) this.#finish({ text: this.current.text, error: friendlyError(msg) });
    for (const q of this.queue.splice(0)) q.resolve({ text: '', error: friendlyError(msg) });
  }

  #next() {
    if (this.current || !this.queue.length) return;
    if (!this.proc) this.start();
    this.current = this.queue.shift();
    this.current.text = '';
    const m = this.current.message;
    const content = typeof m === 'function' ? m(this.turns === 0) : m;
    this.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  }

  /** message pode ser uma função (fresh) => texto: decidida na hora do envio, quando já se sabe se o processo é novo. */
  ask(message, onDelta) {
    return new Promise((resolve) => {
      this.queue.push({ message, onDelta, resolve });
      this.#next();
    });
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.#fail('Entrevista encerrada.');
    if (p?.pid) killTree(p.pid);
  }
}

class InterviewService {
  /**
   * @param {object} o
   * @param {import('../integrations/whisper').Whisper} o.whisper
   * @param {() => object} o.getConfig
   * @param {(channel:string, payload:any) => void} o.emit
   * @param {string} o.dataDir
   * @param {import('./usage').UsageTracker} [o.usage]
   * @param {(o:object) => ClaudeSession} [o.createSession]  troca o Claude (testes)
   */
  constructor({ whisper, getConfig, emit, dataDir, usage, createSession }) {
    this.whisper = whisper;
    this.getConfig = getConfig;
    this.emit = emit;
    this.usage = usage;
    this.createSession = createSession || ((o) => new ClaudeSession(o));
    this.dir = path.join(dataDir, 'entrevista');
    this.contextFile = path.join(this.dir, 'contexto.md');
    this.tmp = path.join(os.tmpdir(), 'ohara-entrevista');
    this.server = null;
    this.session = null;
    this.reset();
  }

  reset() {
    this.active = false;
    this.lines = []; // { at, text, speaker: 'them' | 'me' }
    this.pending = ''; // fala do entrevistador ainda sem análise
    this.queue = [];
    this.myQueue = []; // trechos do seu microfone: transcritos só quando não há fala de quem entrevista na fila
    this.transcribing = false;
    this.analyzing = false;
    this.rerun = false;
    this.cards = [];
    this.mySpeechAt = 0;
    this.lastCard = null; // para juntar a continuação de uma pergunta ao mesmo cartão
    this.logFile = null;
    this.seq = 0;
  }

  get settings() {
    return { whisperModel: 'small', whisperBinDir: '', model: 'haiku', minWords: 4, historyLines: 20, captureMic: true, mergeWindowMs: 3000, resumeWithinMs: 3 * 60 * 60 * 1000, ...this.getConfig().interview };
  }

  transcriptsDir() {
    return path.join(this.getConfig().outputDir || this.dir, 'Entrevistas');
  }

  ensureContext() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.contextFile)) fs.writeFileSync(this.contextFile, DEFAULT_CONTEXT, 'utf8');
    return this.contextFile;
  }

  readContext() {
    try {
      return fs.readFileSync(this.ensureContext(), 'utf8');
    } catch {
      return '';
    }
  }

  snapshot() {
    return {
      active: this.active,
      lines: this.lines.slice(-40),
      cards: this.cards.slice(-20),
      logFile: this.logFile,
      captureMic: this.settings.captureMic !== false,
      contextFile: this.contextFile,
      whisper: this.whisper.status({ model: this.settings.whisperModel }),
    };
  }

  #status(mode, text) {
    this.emit('interview:status', { mode, text });
  }

  async start() {
    if (this.active) return this.snapshot();
    const s = this.settings;
    const st = this.whisper.status({ model: s.whisperModel });
    if (!st.installed) throw new Error(`Whisper ou o modelo "${s.whisperModel}" não está instalado (pasta whisper da Ohara).`);
    // Parou e voltou (ou fechou a janela) na mesma entrevista: continua com tudo o que já foi dito.
    const resume = !!this.logFile && (this.lines.length || this.cards.length) && Date.now() - (this.lastActivity || 0) < s.resumeWithinMs;
    if (resume) {
      Object.assign(this, { queue: [], myQueue: [], pending: '', pendingSince: 0, transcribing: false, analyzing: false, rerun: false, lastCard: null });
      this.active = true;
      this.#log(`_Retomada às ${new Date().toLocaleTimeString('pt-BR')}._`);
    } else {
      this.reset();
      this.active = true;
      const outDir = this.transcriptsDir();
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', 'h');
      this.logFile = path.join(outDir, `entrevista-${stamp}.md`);
      fs.writeFileSync(this.logFile, `# Entrevista · ${new Date().toLocaleString('pt-BR')}\n\n`, 'utf8');
    }
    this.lastActivity = Date.now();
    fs.mkdirSync(this.tmp, { recursive: true });

    this.#status('starting', 'Preparando o Claude e o Whisper…');
    const config = this.getConfig();
    this.session = this.createSession({
      bin: config.claude.bin, model: s.model, env: claudeEnv(config), systemPrompt: buildSystemPrompt(this.readContext()),
      onLimits: (info) => this.usage?.updateClaudeLimits?.(info),
    });
    this.session.start();
    // Whisper sempre carregado; se o servidor falhar, cada trecho volta a usar o whisper-cli (mais lento).
    if (this.whisper.server) {
      const server = this.whisper.server({ model: s.whisperModel, language: 'en', binDir: s.whisperBinDir });
      try {
        await server.start();
        if (this.active) this.server = server;
        else server.stop();
      } catch (err) {
        this.#log(`_Whisper em modo servidor falhou (${err.message}); usando o modo lento._`);
      }
    }
    if (this.active) this.#status('listening', this.server ? 'Ouvindo o áudio do PC' : 'Ouvindo (Whisper no modo lento)');
    return this.snapshot();
  }

  /** Botão "Nova entrevista": esquece a anterior (a transcrição dela continua salva no .md). */
  newInterview() {
    this.stop();
    this.reset();
    this.lastActivity = 0;
    this.#status('off', 'Pronto para uma nova entrevista');
    return this.snapshot();
  }

  stop() {
    this.lastActivity = Date.now();
    this.active = false;
    this.queue.length = 0;
    this.myQueue.length = 0;
    this.server?.stop();
    this.server = null;
    this.session?.stop();
    this.session = null;
    this.#status('off', this.logFile ? 'Parado. Transcrição salva.' : 'Parado');
    return this.snapshot();
  }

  #log(text) {
    if (!this.logFile) return;
    try {
      fs.appendFileSync(this.logFile, `${text}\n\n`, 'utf8');
    } catch {
      /* arquivo preso: segue sem registrar */
    }
  }

  #say(who, text) {
    this.#log(`\`${new Date().toLocaleTimeString('pt-BR')}\` **${who}:** ${text}`);
  }

  /**
   * Um trecho de áudio (WAV 16 kHz mono). turnEnd = depois dele veio uma pausa (fim de fala).
   * speaker 'me' = seu microfone: só vai para a transcrição e o histórico, nunca vira pergunta.
   */
  addAudio(bytes, { turnEnd = false, startedAt, speaker } = {}) {
    if (!this.active) return;
    const me = speaker === 'me';
    if (me && this.settings.captureMic === false) return;
    const file = path.join(this.tmp, `trecho-${Date.now()}-${++this.seq}.wav`);
    fs.writeFileSync(file, Buffer.from(bytes));
    const item = { file, turnEnd: me ? false : turnEnd, startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(), speaker: me ? 'me' : 'them' };
    (me ? this.myQueue : this.queue).push(item);
    if (me) this.mySpeechAt = item.startedAt; // você falou: a próxima fala de quem entrevista é pergunta nova
    this.#drain();
  }

  /** Fim de fala sem áudio novo (o último trecho foi cortado por tamanho, antes da pausa). */
  turnEnd() {
    if (!this.active) return;
    this.queue.push({ file: null, turnEnd: true });
    this.#drain();
  }

  #transcribe(file) {
    if (this.server) return this.server.transcribe(file);
    return this.whisper.transcribe(file, { language: 'en', model: this.settings.whisperModel });
  }

  async #drain() {
    if (this.transcribing) return;
    this.transcribing = true;
    let failed = false;
    try {
      // A voz de quem entrevista vem primeiro (é dela que sai a resposta); a sua é transcrita nas brechas.
      while (this.active && (this.queue.length || this.myQueue.length)) {
        const { file, turnEnd, startedAt, speaker = 'them' } = this.queue.length ? this.queue.shift() : this.myQueue.shift();
        let text = '';
        if (file) {
          if (!this.analyzing) this.#status('transcribing', 'Transcrevendo…');
          try {
            text = cleanTranscript(await this.#transcribe(file));
            failed = false;
          } catch (err) {
            failed = true;
            this.#status('error', `Transcrição falhou: ${shorten(err.message, 110)}`);
          } finally {
            fs.rm(file, { force: true }, () => {});
          }
        }
        if (text && speaker === 'me') {
          const recentTheirs = this.lines.filter((l) => l.speaker !== 'me' && l.at > Date.now() - 20_000).map((l) => l.text);
          if (!isEcho(text, recentTheirs)) {
            const line = { at: Date.now(), text, speaker: 'me' };
            this.lines.push(line);
            this.lastActivity = line.at;
            this.emit('interview:line', line);
            this.#say('Eu', text);
          }
        } else if (text) {
          const line = { at: Date.now(), text, speaker: 'them' };
          this.lines.push(line);
          this.lastActivity = line.at;
          if (!this.pending) this.pendingSince = startedAt || line.at;
          this.pending = `${this.pending} ${text}`.trim();
          this.emit('interview:line', line);
          this.#say('Entrevistador', text);
        }
        if (turnEnd) this.#maybeAnalyze();
      }
    } finally {
      this.transcribing = false;
      if (this.active && !this.analyzing && !failed) this.#status('listening', 'Ouvindo o áudio do PC');
    }
  }

  #maybeAnalyze(force = false) {
    if (!this.pending) return;
    if (!force && !worthAnalyzing(this.pending, this.settings.minWords)) return;
    if (this.analyzing) {
      this.rerun = true; // fala nova enquanto a anterior era analisada: analisa de novo com tudo
      return;
    }
    const latest = this.pending;
    const since = this.pendingSince || Date.now();
    this.pending = '';
    this.pendingSince = 0;
    this.#analyze(latest, since).catch(() => {});
  }

  /** Botão "Responder agora": analisa o que já foi dito, mesmo sem pausa. */
  answerNow() {
    const theirs = this.lines.filter((l) => l.speaker !== 'me');
    if (!this.pending && theirs.length) this.pending = theirs.slice(-3).map((l) => l.text).join(' ');
    this.#maybeAnalyze(true);
  }

  /** Pergunta digitada (quando a transcrição falhar). */
  ask(text) {
    const s = String(text || '').trim();
    if (!s) return;
    this.pending = s;
    this.#maybeAnalyze(true);
  }

  async #analyze(spoken, since = Date.now()) {
    const s = this.settings;
    if (!this.session) {
      const config = this.getConfig();
      this.session = this.createSession({
        bin: config.claude.bin, model: s.model, env: claudeEnv(config), systemPrompt: buildSystemPrompt(this.readContext()),
        onLimits: (info) => this.usage?.updateClaudeLimits?.(info),
      });
    }
    // Pausa curta no meio da pergunta: a continuação vai junto com o começo e atualiza o mesmo cartão.
    // Mede do fim da fala anterior até o começo da fala nova (você ainda não começou a responder).
    const prev = this.lastCard;
    const answered = (this.mySpeechAt || 0) > prev?.since; // você já começou a responder depois da pergunta
    const continuation = !!prev && !answered && since - prev.endedAt < s.mergeWindowMs;
    const latest = continuation ? `${prev.original} ${spoken}` : spoken;
    const startedAt = Date.now();
    const card = { id: continuation ? prev.id : `c${startedAt}`, at: startedAt, original: latest, questionPt: '', bullets: [], state: 'thinking' };
    this.lastCard = { id: card.id, original: latest, endedAt: startedAt, since: continuation ? prev.since : since };
    this.analyzing = true;
    if (!continuation || prev.dismissed) this.emit('interview:card', card);
    this.#status('thinking', 'Pensando na resposta…');

    const recent = this.lines.slice(-s.historyLines);
    const history = recent.map((l) => `${speakerLabel(l)}: ${l.text}`);
    // Processo novo (retomada ou o Claude reabriu): manda junto o que veio antes das falas recentes.
    const earlierLines = this.lines.slice(0, this.lines.length - recent.length);
    const message = (fresh) => buildTurn({
      history, latest, continuation,
      earlier: fresh ? buildEarlier({ lines: earlierLines, cards: this.cards.filter((c) => c.id !== card.id) }) : '',
    });
    let dismissedEarly = false;
    const r = await this.session.ask(message, (text) => {
      const p = parseAnswer(text);
      if (p.none && !dismissedEarly) {
        dismissedEarly = true;
        this.emit('interview:card', { ...card, state: 'dismissed' });
      } else if (!p.pending && !p.none) this.emit('interview:card', { ...card, ...p, state: 'streaming' });
    });
    this.analyzing = false;

    const parsed = parseAnswer(r.text);
    const finishedAt = Date.now();
    if (parsed.none) {
      if (!dismissedEarly) this.emit('interview:card', { ...card, state: 'dismissed' });
      this.lastCard.dismissed = true;
    } else if (parsed.bullets?.length) {
      const done = { ...card, ...parsed, state: 'done', ms: finishedAt - startedAt };
      const i = this.cards.findIndex((c) => c.id === done.id);
      if (i >= 0) this.cards[i] = done;
      else this.cards.push(done);
      this.emit('interview:card', done);
      this.#log(`> **Pergunta:** ${done.questionPt}\n${done.bullets.map((b) => `> - ${b}`).join('\n')}`);
    } else if (r.error) {
      const done = { ...card, state: 'error', error: r.error };
      this.cards.push(done);
      this.emit('interview:card', done);
    } else {
      this.emit('interview:card', { ...card, state: 'dismissed' });
    }
    if (this.active) this.#status('listening', 'Ouvindo o áudio do PC');
    if (this.rerun) {
      this.rerun = false;
      this.#maybeAnalyze();
    }
  }
}

module.exports = { InterviewService, ClaudeSession, cleanTranscript, worthAnalyzing, isEcho, buildSystemPrompt, buildTurn, buildEarlier, parseAnswer, DEFAULT_CONTEXT };
