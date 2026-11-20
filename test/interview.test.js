const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InterviewService, cleanTranscript, worthAnalyzing, isEcho, buildSystemPrompt, buildTurn, parseAnswer, similarity, findRepeat } = require('../src/core/interview');

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

test('lê a resposta completa, parcial, o NONE e o SAME', () => {
  assert.deepStrictEqual(parseAnswer('NONE'), { none: true });
  assert.deepStrictEqual(parseAnswer('SAME'), { same: true });
  assert.deepStrictEqual(parseAnswer('NO'), { pending: true });
  assert.deepStrictEqual(parseAnswer('SA'), { pending: true });
  assert.deepStrictEqual(parseAnswer(''), { pending: true });
  const r = parseAnswer('PT: Há quanto tempo usa React?\nSAY: **Four years** with React. Three at Zema.\nKEYS: Zema · Next.js · iRose · extra');
  assert.deepStrictEqual(r, { questionPt: 'Há quanto tempo usa React?', say: 'Four years with React. Three at Zema.', keys: ['Zema', 'Next.js', 'iRose'] });
  // pela metade: o rótulo da próxima linha ainda chegando não entra na frase
  assert.deepStrictEqual(parseAnswer('PT: Fale de você\nSAY: Full stack dev\nKE'), { questionPt: 'Fale de você', say: 'Full stack dev', keys: [] });
  // formato antigo (tópicos) ainda vira frase + palavras-chave
  assert.deepStrictEqual(parseAnswer('PT: Por que esta empresa?\n- Global clients\n- Growth'), { questionPt: 'Por que esta empresa?', say: 'Global clients', keys: ['Growth'] });
});

test('o prompt pede uma frase de até 8 palavras, 2 ou 3 palavras-chave e SAME para pergunta repetida', () => {
  const sys = buildSystemPrompt('x');
  assert.match(sys, /SAY: .*MAX 8 WORDS/);
  assert.match(sys, /KEYS: /);
  assert.match(sys, /2 or 3 keywords/);
  assert.match(sys, /exactly: SAME/);
  assert.doesNotMatch(sys, /3 to 4 bullets/);
});

test('reconhece a mesma pergunta dita de outro jeito, sem confundir perguntas diferentes', () => {
  assert.ok(similarity('Are you okay working as a contractor with exclusivity?', 'Sorry, so are you fine working as a contractor, with exclusivity?') >= 0.75);
  assert.ok(similarity('Are you okay working as a contractor with exclusivity?', 'Do you have an MEI company?') < 0.3);
  const cards = [
    { id: 'a', original: 'Are you okay working as a contractor with exclusivity?', say: 'Yes, contractor is fine.' },
    { id: 'b', original: 'How many years of experience do you have with React and TypeScript?', say: 'Four years.' },
  ];
  assert.strictEqual(findRepeat('So, are you fine working as a contractor with exclusivity?', cards)?.id, 'a');
  assert.strictEqual(findRepeat('How many years do you have with React and TypeScript, sorry?', cards)?.id, 'b');
  assert.strictEqual(findRepeat('How many years of experience do you have with Node and AWS?', cards), null);
  assert.strictEqual(findRepeat('Tell me about your hardest project', [{ id: 'c', original: 'Tell me about your last project', say: 'x' }]), null);
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
  const { svc, events, sent } = fakeService(['So tell me about', 'a hard bug you fixed.'], ['PT: Fale de um bug difícil\nSAY: IIS server at full CPU.\nKEYS: Logs · Fixed']);
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: false });
  svc.addAudio(new Uint8Array([2]), { turnEnd: false });
  await settle();
  svc.turnEnd();
  await settle();
  assert.match(sent[0], /<latest_interviewer_speech>\nSo tell me about a hard bug you fixed\.\n/);
  const done = cardsOf(events).find((c) => c.state === 'done');
  assert.strictEqual(done.questionPt, 'Fale de um bug difícil');
  assert.strictEqual(done.say, 'IIS server at full CPU.');
  assert.deepStrictEqual(done.keys, ['Logs', 'Fixed']);
  assert.match(fs.readFileSync(svc.logFile, 'utf8'), /> \*\*Diga:\*\* IIS server at full CPU\.\n> _Logs · Fixed_/);
  assert.ok(Number.isFinite(done.ms));
  assert.strictEqual(svc.pending, '');
  svc.stop();
});

test('continuação logo depois de uma pausa curta atualiza o mesmo cartão', async () => {
  const { svc, events, sent } = fakeService(['Tell me about a project', 'that you are proud of.'], ['PT: Fale de um projeto\nSAY: A', 'PT: Fale de um projeto do qual se orgulha\nSAY: B']);
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
  assert.strictEqual(svc.cards[0].say, 'B');
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
  const { svc, sent } = fakeService(['Tell me about yourself please.', 'And why React?'], ['PT: Fale de você\nSAY: Dev at Zema\nKEYS: React', 'PT: Por que React?\nSAY: Typed UI']);
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
  assert.match(sent[1], /<earlier_in_this_interview>[\s\S]*Q: Tell me about yourself please\.\nSuggested: Dev at Zema \(React\)/);
  assert.match(fs.readFileSync(log, 'utf8'), /_Retomada às/);
  svc.newInterview();
  assert.strictEqual(svc.lines.length, 0);
  await svc.start();
  assert.notStrictEqual(svc.cards.length, 1);
  svc.stop();
});

test('a sua fala (microfone) vai para a transcrição como "Eu", nunca vira pergunta e entra no histórico do Claude', async () => {
  const { svc, sent } = fakeService(
    ['Tell me about your last project.', 'I built a React dashboard with TypeScript at Triforce.', 'Tell me about your last project.', 'Why did you choose React for it?'],
    ['PT: Fale do último projeto\nSAY: Dashboard', 'PT: Por que React?\nSAY: Typed UI'],
  );
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true });
  await settle();
  svc.addAudio(new Uint8Array([2]), { turnEnd: true, speaker: 'me', startedAt: Date.now() + 5000 });
  await settle();
  assert.strictEqual(sent.length, 1); // a sua fala não chama a IA
  svc.addAudio(new Uint8Array([3]), { speaker: 'me' }); // eco da outra pessoa no alto-falante
  await settle();
  svc.addAudio(new Uint8Array([4]), { turnEnd: true, startedAt: Date.now() + 10_000 });
  await settle();
  assert.deepStrictEqual(svc.lines.map((l) => l.speaker), ['them', 'me', 'them']);
  assert.match(sent[1], /Interviewer: Tell me about your last project\.\nCandidate: I built a React dashboard/);
  const log = fs.readFileSync(svc.logFile, 'utf8');
  assert.match(log, /`\d{2}:\d{2}:\d{2}` \*\*Entrevistador:\*\* Tell me about your last project\./);
  assert.match(log, /`\d{2}:\d{2}:\d{2}` \*\*Eu:\*\* I built a React dashboard with TypeScript at Triforce\./);
  assert.strictEqual((log.match(/\*\*Eu:\*\*/g) || []).length, 1);
  svc.stop();
});

test('eco: fala do microfone repetindo quem entrevista é descartada', () => {
  assert.strictEqual(isEcho('Tell me about your last project', ['So, tell me about your last project.']), true);
  assert.strictEqual(isEcho('My last project was a React dashboard', ['Tell me about your last project.']), false);
});

test('depois que você responde, a fala seguinte de quem entrevista é pergunta nova (não continuação)', async () => {
  const { svc, events, sent } = fakeService(
    ['What is your experience with React?', 'Yes, I use it daily.', 'And what about testing frameworks?'],
    ['PT: Experiência com React?\nSAY: Daily', 'PT: E testes?\nSAY: Jest'],
  );
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true, startedAt: Date.now() });
  await settle();
  svc.addAudio(new Uint8Array([2]), { speaker: 'me', startedAt: Date.now() });
  svc.addAudio(new Uint8Array([3]), { turnEnd: true, startedAt: Date.now() + 500 });
  await settle();
  assert.doesNotMatch(sent[1], /continuation="true"/);
  const ids = new Set(cardsOf(events).filter((c) => c.state === 'done').map((c) => c.id));
  assert.strictEqual(ids.size, 2);
  svc.stop();
});

test('pergunta repetida quase igual não chama o Claude nem cria cartão: o cartão antigo volta ao topo', async () => {
  const { svc, events, sent } = fakeService(
    ['Are you okay working as a contractor with exclusivity?', 'Sorry, I did not get it.', 'So, are you fine working as a contractor with exclusivity?'],
    ['PT: Topa ser contractor com exclusividade?\nSAY: Yes, contractor is fine for me.\nKEYS: MEI · exclusivity'],
  );
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true, startedAt: Date.now() });
  await settle();
  svc.addAudio(new Uint8Array([2]), { speaker: 'me', startedAt: Date.now() + 1000 });
  svc.addAudio(new Uint8Array([3]), { turnEnd: true, startedAt: Date.now() + 2000 });
  await settle();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(svc.cards.length, 1);
  const shown = cardsOf(events);
  assert.strictEqual(new Set(shown.map((c) => c.id)).size, 1);
  assert.ok(Number.isFinite(shown.at(-1).repeatedAt));
  assert.match(fs.readFileSync(svc.logFile, 'utf8'), /Pergunta repetida/);
  svc.stop();
});

test('quando o Claude responde SAME, o cartão novo some e o antigo volta', async () => {
  const { svc, events, sent } = fakeService(
    ['How long have you been working with React?', 'Yes.', 'For how many years have you used React?', 'Okay and what about testing frameworks?'],
    ['PT: Há quanto tempo usa React?\nSAY: Four years with React.\nKEYS: Zema', 'SAME', 'PT: E testes?\nSAY: Jest and Testing Library.'],
  );
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true, startedAt: Date.now() });
  await settle();
  svc.addAudio(new Uint8Array([2]), { speaker: 'me', startedAt: Date.now() + 1000 });
  svc.addAudio(new Uint8Array([3]), { turnEnd: true, startedAt: Date.now() + 2000 });
  await settle();
  assert.strictEqual(sent.length, 2);
  const first = svc.cards[0];
  assert.strictEqual(svc.cards.length, 1);
  const shown = cardsOf(events);
  const secondId = shown.find((c) => c.id !== first.id).id;
  assert.strictEqual(shown.filter((c) => c.id === secondId).at(-1).state, 'dismissed');
  assert.strictEqual(shown.at(-1).id, first.id);
  assert.ok(shown.at(-1).repeatedAt);
  // pergunta nova de verdade continua virando cartão novo
  svc.addAudio(new Uint8Array([4]), { turnEnd: true, startedAt: Date.now() + 10_000 });
  await settle();
  assert.strictEqual(svc.cards.length, 2);
  assert.strictEqual(svc.cards.at(-1).say, 'Jest and Testing Library.');
  svc.stop();
});

test('com captureMic desligado, o áudio do microfone é ignorado', async () => {
  const { svc } = fakeService(['I built it']);
  svc.getConfig = () => ({ outputDir: svc.dir, claude: { bin: 'claude' }, interview: { captureMic: false } });
  await svc.start();
  svc.addAudio(new Uint8Array([1]), { speaker: 'me' });
  await settle();
  assert.strictEqual(svc.lines.length, 0);
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
