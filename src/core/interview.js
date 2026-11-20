// Modo entrevista: ouve o áudio do PC (a voz de quem entrevista no Teams), transcreve em inglês com o
// Whisper local e, a cada pergunta, pede ao Claude (modelo rápido) tópicos curtos de resposta baseados no
// seu currículo e na vaga (contexto.md). Nada é gravado em áudio; só o texto vai para um .md da entrevista.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, shorten } = require('./providers/common');
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

// Vale chamar a IA? Fala muito curta e sem cara de pergunta ("Great.", "Sure, sure.") não gasta cota.
const QUESTION_HINT = /\?|\b(what|why|how|when|where|which|who|tell me|walk me|describe|explain|give me|can you|could you|would you|do you|did you|have you|are you|is there|share)\b/i;
function worthAnalyzing(text, minWords = 4) {
  const s = String(text || '').trim();
  if (!s) return false;
  return wordCount(s) >= minWords || QUESTION_HINT.test(s);
}

function buildPrompt({ context, history, latest }) {
  return [
    'You are a live interview copilot for a candidate in a job interview in English on Microsoft Teams.',
    'Below: the candidate profile (resume and job description), the recent transcript of what the INTERVIEWERS said',
    '(speech-to-text, may contain recognition errors) and their LATEST speech.',
    '',
    'Task: decide if the LATEST speech asks the candidate something (a question, a request like "tell me about...",',
    'or a follow-up). Small talk that expects an answer ("how are you today?") counts as a question.',
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
    '- 3 to 4 bullets, max 18 words each, easy to say out loud for a non-native speaker (B1/B2 level vocabulary).',
    '- First bullet = the direct answer. Use concrete facts from the profile (companies, projects, technologies, results).',
    '- Behavioral questions: follow STAR briefly (situation, action, result).',
    '- Never invent employers, numbers, certifications or experience that is not in the profile.',
    '  If the profile has nothing about it, give an honest answer (eager to learn, related experience).',
    '- No markdown besides the "- " bullets. No intro, no closing remarks.',
    '',
    '<profile>',
    String(context || '(no profile provided)').trim(),
    '</profile>',
    '',
    '<recent_transcript>',
    history.length ? history.join('\n') : '(start of interview)',
    '</recent_transcript>',
    '',
    '<latest_interviewer_speech>',
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

class InterviewService {
  /**
   * @param {object} o
   * @param {import('../integrations/whisper').Whisper} o.whisper
   * @param {() => object} o.getConfig
   * @param {(channel:string, payload:any) => void} o.emit
   * @param {string} o.dataDir
   * @param {import('./usage').UsageTracker} [o.usage]
   */
  constructor({ whisper, getConfig, emit, dataDir, usage }) {
    this.whisper = whisper;
    this.getConfig = getConfig;
    this.emit = emit;
    this.usage = usage;
    this.dir = path.join(dataDir, 'entrevista');
    this.contextFile = path.join(this.dir, 'contexto.md');
    this.tmp = path.join(os.tmpdir(), 'ohara-entrevista');
    this.reset();
  }

  reset() {
    this.active = false;
    this.lines = []; // { at, text }
    this.pending = ''; // fala do entrevistador ainda sem análise
    this.queue = [];
    this.transcribing = false;
    this.analyzing = null; // { abort }
    this.rerun = false;
    this.cards = [];
    this.logFile = null;
    this.seq = 0;
  }

  get settings() {
    return { whisperModel: 'small', model: 'haiku', minWords: 4, historyLines: 14, ...this.getConfig().interview };
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
      contextFile: this.contextFile,
      whisper: this.whisper.status({ model: this.settings.whisperModel }),
    };
  }

  #status(mode, text) {
    this.emit('interview:status', { mode, text });
  }

  start() {
    if (this.active) return this.snapshot();
    const st = this.whisper.status({ model: this.settings.whisperModel });
    if (!st.installed) throw new Error(`Whisper ou o modelo "${this.settings.whisperModel}" não está instalado (pasta whisper da Ohara).`);
    this.reset();
    this.active = true;
    fs.mkdirSync(this.tmp, { recursive: true });
    const outDir = path.join(this.getConfig().outputDir || this.dir, 'Entrevistas');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', 'h');
    this.logFile = path.join(outDir, `entrevista-${stamp}.md`);
    fs.writeFileSync(this.logFile, `# Entrevista · ${new Date().toLocaleString('pt-BR')}\n\n`, 'utf8');
    this.#status('listening', 'Ouvindo o áudio do PC');
    return this.snapshot();
  }

  stop() {
    this.active = false;
    this.queue.length = 0;
    this.analyzing?.abort();
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

  /** Um trecho de áudio (WAV 16 kHz mono). turnEnd = depois dele veio uma pausa (fim de fala). */
  addAudio(bytes, { turnEnd = false } = {}) {
    if (!this.active) return;
    const file = path.join(this.tmp, `trecho-${Date.now()}-${++this.seq}.wav`);
    fs.writeFileSync(file, Buffer.from(bytes));
    this.queue.push({ file, turnEnd });
    this.#drain();
  }

  /** Fim de fala sem áudio novo (o último trecho foi cortado por tamanho, antes da pausa). */
  turnEnd() {
    if (!this.active) return;
    this.queue.push({ file: null, turnEnd: true });
    this.#drain();
  }

  async #drain() {
    if (this.transcribing) return;
    this.transcribing = true;
    let failed = false;
    try {
      while (this.active && this.queue.length) {
        const { file, turnEnd } = this.queue.shift();
        let text = '';
        if (file) {
          if (!this.analyzing) this.#status('transcribing', 'Transcrevendo…');
          try {
            text = cleanTranscript(await this.whisper.transcribe(file, { language: 'en', model: this.settings.whisperModel }));
            failed = false;
          } catch (err) {
            failed = true;
            this.#status('error', `Transcrição falhou: ${shorten(err.message, 110)}`);
          } finally {
            fs.rm(file, { force: true }, () => {});
          }
        }
        if (text) {
          const line = { at: Date.now(), text };
          this.lines.push(line);
          this.pending = `${this.pending} ${text}`.trim();
          this.emit('interview:line', line);
          this.#log(`**Entrevistador:** ${text}`);
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
    this.pending = '';
    this.#analyze(latest).catch(() => {});
  }

  /** Botão "Responder agora": analisa o que já foi dito, mesmo sem pausa. */
  answerNow() {
    if (!this.pending && this.lines.length) this.pending = this.lines.slice(-3).map((l) => l.text).join(' ');
    this.#maybeAnalyze(true);
  }

  /** Pergunta digitada (quando a transcrição falhar). */
  ask(text) {
    const s = String(text || '').trim();
    if (!s) return;
    this.pending = s;
    this.#maybeAnalyze(true);
  }

  async #analyze(latest) {
    const s = this.settings;
    const historyLines = this.lines.slice(-s.historyLines).map((l) => l.text);
    const prompt = buildPrompt({ context: this.readContext(), history: historyLines, latest });
    const card = { id: `c${Date.now()}`, at: Date.now(), original: latest, questionPt: '', bullets: [], state: 'thinking' };
    const controller = new AbortController();
    this.analyzing = { abort: () => controller.abort() };
    this.emit('interview:card', card);
    this.#status('thinking', 'Pensando na resposta…');

    let text = '';
    let error = null;
    const config = this.getConfig();
    try {
      const { code, stderr, aborted } = await runJsonl({
        cmd: config.claude.bin,
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', s.model,
          '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config'],
        env: claudeEnv(config),
        cwd: os.tmpdir(),
        input: prompt,
        signal: controller.signal,
        onJson: (ev) => {
          if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
            text += ev.event.delta.text;
            const p = parseAnswer(text);
            if (p.none) {
              controller.abort(); // não é pergunta: para de gastar
              return;
            }
            if (!p.pending) this.emit('interview:card', { ...card, ...p, state: 'streaming' });
          }
          if (ev.type === 'rate_limit_event') this.usage?.updateClaudeLimits?.(ev.rate_limit_info);
          if (ev.type === 'result') {
            if (!text && ev.result) text = ev.result;
            if (ev.is_error) error = ev.result || ev.subtype;
          }
        },
      });
      if (!text && !aborted && code !== 0) error = error || shorten(stderr, 200) || `claude saiu com código ${code}`;
    } catch (err) {
      error = err.message;
    } finally {
      this.analyzing = null;
    }

    const parsed = parseAnswer(text);
    if (parsed.none) {
      this.emit('interview:card', { ...card, state: 'dismissed' });
    } else if (error && !parsed.bullets?.length) {
      const done = { ...card, state: 'error', error: friendlyError(error) };
      this.cards.push(done);
      this.emit('interview:card', done);
    } else if (parsed.bullets?.length) {
      const done = { ...card, ...parsed, state: 'done', ms: Date.now() - card.at };
      this.cards.push(done);
      this.emit('interview:card', done);
      this.#log(`> **Pergunta:** ${done.questionPt}\n${done.bullets.map((b) => `> - ${b}`).join('\n')}`);
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

module.exports = { InterviewService, cleanTranscript, worthAnalyzing, buildPrompt, parseAnswer, DEFAULT_CONTEXT };
