// Velocidade da Ohara-AI: conversa simples numa chamada só, aparecendo ao vivo; revisão só quando há risco;
// modelo mantido carregado (keep_alive) e pré-aquecido.
const test = require('node:test');
const assert = require('node:assert');
const { chatLocal, needsReview, liveGate, warmLocal } = require('../src/core/local-chat');
const { DEFAULT_CONFIG } = require('../src/core/config');

// Ollama falso: cada chamada a /api/chat devolve a próxima resposta da fila (em pedaços, como o streaming).
let calls = [];
let queue = [];
const realFetch = global.fetch;
function mockOllama(...answers) {
  calls = [];
  queue = [...answers];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const content = queue.shift() ?? '';
    if (body.stream === false) return new Response(JSON.stringify({ message: { content }, prompt_eval_count: 1, eval_count: 1 }));
    const pieces = content.match(/[\s\S]{1,4}/g) || [''];
    const lines = pieces.map((p) => JSON.stringify({ message: { content: p } })).concat(JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }));
    return new Response(lines.join('\n') + '\n');
  };
}
test.afterEach(() => {
  global.fetch = realFetch;
});
const config = () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.ollama.memoryFile = 'C:/nao/existe/MEMORY.md';
  return c;
};

test('pergunta simples: uma chamada só, sem ferramentas nem revisão, e o texto aparece enquanto é escrito', async () => {
  mockOllama('O arábica é mais suave; o robusta tem mais cafeína.');
  const deltas = [];
  const steps = [];
  const r = await chatLocal({ config: config(), history: [], text: 'qual a diferença entre café arábica e robusta?', onDelta: (t) => deltas.push(t), onStep: (s) => steps.push(s) });
  assert.equal(calls.length, 1, 'só o rascunho');
  assert.equal(calls[0].tools, undefined, 'sem as definições das ferramentas do PC');
  assert.equal(calls[0].stream, true);
  assert.equal(calls[0].keep_alive, '30m', 'mantém o modelo carregado');
  assert.ok(deltas.length > 1, 'chegou em pedaços, ao vivo');
  assert.equal(deltas.join(''), r.text);
  assert.deepEqual(steps, []);
});

test('pedido de opinião passa pela revisão; o texto final é o revisado', async () => {
  mockOllama('Depende do seu gosto.', JSON.stringify({ problemas: ['em cima do muro'], resposta: 'Arábica: é mais suave.', melhoria: false, consultar: false }));
  const deltas = [];
  const r = await chatLocal({ config: config(), history: [], text: 'qual o melhor café, arábica ou robusta?', onDelta: (t) => deltas.push(t), onStep: () => {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].format, 'json');
  assert.equal(r.text, 'Arábica: é mais suave.');
  assert.equal(deltas.join(''), 'Depende do seu gosto.', 'o rascunho apareceu ao vivo e não foi repetido; a tela troca pelo final');
});

test('pergunta do PC usa as ferramentas e sempre revisa (números)', async () => {
  mockOllama('Você tem 441 GB livres.', JSON.stringify({ problemas: [], resposta: 'Você tem 441 GB livres no C:.', melhoria: false, consultar: false }));
  const r = await chatLocal({ config: config(), history: [], text: 'quanto espaço livre eu tenho no disco?', onDelta: () => {}, onStep: () => {} });
  assert.ok(calls[0].tools, 'ofereceu as ferramentas');
  assert.equal(calls.length, 2);
  assert.match(r.text, /441 GB/);
});

test('marcação de consulta ao Claude nunca aparece na tela', async () => {
  mockOllama('[[consultar_claude: detalhe técnico]]');
  const deltas = [];
  const r = await chatLocal({ config: config(), history: [], text: 'como funciona o QUIC?', onDelta: (t) => deltas.push(t), onStep: () => {} });
  assert.equal(r.consult, 'detalhe técnico');
  assert.deepEqual(deltas, []);
});

test('review: true revisa sempre; review: false nunca', async () => {
  const c = config();
  c.ollama.review = true;
  mockOllama('Oi!', JSON.stringify({ problemas: [], resposta: 'Oi!', melhoria: false, consultar: false }));
  await chatLocal({ config: c, history: [], text: 'oi', onDelta: () => {}, onStep: () => {} });
  assert.equal(calls.length, 2);
  c.ollama.review = false;
  mockOllama('Acho que o melhor é o arábica.');
  await chatLocal({ config: c, history: [], text: 'qual o melhor café?', onDelta: () => {}, onStep: () => {} });
  assert.equal(calls.length, 1);
});

test('quando revisar: dados do PC, promessa, opinião, fato pessoal, "não sei", melhoria ou resposta longa', () => {
  assert.equal(needsReview({ text: 'qual a capital da França?', draft: 'Paris.' }), false);
  assert.equal(needsReview({ text: 'oi', draft: 'Oi! Tudo certo por aqui.' }), false);
  assert.equal(needsReview({ text: 'quanto de RAM?', draft: '16 GB', used: [{ name: 'sistema' }] }), true);
  assert.equal(needsReview({ text: 'apaga meus temporários', draft: 'Vou apagar agora.' }), true);
  assert.equal(needsReview({ text: 'vale a pena comprar um SSD?', draft: 'Sim.' }), true);
  assert.equal(needsReview({ text: 'qual o nome do meu cachorro?', draft: 'Rex.' }), true);
  assert.equal(needsReview({ text: 'quem ganhou o jogo ontem?', draft: 'Não sei dizer.' }), true);
  assert.equal(needsReview({ text: 'x', draft: 'Falta isso. [[melhoria: integrar o Spotify]]' }), true);
  assert.equal(needsReview({ text: 'explica', draft: 'a'.repeat(1300) }), true);
});

test('liveGate: repassa ao vivo, segura um "[" solto e corta na marcação "[["', () => {
  const out = [];
  const g = liveGate((t) => out.push(t));
  for (const p of ['Ol', 'á [', 'x] fim']) g.push(p);
  g.flush();
  assert.equal(out.join(''), 'Olá [x] fim');
  const out2 = [];
  const g2 = liveGate((t) => out2.push(t));
  for (const p of ['Falta a integração. [', '[melhoria: spotify]]']) g2.push(p);
  g2.flush();
  assert.equal(out2.join(''), 'Falta a integração. ');
  assert.ok(g2.sent);
});

test('pré-aquecimento carrega o modelo sem gerar nada, com a mesma janela de contexto do chat', async () => {
  mockOllama('');
  assert.equal(await warmLocal(config()), true);
  assert.deepEqual(calls[0].messages, []);
  assert.equal(calls[0].keep_alive, '30m');
  assert.equal(calls[0].options.num_ctx, DEFAULT_CONFIG.ollama.contextTokens);
  const off = config();
  off.ollama.enabled = false;
  calls = [];
  assert.equal(await warmLocal(off), false);
  assert.equal(calls.length, 0);
});

test('ferramentas do PC só quando a pergunta é sobre o PC dele ("melhor navegador para programar" é conversa)', () => {
  const { pcToolsFor } = require('../src/core/local-chat');
  assert.equal(pcToolsFor('qual o melhor navegador para programar?'), null);
  assert.equal(pcToolsFor('qual programa é melhor pra editar video?'), null);
  assert.equal(pcToolsFor('qual a capital da França?'), null);
  assert.deepEqual(pcToolsFor('quais navegadores eu tenho?').map((p) => p.name), ['navegadores']);
  assert.deepEqual(pcToolsFor('quanto espaço livre eu tenho no disco?').map((p) => p.name), ['armazenamento']);
  assert.deepEqual(pcToolsFor('o que está pesando no PC?').map((p) => p.name), ['processos']);
  assert.ok(Array.isArray(pcToolsFor('quais programas estão instalados?')));
});
