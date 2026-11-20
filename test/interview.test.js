const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InterviewService, cleanTranscript, worthAnalyzing, buildPrompt, parseAnswer } = require('../src/core/interview');

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

test('o prompt leva o contexto, o histórico e a fala mais recente', () => {
  const p = buildPrompt({ context: 'React and Node', history: ['Hi Gabriel'], latest: 'What is your biggest strength?' });
  assert.match(p, /<profile>\nReact and Node\n<\/profile>/);
  assert.match(p, /<recent_transcript>\nHi Gabriel\n/);
  assert.match(p, /<latest_interviewer_speech>\nWhat is your biggest strength\?\n/);
  assert.match(p, /exactly: NONE/);
});

test('lê a resposta completa, parcial e o NONE', () => {
  assert.deepStrictEqual(parseAnswer('NONE'), { none: true });
  assert.deepStrictEqual(parseAnswer('NO'), { pending: true });
  assert.deepStrictEqual(parseAnswer(''), { pending: true });
  const r = parseAnswer('PT: Fale sobre você\n- Full stack developer, 3 years\n- **React** and Node\n  at Eletrozema\n- Fast learner');
  assert.strictEqual(r.questionPt, 'Fale sobre você');
  assert.deepStrictEqual(r.bullets, ['Full stack developer, 3 years', 'React and Node at Eletrozema', 'Fast learner']);
  const partial = parseAnswer('PT: Por que esta empresa?\n- Global');
  assert.deepStrictEqual(partial.bullets, ['Global']);
});

function fakeService(transcripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-entrevista-teste-'));
  const events = [];
  const calls = [];
  const whisper = {
    status: () => ({ installed: true, modelName: 'small' }),
    transcribe: async (file, opts) => {
      calls.push(opts);
      return transcripts.shift() ?? '';
    },
  };
  const svc = new InterviewService({
    whisper,
    getConfig: () => ({ outputDir: dir, claude: { bin: 'claude-inexistente-para-teste' }, interview: {} }),
    emit: (ch, p) => events.push([ch, p]),
    dataDir: dir,
  });
  return { svc, events, calls, dir };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('transcreve em inglês com o modelo small e registra a fala no arquivo da entrevista', async () => {
  const { svc, events, calls } = fakeService(['Could you introduce yourself?']);
  svc.start();
  svc.addAudio(new Uint8Array([1, 2, 3]), { turnEnd: false });
  await settle();
  assert.deepStrictEqual(calls[0], { language: 'en', model: 'small' });
  assert.ok(events.some(([ch, p]) => ch === 'interview:line' && p.text === 'Could you introduce yourself?'));
  assert.match(fs.readFileSync(svc.logFile, 'utf8'), /\*\*Entrevistador:\*\* Could you introduce yourself\?/);
  assert.strictEqual(svc.pending, 'Could you introduce yourself?'); // sem pausa ainda: não analisa
  svc.stop();
});

test('fim de fala dispara a análise com tudo o que foi dito desde a última', async () => {
  const { svc, events } = fakeService(['So tell me about', 'a hard bug you fixed.']);
  svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: false });
  svc.addAudio(new Uint8Array([2]), { turnEnd: false });
  await settle();
  svc.turnEnd();
  await new Promise((r) => setTimeout(r, 400)); // o "claude" falso não existe: vira cartão de erro
  const card = events.filter(([ch]) => ch === 'interview:card').map(([, p]) => p)[0];
  assert.strictEqual(card.original, 'So tell me about a hard bug you fixed.');
  assert.strictEqual(svc.pending, '');
  svc.stop();
});

test('fala curta sem pergunta não gasta cota', async () => {
  const { svc, events } = fakeService(['Great.']);
  svc.start();
  svc.addAudio(new Uint8Array([1]), { turnEnd: true });
  await settle();
  assert.ok(!events.some(([ch]) => ch === 'interview:card'));
  svc.stop();
});

test('não começa sem o modelo do Whisper', () => {
  const { svc } = fakeService([]);
  svc.whisper.status = () => ({ installed: false });
  assert.throws(() => svc.start(), /Whisper/);
});

test('cria o contexto.md padrão na primeira vez', () => {
  const { svc } = fakeService([]);
  const file = svc.ensureContext();
  assert.match(fs.readFileSync(file, 'utf8'), /## Vaga/);
});
