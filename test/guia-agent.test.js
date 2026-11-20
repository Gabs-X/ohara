const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuideAgent, systemPrompt } = require('../src/guia/agent');
const { Planner, normalizePlan, extractJson, stepPrompt, stepCategory } = require('../src/guia/planner');
const { guiaDefaults } = require('../src/guia/config');
const { Checkpoints } = require('../src/core/checkpoints');
const { UsageTracker } = require('../src/core/usage');
const { JsonStore } = require('../src/core/store');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup({ available = ['claude', 'gemini', 'ollama'], run, withCheckpoints = false } = {}) {
  const dir = tmp('ohara-guia-');
  const config = guiaDefaults(dir);
  const chatsStore = new JsonStore(path.join(dir, 'chats.json'), { chats: [] });
  const usage = new UsageTracker(new JsonStore(path.join(dir, 'usage.json'), { days: {}, limits: { claude: null, codex: null } }));
  usage.codexOn = () => available.includes('codex');
  const events = [];
  const calls = [];
  const agent = new GuideAgent({
    chatsStore, usage, getConfig: () => config, getAvailable: () => new Set(available),
    emit: (ch, p) => events.push([ch, p]),
    checkpoints: withCheckpoints ? new Checkpoints({ dir: path.join(dir, 'pontos') }) : null,
    runProvider: async (id, o) => {
      calls.push({ id, o });
      return run ? run(id, o, calls.length) : { provider: id, model: o.model, text: `resposta de ${id}`, sessionId: `s-${id}`, tokens: { input: 100, output: 20 } };
    },
  });
  return { dir, config, agent, events, calls, usage };
}

test('pergunta simples vai para a IA local e conta no uso', async () => {
  const { agent, calls, usage } = setup();
  const chat = agent.create(null);
  const m = await agent.send(chat.id, { text: 'oi, tudo bem?' });
  assert.equal(calls[0].id, 'ollama');
  assert.equal(m.text, 'resposta de ollama');
  assert.equal(usage.callsToday('ollama'), 1);
  assert.ok(calls[0].o.systemPrompt.includes('NÃO é programador'));
});

test('IA com falha de cota passa para a reserva sem perder o pedido', async () => {
  const { agent, calls, events } = setup({
    run: (id, o) => (id === 'gemini'
      ? { provider: id, text: '', error: 'A cota grátis do Gemini acabou por hoje.', tokens: {} }
      : { provider: id, model: o.model, text: 'feito', sessionId: 'x', tokens: {} }),
  });
  const proj = tmp('ohara-p-');
  const chat = agent.create(proj);
  const m = await agent.send(chat.id, { text: 'corrige o bug na função de login' });
  assert.deepEqual(calls.map((c) => c.id), ['gemini', 'claude']);
  assert.equal(m.provider, 'claude');
  assert.equal(m.text, 'feito');
  assert.ok(m.switched[0].includes('Gemini'));
  assert.ok(events.some(([ch, p]) => ch === 'chat:event' && /tentando/.test(p.text)));
});

test('erro que não é de cota não troca de IA', async () => {
  const { agent, calls } = setup({ run: (id) => ({ provider: id, text: '', error: 'sintaxe inválida no pedido', tokens: {} }) });
  const chat = agent.create(tmp('ohara-p-'));
  const m = await agent.send(chat.id, { text: 'corrige o bug na função de login' });
  assert.equal(calls.length, 1);
  assert.equal(m.error, 'sintaxe inválida no pedido');
});

test('contexto vai junto quando a conversa troca de IA', async () => {
  const { agent, calls } = setup();
  const chat = agent.create(tmp('ohara-p-'));
  await agent.send(chat.id, { text: 'oi, tudo bem?' }); // IA local
  await agent.send(chat.id, { text: 'corrige o bug na função de login' }); // Gemini
  const second = calls[1];
  assert.equal(second.id, 'gemini');
  assert.match(second.o.prompt, /Contexto anterior[\s\S]*oi, tudo bem\?/);
  await agent.send(chat.id, { text: 'agora implementa o teste da função de login' });
  assert.equal(calls[2].o.sessionId, 's-gemini', 'continua a sessão');
  assert.doesNotMatch(calls[2].o.prompt, /Contexto anterior/, 'não repete o que a IA já viu');
});

test('sem IA disponível, a resposta explica o que fazer', async () => {
  const { agent } = setup({ available: [] });
  const chat = agent.create(null);
  const m = await agent.send(chat.id, { text: 'oi' });
  assert.match(m.error, /Primeiros passos/);
});

test('acesso total libera as travas de cada IA', async () => {
  const { agent, calls } = setup();
  const chat = agent.create(tmp('ohara-p-'));
  await agent.send(chat.id, { text: 'corrige o bug na função de login', fullAccess: true });
  assert.equal(calls[0].o.permissionMode, 'bypassPermissions');
  assert.equal(calls[0].o.approvalMode, 'yolo');
});

test('cota do Gemini é estimada pelos pedidos do dia', () => {
  const { agent, usage } = setup();
  for (let i = 0; i < 10; i++) usage.record('gemini', 'flash', { input: 1 });
  const l = agent.limits();
  assert.equal(l.gemini.calls, 10);
  assert.equal(l.gemini.daily, 10 / 1000);
});

test('desfazer volta os arquivos que a IA mexeu e refazer traz de volta', async () => {
  const proj = tmp('ohara-p-');
  fs.writeFileSync(path.join(proj, 'index.html'), '<h1>antes</h1>');
  const { agent } = setup({
    withCheckpoints: true,
    run: (id, o) => {
      fs.writeFileSync(path.join(o.cwd, 'index.html'), '<h1>depois</h1>');
      fs.writeFileSync(path.join(o.cwd, 'novo.css'), 'body{}');
      return { provider: id, model: o.model, text: 'mudei', tokens: {} };
    },
  });
  const chat = agent.create(proj);
  const m = await agent.send(chat.id, { text: 'muda o título da página do site' });
  assert.equal(m.checkpoint.count, 2);
  await agent.undo(chat.id, m.id);
  assert.equal(fs.readFileSync(path.join(proj, 'index.html'), 'utf8'), '<h1>antes</h1>');
  assert.ok(!fs.existsSync(path.join(proj, 'novo.css')));
  await assert.rejects(agent.undo(chat.id, m.id), /Já foi desfeito/);
  await agent.redo(chat.id, m.id);
  assert.equal(fs.readFileSync(path.join(proj, 'index.html'), 'utf8'), '<h1>depois</h1>');
  assert.ok(fs.existsSync(path.join(proj, 'novo.css')));
});

test('o prompt de sistema usa o nome e a pasta', () => {
  const p = systemPrompt({ userName: 'Carlos' }, 'C:\\proj');
  assert.match(p, /assistente de IA de Carlos/);
  assert.match(p, /Trabalhe SÓ dentro dela/);
  assert.match(p, /O que eu fiz/);
});

// ---------- Planejador ----------
const PLAN = {
  titulo: 'Site do escritório', objetivo: 'Ter um site simples', resumo: 'Um site de uma página.',
  etapas: [
    { titulo: 'Definir o conteúdo', descricao: 'Textos', tipo: 'texto', tamanho: 'pequena', criterio: 'texto aprovado' },
    { titulo: 'Montar a página', descricao: 'HTML', tipo: 'codigo', tamanho: 'grande', criterio: 'abre no navegador' },
    { titulo: 'X', descricao: 'Y', tipo: 'inventado', tamanho: 'enorme' },
  ],
  riscos: ['textos longos'], perguntas: ['tem logo?'],
};

test('planejador: acha o JSON na resposta e normaliza', () => {
  assert.deepEqual(extractJson(`Claro!\n\`\`\`json\n${JSON.stringify({ a: 1 })}\n\`\`\``), { a: 1 });
  assert.deepEqual(extractJson(`texto {"a":2} fim`), { a: 2 });
  const p = normalizePlan(PLAN);
  assert.equal(p.steps.length, 3);
  assert.equal(p.steps[2].type, 'tarefa');
  assert.equal(p.steps[2].size, 'media');
  assert.throws(() => normalizePlan({ etapas: [] }), /sem etapas/);
});

test('planejador: etapa vira o tipo certo de pedido (planeja no forte, executa no barato)', () => {
  const p = normalizePlan(PLAN);
  assert.equal(stepCategory(p.steps[0]), 'escrita');
  assert.equal(stepCategory(p.steps[1]), 'codigo_complexo');
  const prompt = stepPrompt(p, p.steps[1]);
  assert.match(prompt, /etapa 2 de 3/);
  assert.match(prompt, /abre no navegador/);
});

test('planejador: cria, marca etapa e revisa mantendo o que foi feito', async () => {
  const dir = tmp('ohara-plan-');
  const asked = [];
  const planner = new Planner({
    store: new JsonStore(path.join(dir, 'plans.json'), { plans: [] }),
    ask: async (o) => {
      asked.push(o);
      return { provider: 'claude', model: 'opus', text: JSON.stringify(asked.length === 1 ? PLAN : { ...PLAN, etapas: [{ titulo: 'Publicar', descricao: 'no ar', tipo: 'tarefa', tamanho: 'media' }] }) };
    },
  });
  const plan = await planner.create({ idea: 'quero um site', cwd: null });
  assert.equal(asked[0].category, 'planejamento');
  assert.equal(plan.madeBy, 'opus');
  planner.setStep(plan.id, plan.steps[0].id, { status: 'feito' });
  assert.equal(planner.list()[0].done, 1);
  const revised = await planner.revise(plan.id, 'acrescenta a publicação');
  assert.deepEqual(revised.steps.map((s) => s.title), ['Definir o conteúdo', 'Publicar']);
  assert.match(asked[1].prompt, /\[feito\] Definir o conteúdo/);
  await assert.rejects(planner.create({ idea: '  ' }), /Descreva/);
});
