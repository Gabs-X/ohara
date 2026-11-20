const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InterviewService, cleanTranscript, worthAnalyzing, buildSystemPrompt, buildTurn, parseAnswer } = require('../src/core/interview');

test('descarta alucinações do Whisper em silêncio', () => {
  assert.strictEqual(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.strictEqual(cleanTranscript(' Thank you. '), '');
  assert.strictEqual(cleanTranscript('(music)'), '');
  assert.strictEqual(cleanTranscript('...'), '');
  assert.strictEqual(cleanTranscript('Tell me about  yourself [inaudible]'), 'Tell me about yourself');
  assert.strictEqual(cleanTranscript('- Hi Gabriel, thanks for joining.'), 'Hi Gabriel, thanks for joining.');
});

test('só chama a IA para fala com conteúdo ou cara de pergunta', () => {
  assert.strictEqual(worthAnalyzing('Great.'), false);
  assert.strictEqual(worthAnalyzing('Sure, sure.'), false);
  assert.strictEqual(worthAnalyzing('Why us?'), true);
  assert.strictEqual(worthAnalyzing('Tell me more'), true);
  assert.strictEqual(worthAnalyzing('We are a global logistics company'), true);
  assert.strictEqual(worthAnalyzing(''), false);
});

test('o perfil vai uma vez no prompt de sistema; cada pergunta leva só o histórico e a fala nova', () => {
  const sys = buildSystemPrompt('React and Node');
  assert.match(sys, /<profile>\nReact and Node\n<\/profile>/);
  assert.match(sys, /exactly: NONE/);
  const turn = buildTurn({ history: ['Hi Gabriel'], latest: 'What is your biggest strength?' });
  assert.match(turn, /<recent_transcript>\nHi Gabriel\n/);
  assert.match(turn, /<latest_interviewer_speech>\nWhat is your biggest strength\?\n/);
  assert.doesNotMatch(turn, /React and Node/);
  assert.match(buildTurn({ history: [], latest: 'x', continuation: true }), /continuation="true"/);
});

test('lê a resposta completa, parcial e o NONE', () => {
  assert.deepStrictEqual(parseAnswer('NONE'), { none: true });
  assert.deepStrictEqual(parseAnswer('NO'), { pending: true });
  assert.deepStrictEqual(parseAnswer(''), { pending: true });
  const r = parseAnswer('PT: Fale sobre você\n- Full stack developer, 3 years\n- **React** and Node\n  at Eletrozema\n- Fast learner');
  assert.strictEqual(r.questionPt, 'Fale sobre você');
  assert.deepStrictEqual(r.bullets, ['Full stack developer, 3 years', 'React and Node at Eletrozema', 'Fast learner']);
  assert.deepStrictEqual(parseAnswer('PT: Por que esta empresa?\n- Global').bullets, ['Global']);
});

// Claude falso: responde com o texto que o teste mandar (ou NONE) e registra as mensagens.
function fakeSession(replies, sent) {
  return () => ({
    start() {},
    stop() {},
    ask: async (message, onDelta) => {
      sent.push(typeof message === 'function' ? message(false) : message);
      const text = replies.shift() ?? 'NONE';
      onDelta?.(text);
      return { text, error: null };
    },
  });
}

function fakeService(transcripts, replies = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-entrevista-teste-'));
  const events = [];
  const calls = [];
  const sent = [];
  const whisper = {
    status: () => ({ installed: true, modelName: 'small' }),
    transcribe: async (file, opts) => {
      calls.push(opts);
      return transcripts.shift() ?? '';
    },
  };
  const svc = new InterviewService({
    whisper,
    getConfig: () => ({ outputDir: dir, claude: { bin: 'claude' }, interview: {} }),
    emit: (ch, p) => events.push([ch, p]),
    dataDir: dir,
    createSession: fakeSession(replies, sent),
  });
  return { svc, events, calls, sent, dir };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const cardsOf = (events) => events.filter(([ch]) => ch === 'interview:card').map(([, p]) => p);

test('sem whisper-server, transcreve em inglês com o modelo small e registra a fala', async () => {
  const { svc, events, calls } = fakeService(['Could you introduce yourself?']);
  await svc.start();
  svc.addAudio(new Uint8Array([1, 2, 3]), { turnEnd: false });
  await settle();
  assert.deepStrictEqual(calls[0], { language: 'en', model: 'small' });
  assert.ok(events.some(([ch, p]) => ch === 'interview:line' && p.text === 'Could you introduce yourself?'));
  assert.match(fs.readFileSync(svc.logFile, 'utf8'), /\*\*Entrevistador:\*\* Could you introduce yourself\?/);
  assert.strictEqual(svc.pending, 'Could you introduce yourself?'); // sem pausa ainda: não analisa
  svc.stop();
});

test('usa o whisper-server quando ele sobe e para ele no fim', async () => {
  const { svc } = fakeService([]);
  const log = [];
  svc.whisper.server = (o) => ({
    start: async () => log.push(['start', o]),
    transcribe: async () => 'Tell me about yourself',
    stop: () => log.push(['stop']),
  });
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: false });
  await settle();
  assert.deepStrictEqual(log[0], ['start', { model: 'small', language: 'en', binDir: '' }]);
  assert.strictEqual(svc.pending, 'Tell me about yourself');
  svc.stop();
  assert.deepStrictEqual(log[1], ['stop']);
});

test('fim de fala manda ao Claude tudo o que foi dito e mostra o cartão com o tempo', async () => {
  const { svc, events, sent } = fakeService(['So tell me about', 'a hard bug you fixed.'], ['PT: Fale de um bug difícil\n- IIS CPU issue\n- Logs\n- Fixed']);
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: false });
  svc.addAudio(new Uint8Array([2]), { turnEnd: false });
  await settle();
  svc.turnEnd();
  await settle();
  assert.match(sent[0], /<latest_interviewer_speech>\nSo tell me about a hard bug you fixed\.\n/);
  const done = cardsOf(events).find((c) => c.state === 'done');
  assert.strictEqual(done.questionPt, 'Fale de um bug difícil');
  assert.deepStrictEqual(done.bullets, ['IIS CPU issue', 'Logs', 'Fixed']);
  assert.ok(Number.isFinite(done.ms));
  assert.strictEqual(svc.pending, '');
  svc.stop();
});

test('continuação logo depois de uma pausa curta atualiza o mesmo cartão', async () => {
  const { svc, events, sent } = fakeService(['Tell me about a project', 'that you are proud of.'], ['PT: Fale de um projeto\n- A', 'PT: Fale de um projeto do qual se orgulha\n- B']);
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true });
  await settle();
  svc.addAudio(new Uint8Array([2]), { turnEnd: true });
  await settle();
  assert.match(sent[1], /continuation="true">\nTell me about a project that you are proud of\.\n/);
  const done = cardsOf(events).filter((c) => c.state === 'done');
  assert.strictEqual(done.length, 2);
  assert.strictEqual(done[0].id, done[1].id);
  assert.strictEqual(svc.cards.length, 1);
  assert.deepStrictEqual(svc.cards[0].bullets, ['B']);
  svc.stop();
});

test('fala que não é pergunta some da tela', async () => {
  const { svc, events } = fakeService(["I'm Sarah, I lead the platform team here."], ['NONE']);
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true });
  await settle();
  const cards = cardsOf(events);
  assert.strictEqual(cards.at(-1).state, 'dismissed');
  assert.strictEqual(svc.cards.length, 0);
  svc.stop();
});

test('fala curta sem pergunta nem chama a IA', async () => {
  const { svc, sent } = fakeService(['Great.']);
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true });
  await settle();
  assert.strictEqual(sent.length, 0);
  svc.stop();
});

test('Parar → Começar continua a mesma entrevista e o Claude novo recebe tudo o que veio antes', async () => {
  const { svc, sent } = fakeService(['Tell me about yourself please.', 'And why React?'], ['PT: Fale de você\n- Dev at Zema', 'PT: Por que React?\n- Typed UI']);
  let sessions = 0;
  const make = svc.createSession;
  svc.createSession = (o) => {
    sessions++;
    const s = make(o);
    let turns = 0;
    const ask = s.ask;
    // imita o processo real: só a primeira mensagem de cada processo é "fresh"
    s.ask = (m, d) => ask(typeof m === 'function' ? m(turns++ === 0) : m, d);
    return s;
  };
  await svc.start();
  const log = svc.logFile;
  svc.addAudio(new Uint8Array([1]), { turnEnd: true });
  await settle();
  svc.stop();
  await svc.start(); // retomada
  assert.strictEqual(svc.logFile, log);
  assert.strictEqual(svc.cards.length, 1);
  svc.addAudio(new Uint8Array([2]), { turnEnd: true, startedAt: Date.now() + 10_000 });
  await settle();
  assert.strictEqual(sessions, 2);
  assert.doesNotMatch(sent[0], /earlier_in_this_interview/);
  assert.match(sent[1], /<earlier_in_this_interview>[\s\S]*Q: Tell me about yourself please\.\nSuggested: Dev at Zema/);
  assert.match(fs.readFileSync(log, 'utf8'), /_Retomada às/);
  svc.newInterview();
  assert.strictEqual(svc.lines.length, 0);
  await svc.start();
  assert.notStrictEqual(svc.cards.length, 1);
  svc.stop();
});

test('não começa sem o modelo do Whisper', async () => {
  const { svc } = fakeService([]);
  svc.whisper.status = () => ({ installed: false });
  await assert.rejects(svc.start(), /Whisper/);
});

test('cria o contexto.md padrão na primeira vez', () => {
  const { svc } = fakeService([]);
  assert.match(fs.readFileSync(svc.ensureContext(), 'utf8'), /## Vaga/);
});
