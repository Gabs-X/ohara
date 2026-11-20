const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
// Pasta que existe de verdade: a Ohara troca pastas apagadas pela padrão.
const WORK = os.tmpdir();

// Modelo local e Orca falsos: cada chamada espera ser liberada pelo teste.
const localCalls = [];
const orcaCalls = [];
let orcaFail = null;
const stub = (rel, exports) => {
  const file = require.resolve(path.join('../src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('core/local-chat', {
  chatLocal: async (opts) => {
    const call = { opts };
    localCalls.push(call);
    if (opts.signal) opts.signal.addEventListener('abort', () => call.finish?.());
    await new Promise((resolve) => { call.finish = resolve; });
    if (opts.signal?.aborted) throw new Error('abortado');
    return { provider: 'ollama', model: 'qwen-teste', text: call.answer ?? `resposta: ${opts.text}`, tokens: {} };
  },
});
stub('integrations/orca', {
  sendToOrca: async (opts) => {
    orcaCalls.push(opts);
    if (orcaFail) throw new Error(orcaFail);
    const root = opts.cwd;
    return {
      state: { repoId: 'repo-1', worktree: 'repo-1::wt', branch: 'corrige-login', terminal: 'term_1' },
      branch: opts.state ? opts.state.branch : 'corrige-login',
      worktree: 'repo-1::wt',
      reused: !!opts.state,
      root,
      kind: 'git',
      startedOrca: false,
    };
  },
});

const { Orchestrator } = require('../src/core/orchestrator');
const { DEFAULT_CONFIG } = require('../src/core/config');

function setup(extra = {}) {
  localCalls.length = 0;
  orcaCalls.length = 0;
  orcaFail = null;
  const events = [];
  const store = (data) => ({ data, save() {} });
  const usage = { updateClaudeLimits() {}, summary: () => ({}), record() {}, refreshCodexLimits() {}, limits: () => ({}), current: () => ({}) };
  const o = new Orchestrator({
    chatsStore: store({ chats: [] }),
    prefsStore: store({ overrides: [] }),
    usage,
    getConfig: () => structuredClone(DEFAULT_CONFIG),
    emit: (ch, p) => events.push([ch, p]),
    ...extra,
  });
  return { o, events };
}
// Pedido que vai para o Claude: a Ohara pergunta a conta primeiro; aqui já respondemos "pessoal".
async function sendOrca(o, chatId, text, runId, account = 'pessoal') {
  const q = await o.send(chatId, { text, runId: `${runId}-q` });
  assert.match(q.text, /ImLaw/, 'perguntou qual Claude antes de abrir o Orca');
  return o.send(chatId, { text: account, runId });
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('conversa comum vai para o modelo local, sem Claude e sem Orca', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'qual a capital da França?', runId: 'r1' });
  await tick();
  assert.equal(localCalls.length, 1);
  localCalls[0].answer = 'Paris.';
  localCalls[0].finish();
  const msg = await p;
  assert.equal(msg.provider, 'ollama');
  assert.equal(msg.text, 'Paris.');
  assert.equal(orcaCalls.length, 0);
});

test('o modelo local recebe o histórico da conversa (a memória é o app que manda)', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'meu gato se chama Pipoca', runId: 'h1' });
  await tick();
  localCalls[0].finish();
  await p1;
  const p2 = o.send(chat.id, { text: 'como ele se chama?', runId: 'h2' });
  await tick();
  assert.deepEqual(localCalls[1].opts.history.map((m) => m.role), ['user', 'assistant']);
  assert.match(localCalls[1].opts.history[0].text, /Pipoca/);
  localCalls[1].finish();
  await p2;
});

test('pedido de alterar código abre o Orca no projeto, com o contexto, e não chama o modelo local', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const msg = await sendOrca(o, chat.id, 'corrige o bug do login na ohara', 'c1');
  assert.equal(localCalls.length, 0);
  assert.equal(orcaCalls.length, 1);
  assert.equal(msg.provider, 'orca');
  assert.match(orcaCalls[0].prompt, /Pedido do Gabriel:\ncorrige o bug do login na ohara/);
  assert.match(orcaCalls[0].prompt, /sem linha de coautoria/);
  assert.equal(orcaCalls[0].request, 'corrige o bug do login na ohara');
  assert.match(msg.text, /Orca/);
  assert.match(msg.text, /`corrige-login`/);
  assert.equal(msg.orca.branch, 'corrige-login');
});

test('o projeto citado vira a pasta do Orca', async () => {
  const { o } = setup({});
  o.projCache = { root: DEFAULT_CONFIG.workspaceRoot, at: Date.now(), list: [{ name: 'ohara', path: WORK }] };
  const chat = o.create(DEFAULT_CONFIG.defaultCwd);
  await sendOrca(o, chat.id, 'implementa um botão novo na ohara', 'p1');
  assert.equal(orcaCalls[0].cwd, WORK);
});

test('pergunta sobre código, sem pedir ação, é conversa e fica no modelo local', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'o que é uma api rest?', runId: 'q1' });
  await tick();
  assert.equal(orcaCalls.length, 0);
  assert.equal(localCalls.length, 1);
  localCalls[0].finish();
  await p;
});

test('segundo pedido na mesma conversa e projeto continua no mesmo console do Claude', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  await sendOrca(o, chat.id, 'corrige o bug do login na ohara', 'k1');
  assert.equal(orcaCalls[0].state, null, 'primeiro pedido: sem estado anterior');
  const second = await o.send(chat.id, { text: 'agora ajusta também a tela de ajustes da ohara', runId: 'k2' });
  assert.equal(orcaCalls.length, 2);
  assert.equal(orcaCalls[1].state.terminal, 'term_1');
  assert.equal(orcaCalls[1].prompt, 'agora ajusta também a tela de ajustes da ohara', 'continuação manda só o pedido novo');
  assert.match(second.text, /já está trabalhando/);
});

test('falha ao abrir o Orca aparece como erro da resposta, sem travar a conversa', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  orcaFail = 'o Orca não ficou pronto a tempo';
  const msg = await sendOrca(o, chat.id, 'corrige o bug do login na ohara', 'e1');
  assert.match(msg.error, /Orca não ficou pronto/);
  assert.equal(o.isRunning(chat.id), false);
});

test('ação local responde sem chamar modelo nem Orca', async () => {
  const opened = [];
  const { o } = setup({ openExternal: async (u) => opened.push(u) });
  const chat = o.create(WORK);
  const msg = await o.send(chat.id, { text: 'pesquisa no Google receita de bolo', runId: 'g1' });
  assert.equal(localCalls.length + orcaCalls.length, 0);
  assert.equal(msg.provider, 'local');
  assert.deepEqual(opened, ['https://www.google.com/search?q=receita%20de%20bolo']);
});

test('oferece se alterar e, com o "sim", o Claude implementa no repositório da Ohara pelo Orca', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'lê esse PDF pra mim', runId: 'm1' });
  await tick();
  assert.match(localCalls[0].opts.config.selfRepo, /ohara/);
  localCalls[0].answer = 'Ainda não consigo ler PDF. Quer que eu me altere para aprender?\n[[melhoria: ler arquivos PDF anexados]]';
  localCalls[0].finish();
  const offer = await p1;
  assert.equal(offer.text, 'Ainda não consigo ler PDF. Quer que eu me altere para aprender?', 'a marcação some do texto');
  assert.equal(offer.improvementOffer, 'ler arquivos PDF anexados');

  const asked = await o.send(chat.id, { text: 'sim, pode fazer', runId: 'm2' });
  assert.match(asked.text, /ImLaw/);
  const accepted = await o.send(chat.id, { text: 'pessoal', runId: 'm3' });
  assert.equal(accepted.provider, 'orca');
  assert.equal(orcaCalls[0].cwd, DEFAULT_CONFIG.selfRepo);
  assert.match(orcaCalls[0].prompt, /aceitou que você se altere para conseguir: ler arquivos PDF anexados/);
  assert.match(orcaCalls[0].prompt, /Pedido original dele: ”lê esse PDF pra mim”/, 'aspas duplas viram tipográficas para passar pelo Orca');
});

test('a oferta vale só para a resposta seguinte', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'manda um fax', runId: 'f1' });
  await tick();
  localCalls[0].answer = 'Não tenho fax.\n[[melhoria: enviar fax]]';
  localCalls[0].finish();
  await p1;
  const p2 = o.send(chat.id, { text: 'deixa, me fala uma curiosidade', runId: 'f2' });
  await tick();
  localCalls[1].finish();
  await p2;
  const p3 = o.send(chat.id, { text: 'sim', runId: 'f3' });
  await tick();
  assert.equal(orcaCalls.length, 0, '"sim" atrasado não dispara a automelhoria');
  localCalls[2].finish();
  await p3;
});

test('pedido de navegador abre o Chrome antes e o prompt do Claude ensina a reconectar a extensão', async () => {
  const opened = [];
  const { o } = setup({ ensureChrome: async () => { opened.push(1); return { running: true, started: true }; } });
  const chat = o.create(WORK);
  const msg = await sendOrca(o, chat.id, 'preenche o projeto no meu perfil do LinkedIn', 'chrome');
  assert.equal(opened.length, 1, 'abriu o Chrome antes do Orca');
  assert.equal(msg.provider, 'orca');
  assert.match(orcaCalls[0].prompt, /Claude in Chrome/);
  assert.ok(msg.tools.some((t) => /Chrome: aberto/.test(t)));
});

test('pedido sem navegador não abre o Chrome', async () => {
  const opened = [];
  const { o } = setup({ ensureChrome: async () => { opened.push(1); return { running: true }; } });
  const chat = o.create(WORK);
  await sendOrca(o, chat.id, 'implementa o botão de salvar na ohara', 'nochrome');
  assert.equal(opened.length, 0);
});

test('cancelar sem runId interrompe as respostas em andamento', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'conta uma história bem longa', runId: 'a' });
  await tick();
  o.cancel(chat.id);
  const msg = await p;
  assert.equal(msg.error, 'Cancelado.');
  assert.equal(o.isRunning(chat.id), false);
});

test('a pré-visualização da rota mostra o destino (local ou Orca)', () => {
  const { o } = setup();
  assert.equal(o.preview('bom dia', {}).provider, 'ollama');
  assert.equal(o.preview('corrige o bug do login no repositório', {}).provider, 'orca');
});

test('antes de abrir o Claude no Orca, pergunta se é o do escritório (ImLaw) ou o pessoal', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const q = await o.send(chat.id, { text: 'corrige o bug do login na ohara', runId: 'a1' });
  assert.equal(orcaCalls.length, 0, 'ainda não abriu nada');
  assert.match(q.text, /escritório \(ImLaw\)/);
  assert.match(q.text, /pessoal/);
  const msg = await o.send(chat.id, { text: 'é o do escritório', runId: 'a2' });
  assert.equal(orcaCalls.length, 1);
  assert.equal(orcaCalls[0].account, 'imlaw');
  assert.equal(orcaCalls[0].request, 'corrige o bug do login na ohara', 'usa o pedido guardado, não a resposta');
  assert.match(orcaCalls[0].prompt, /Pedido do Gabriel:\ncorrige o bug do login na ohara/);
  assert.equal(msg.provider, 'orca');
});

test('se o pedido já cita a conta, não pergunta; resposta que não é conta cancela a pergunta', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const msg = await o.send(chat.id, { text: 'corrige o bug do login na ohara com o claude pessoal', runId: 'b1' });
  assert.equal(orcaCalls[0].account, 'pessoal');
  assert.equal(msg.provider, 'orca');

  const { o: o2 } = setup();
  const c2 = o2.create(WORK);
  await o2.send(c2.id, { text: 'corrige o bug do login na ohara', runId: 'b2' });
  const p = o2.send(c2.id, { text: 'esquece, qual a capital da França?', runId: 'b3' });
  await tick();
  assert.equal(orcaCalls.length, 0);
  localCalls[0].finish();
  await p;
  const late = await o2.send(c2.id, { text: 'pessoal', runId: 'b4' }).catch((e) => e);
  assert.equal(orcaCalls.length, 0, 'a pergunta vale só para a resposta seguinte');
  void late;
});

test('continuar no console aberto não pergunta a conta de novo', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  await sendOrca(o, chat.id, 'corrige o bug do login na ohara', 'd1', 'imlaw');
  const again = await o.send(chat.id, { text: 'agora ajusta também a tela de ajustes da ohara', runId: 'd2' });
  assert.equal(orcaCalls.length, 2);
  assert.match(again.text, /já está trabalhando/);
});
