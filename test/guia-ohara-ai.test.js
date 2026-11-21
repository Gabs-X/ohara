// Ohara Guia com a Ohara-AI: pedidos sobre o PC ficam no modelo local com as ferramentas (o arriscado espera o
// "Confirmar"); se ela não souber, o pedido segue para as outras IAs. E o download do modelo pelo app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuideAgent } = require('../src/guia/agent');
const { guiaDefaults } = require('../src/guia/config');
const { UsageTracker } = require('../src/core/usage');
const { JsonStore } = require('../src/core/store');
const pull = require('../src/core/ollama-pull');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const FECHAR = { name: 'fechar_programa', args: { nome: 'chrome' }, resumo: 'Fechar chrome' };

function setup({ available = ['claude', 'ollama'], local } = {}) {
  const dir = tmp('ohara-guia-ai-');
  const config = guiaDefaults(dir);
  config.userName = 'Marina';
  const chatsStore = new JsonStore(path.join(dir, 'chats.json'), { chats: [] });
  const usage = new UsageTracker(new JsonStore(path.join(dir, 'usage.json'), { days: {}, limits: { claude: null, codex: null } }));
  const cloud = [];
  const localCalls = [];
  const ran = [];
  const agent = new GuideAgent({
    chatsStore, usage, getConfig: () => config, getAvailable: () => new Set(available), emit: () => {},
    runProvider: async (id, o) => {
      cloud.push(id);
      return { provider: id, model: o.model, text: `resposta de ${id}`, tokens: {} };
    },
    localChat: async (o) => {
      localCalls.push(o);
      return local ? local(o) : { text: 'Pronto, aumentei o volume em 10%.', tokens: {}, pending: [], done: [{ name: 'volume' }] };
    },
    actionCtx: {
      ps: async (s) => (ran.push(s), { encontrados: 1, ainda_abertos: 0 }),
      exec: async (f, a) => ran.push([f, ...a].join(' ')),
      open: async () => {},
      schedule: (t, ms) => Date.now() + ms,
    },
  });
  return { agent, cloud, localCalls, ran, config };
}

test('pedido de ação no PC fica com a Ohara-AI, no modelo local, com o nome da pessoa e sem o Orca', async () => {
  const { agent, cloud, localCalls } = setup();
  const chat = agent.create(null);
  const m = await agent.send(chat.id, { text: 'aumenta o volume' });
  assert.deepEqual(cloud, [], 'não foi para a nuvem');
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].config.edition, 'guia');
  assert.ok(localCalls[0].actionCtx);
  assert.equal(m.provider, 'ollama');
  assert.equal(m.model, 'Ohara-AI (local)');
  assert.match(m.text, /aumentei o volume/);
});

test('ação arriscada espera o Confirmar; "confirma" roda o que ficou guardado, sem IA', async () => {
  const { agent, ran, localCalls } = setup({ local: () => ({ text: 'Vou fechar o Chrome. Confirma?', tokens: {}, pending: [FECHAR] }) });
  const chat = agent.create(null);
  const asked = await agent.send(chat.id, { text: 'fecha o chrome' });
  assert.equal(asked.pcActions[0].status, 'pending');
  assert.equal(ran.length, 0);
  const done = await agent.send(chat.id, { text: 'confirma' });
  assert.equal(localCalls.length, 1, 'a confirmação não chamou o modelo');
  assert.match(done.text, /Pronto: fechei chrome/);
  assert.equal(asked.pcActions[0].status, 'done');
});

test('botão Cancelar descarta; botão Confirmar recusa item que não existe', async () => {
  const { agent, ran } = setup({ local: () => ({ text: 'Confirma?', tokens: {}, pending: [FECHAR] }) });
  const chat = agent.create(null);
  const asked = await agent.send(chat.id, { text: 'fecha o chrome' });
  assert.equal(agent.cancelPcAction(chat.id, asked.id, 0).status, 'cancelled');
  await assert.rejects(() => agent.confirmPcAction(chat.id, asked.id, 0), /não está mais esperando/);
  await assert.rejects(() => agent.confirmPcAction(chat.id, asked.id, 3), /não encontrada/);
  assert.equal(ran.length, 0);
});

test('a Ohara-AI não sabia: o pedido segue para as outras IAs, sem deixar rastro', async () => {
  const { agent, cloud } = setup({ local: () => ({ text: '', consult: 'não sei', tokens: {} }) });
  const chat = agent.create(null);
  const m = await agent.send(chat.id, { text: 'quanto espaço livre eu tenho no disco?' });
  assert.ok(cloud.length >= 1, 'foi para outra IA');
  assert.equal(chat.messages.length, 2, 'só a pergunta e a resposta da outra IA');
  assert.match(m.text, /resposta de/);
});

test('modelo local fora do ar antes de fazer qualquer coisa: segue para as outras IAs', async () => {
  const { agent, cloud } = setup({ local: () => { throw new Error('O modelo local não respondeu (ECONNREFUSED).'); } });
  const chat = agent.create(null);
  await agent.send(chat.id, { text: 'tira um print' });
  assert.ok(cloud.length >= 1);
});

test('sem a IA local pronta (ou desligada), nada muda: vai pelo roteador de sempre', async () => {
  const a = setup({ available: ['claude'] });
  await a.agent.send(a.agent.create(null).id, { text: 'aumenta o volume' });
  assert.equal(a.localCalls.length, 0);
  const b = setup();
  b.config.ollama.oharaAi = false;
  await b.agent.send(b.agent.create(null).id, { text: 'aumenta o volume' });
  assert.equal(b.localCalls.length, 0);
});

test('conversa comum e pedido de projeto não passam pela Ohara-AI', async () => {
  const { agent, localCalls } = setup();
  const chat = agent.create(null);
  await agent.send(chat.id, { text: 'me explica o que é uma API' });
  await agent.send(chat.id, { text: 'corrige o bug do login no projeto' });
  assert.equal(localCalls.length, 0);
});

test('recomendação do modelo pela memória do PC e da placa de vídeo', () => {
  assert.equal(pull.recommendModel({ ramGB: 32, vramGB: 16 }).id, 'qwen2.5:14b');
  assert.equal(pull.recommendModel({ ramGB: 16, vramGB: 8 }).id, 'qwen2.5:7b');
  assert.equal(pull.recommendModel({ ramGB: 16, vramGB: 0 }).id, 'qwen2.5:7b');
  assert.equal(pull.recommendModel({ ramGB: 8, vramGB: 0 }).id, 'qwen2.5:3b');
});

test('status: Ollama aberto, modelos instalados e se a Ohara-AI está pronta', async () => {
  const cfg = { ollama: { model: 'qwen2.5:7b' } };
  const st = await pull.oharaAiStatus(cfg, { hardware: async () => ({ ramGB: 16, vramGB: 8 }), list: async () => ['qwen2.5:7b', 'bge-m3:latest'] });
  assert.equal(st.ollama, true);
  assert.equal(st.ready, true);
  assert.equal(st.recommended.id, 'qwen2.5:7b');
  assert.deepEqual(st.models.filter((m) => m.installed).map((m) => m.id), ['qwen2.5:7b']);
  const off = await pull.oharaAiStatus(cfg, { hardware: async () => ({ ramGB: 16, vramGB: 0 }), list: async () => null });
  assert.equal(off.ollama, false);
  assert.equal(off.ready, false);
});

test('download: progresso em %, recusa modelo fora da lista e avisa quando não termina', async () => {
  const lines = [{ status: 'pulling manifest' }, { status: 'pulling abc', total: 1000, completed: 250 }, { status: 'pulling abc', total: 1000, completed: 1000 }, { status: 'success' }];
  const fetchImpl = async (url, opts) => {
    assert.match(url, /\/api\/pull$/);
    assert.equal(JSON.parse(opts.body).model, 'qwen2.5:7b');
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const seen = [];
  const r = await pull.pullModel({ ollama: {} }, 'qwen2.5:7b', { fetchImpl, onProgress: (p) => seen.push(p.percent) });
  assert.equal(r.model, 'qwen2.5:7b');
  assert.deepEqual(seen, [null, 25, 100, null]);
  await assert.rejects(() => pull.pullModel({ ollama: {} }, 'llama-malicioso', { fetchImpl }), /fora da lista/);
  const cut = async () => new Response(JSON.stringify({ status: 'pulling abc', total: 10, completed: 5 }) + '\n');
  await assert.rejects(() => pull.pullModel({ ollama: {} }, 'qwen2.5:3b', { fetchImpl: cut }), /não terminou/);
  const err = async () => new Response(JSON.stringify({ error: 'disk full' }) + '\n');
  await assert.rejects(() => pull.pullModel({ ollama: {} }, 'qwen2.5:3b', { fetchImpl: err }), /disk full/);
});
