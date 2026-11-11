const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
// Pasta que existe de verdade: a Ohara troca pastas apagadas pela padrão.
const WORK = os.tmpdir();

// IA falsa: cada chamada espera até ser liberada pelo teste.
const calls = [];
function fakeProvider(provider) {
  return async (opts) => {
    const call = { provider, opts };
    calls.push(call);
    await new Promise((resolve) => { call.finish = resolve; });
    return { provider, model: opts.model || 'fake', text: call.answer ?? `resposta: ${opts.prompt.split('\n').pop()}`, tokens: {}, sessionId: `sess-${calls.indexOf(call)}` };
  };
}
const stub = (rel, exports) => {
  const file = require.resolve(path.join('../src/core', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('providers/claude', { runClaude: fakeProvider('claude') });
stub('providers/codex', { runCodex: fakeProvider('codex') });

const { Orchestrator } = require('../src/core/orchestrator');
const { DEFAULT_CONFIG } = require('../src/core/config');

// confirmContacts: confirmação do contato antes de mandar (no app vem ligada; aqui o padrão dos testes é enviar na hora).
function setup({ confirmContacts = false, codexOff = false, ...extra } = {}) {
  calls.length = 0;
  const events = [];
  const store = (data) => ({ data, save() {} });
  const usage = { updateClaudeLimits() {}, summary: () => ({}), record() {}, refreshCodexLimits() {}, limits: () => ({}), current: () => ({}) };
  const o = new Orchestrator({
    chatsStore: store({ chats: [] }),
    prefsStore: store({ overrides: [] }),
    usage,
    getConfig: () => {
      const c = structuredClone(DEFAULT_CONFIG);
      c.integrations.whatsapp.enabled = true;
      c.voice.commandsEnabled = true;
      c.codex.enabled = true; // os testes cobrem a troca entre Claude e Codex
      if (codexOff) c.codex.enabled = false;
      c.integrations.whatsapp.confirmContacts = confirmContacts;
      return c;
    },
    emit: (ch, p) => events.push([ch, p]),
    ...extra,
  });
  return { o, events };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('aceita um segundo pedido enquanto o primeiro roda, em paralelo', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'explique a arquitetura do projeto em detalhes', runId: 'r1' });
  await tick();
  assert.equal(o.isRunning(chat.id), true);

  const p2 = o.send(chat.id, { text: 'qual a capital da França?', runId: 'r2' });
  await tick();
  assert.equal(calls.length, 2, 'os dois agentes rodam ao mesmo tempo');
  assert.equal(calls[1].opts.sessionId, undefined, 'o paralelo não reaproveita a sessão em uso');
  assert.match(calls[1].opts.systemPrompt, /rodando em paralelo/);

  calls[1].finish(); // o segundo termina primeiro
  const a2 = await p2;
  assert.equal(a2.parallel, true);
  assert.equal(o.isRunning(chat.id), true, 'o primeiro continua rodando');

  calls[0].finish();
  const a1 = await p1;
  assert.equal(a1.parallel, false);
  assert.equal(o.isRunning(chat.id), false);
  // Só o agente principal guarda a sessão.
  assert.equal(chat.sessions[a1.provider].id, 'sess-0');
});

test('cancelar sem runId para todos os agentes da conversa', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  o.send(chat.id, { text: 'tarefa 1 bem longa de análise', runId: 'a' });
  o.send(chat.id, { text: 'tarefa 2', runId: 'b' });
  await tick();
  o.cancel(chat.id);
  assert.ok(calls.every((c) => c.opts.signal.aborted));
  calls.forEach((c) => c.finish());
});

test('padrão: pedido para contato é enviado na hora, mesmo sem citar o WhatsApp, e ela diz para quem foi', async () => {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to: 'Vó Maria' }; } };
  const { o } = setup({ whatsappWeb });
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'se apresenta pra minha vó', source: 'voice', runId: 'a1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /ENVIA NA HORA/, 'ela sabe que pode mandar mesmo sem a palavra WhatsApp');
  calls[0].answer = 'Vou mandar uma apresentação pra sua vó.\n[[whatsapp para="vó"]]\nOi, vó! Aqui é a Ohara, assistente do Gabriel.\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await p;
  assert.deepEqual(sent, [{ to: 'vó', text: 'Oi, vó! Aqui é a Ohara, assistente do Gabriel.' }]);
  assert.equal(msg.whatsappDrafts[0].status, 'sent');
  assert.equal(msg.text, 'Vou mandar uma apresentação pra sua vó.\n\nEnviei para Vó Maria no WhatsApp.');
});

test('padrão: se o envio falha, ela fala o motivo', async () => {
  const whatsappWeb = { send: async () => { throw new Error('Mais de um contato para "Ana": Ana Paula, Ana Clara. Diga o nome completo.'); } };
  const { o } = setup({ whatsappWeb });
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'manda pra Ana que já saí', runId: 'a2' });
  await tick();
  calls[0].answer = 'Mando já.\n[[whatsapp para="Ana"]]\nJá saí!\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await p;
  assert.equal(msg.whatsappDrafts[0].status, 'error');
  assert.match(msg.text, /Não consegui enviar para Ana: Mais de um contato/);
});

test('por voz, conversa que não era com ela é ignorada em silêncio', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'Ela comprou a moto e deixou ele usar', source: 'voice', runId: 'i1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /\[\[ignorar\]\]/);
  calls[0].answer = '[[ignorar]]';
  calls[0].finish();
  const msg = await p;
  assert.equal(msg.ignored, true);
});

test('com confirmação ligada, pedido para contato vira rascunho e só sai depois da confirmação', async () => {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to: 'João Silva' }; } };
  const { o } = setup({ whatsappWeb, confirmContacts: true });
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'manda pro João no zap que vou atrasar 10 min', runId: 'w1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /\[\[whatsapp para=/);
  calls[0].answer = 'Preparei a mensagem.\n[[whatsapp para="João"]]\nOi João, vou atrasar uns 10 min!\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await p;

  assert.equal(msg.text, 'Preparei a mensagem.');
  assert.equal(msg.whatsappDrafts[0].status, 'pending');
  assert.equal(sent.length, 0, 'nada é enviado sem confirmação');

  const d = await o.confirmWhatsApp(chat.id, msg.id, 0);
  assert.equal(d.status, 'sent');
  assert.deepEqual(sent, [{ to: 'João', text: 'Oi João, vou atrasar uns 10 min!' }]);
});

test('com confirmação, ela mostra o contato que achou e envia exatamente para ele depois do "confirmado"', async () => {
  const sent = [];
  const whatsappWeb = {
    resolve: async (to) => ({ to: to === 'Alan' ? 'Alan Costa' : to }),
    send: async (to, text) => { sent.push({ to, text }); return { to }; },
  };
  const { o } = setup({ whatsappWeb, confirmContacts: true });
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'manda pro Alan que chego às 8', runId: 'k1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /mostra a ele o nome exato/);
  calls[0].answer = 'Mensagem pronta.\n[[whatsapp para="Alan"]]\nChego às 8!\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await p;
  assert.equal(sent.length, 0, 'nada sai antes da confirmação');
  assert.equal(msg.whatsappDrafts[0].contact, 'Alan Costa');
  assert.match(msg.text, /Achei o contato "Alan Costa" no seu WhatsApp\. É esse\?/);

  const reply = await o.send(chat.id, { text: 'sim, envia pro Alan Costa', runId: 'k2' });
  assert.deepEqual(sent, [{ to: 'Alan Costa', text: 'Chego às 8!' }], 'envia para o contato confirmado, não para o nome falado');
  assert.match(reply.text, /enviei a mensagem para Alan Costa/);
});

test('com confirmação, contato ambíguo não é enviado e ela pergunta qual é', async () => {
  const sent = [];
  const whatsappWeb = {
    resolve: async () => { throw new Error('Tem mais de um contato parecido com "Ana": Ana Paula, Ana Clara. Qual deles?'); },
    send: async (to, text) => { sent.push({ to, text }); return { to }; },
  };
  const { o } = setup({ whatsappWeb, confirmContacts: true });
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'manda pra Ana que já saí', runId: 'k3' });
  await tick();
  calls[0].answer = 'Pronto.\n[[whatsapp para="Ana"]]\nJá saí!\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await p;
  assert.equal(sent.length, 0);
  assert.equal(msg.whatsappDrafts[0].status, 'error');
  assert.match(msg.text, /Ainda não enviei para Ana: .*Qual deles\?/);
});

test('a confirmação do contato vem ligada por padrão', () => {
  assert.equal(DEFAULT_CONFIG.integrations.whatsapp.confirmContacts, true);
});

test('ação local responde sem chamar a IA', async () => {
  const opened = [];
  const { o } = setup({ openExternal: async (u) => opened.push(u) });
  const chat = o.create(WORK);
  const msg = await o.send(chat.id, { text: 'pesquisa no Google receita de bolo', runId: 'g1' });
  assert.equal(calls.length, 0);
  assert.equal(msg.provider, 'local');
  assert.deepEqual(opened, ['https://www.google.com/search?q=receita%20de%20bolo']);
});

test('oferece se alterar e, com o "sim", implementa no próprio repositório com o modelo forte', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'lê esse PDF pra mim', runId: 'm1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /resolutiva/);
  assert.match(calls[0].opts.systemPrompt, /bom humor/);
  calls[0].answer = 'Ainda não consigo ler PDF. Quer que eu me altere para aprender?\n[[melhoria: ler arquivos PDF anexados]]';
  calls[0].finish();
  const offer = await p1;
  assert.equal(offer.text, 'Ainda não consigo ler PDF. Quer que eu me altere para aprender?', 'a marcação some do texto');
  assert.equal(offer.improvementOffer, 'ler arquivos PDF anexados');

  const p2 = o.send(chat.id, { text: 'sim, pode fazer', runId: 'm2' });
  await tick();
  const run = calls[1].opts;
  assert.equal(run.cwd, 'C:\\repositorios\\Projetos-Pessoais\\ohara');
  assert.equal(run.model, 'opus');
  assert.match(run.prompt, /aceitou que você se altere para conseguir: ler arquivos PDF anexados/);
  assert.match(run.prompt, /Pedido original dele: "lê esse PDF pra mim"/);
  assert.equal(run.sessionId, undefined);
  calls[1].finish();
  await p2;
  assert.equal(chat.cwd, WORK, 'a conversa continua na pasta dela');
});

test('a oferta vale só para a resposta seguinte', async () => {
  const { o } = setup();
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'manda um fax', runId: 'f1' });
  await tick();
  calls[0].answer = 'Não tenho fax.\n[[melhoria: enviar fax]]';
  calls[0].finish();
  await p1;
  const p2 = o.send(chat.id, { text: 'deixa, me fala a previsão do tempo', runId: 'f2' });
  await tick();
  assert.notEqual(calls[1].opts.cwd, 'C:\\repositorios\\Projetos-Pessoais\\ohara');
  calls[1].finish();
  await p2;
  const p3 = o.send(chat.id, { text: 'sim', runId: 'f3' });
  await tick();
  assert.equal(calls[2].opts.cwd, WORK, '"sim" atrasado não dispara a automelhoria');
  calls[2].finish();
  await p3;
});

async function draftChat(extra = {}) {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to: 'Tata Souza' }; } };
  const { o, events } = setup({ whatsappWeb, confirmContacts: true, ...extra });
  const chat = o.create(WORK);
  const p = o.send(chat.id, { text: 'envia mensagem pra Tata no meu WhatsApp se apresentando', runId: 'd1' });
  await tick();
  calls[0].answer = 'Preparei a mensagem.\n[[whatsapp para="Tata"]]\nOi! Aqui é a Ohara.\n[[/whatsapp]]';
  calls[0].finish();
  const draft = await p;
  return { o, events, chat, draft, sent };
}

test('"confirmado" por texto envia o rascunho pendente sem outro clique e sem chamar a IA', async () => {
  const { o, chat, draft, sent } = await draftChat();
  const reply = await o.send(chat.id, { text: 'confirmado', runId: 'd2' });
  assert.equal(calls.length, 1, 'a confirmação não passa pela IA');
  assert.deepEqual(sent, [{ to: 'Tata', text: 'Oi! Aqui é a Ohara.' }]);
  assert.equal(draft.whatsappDrafts[0].status, 'sent');
  assert.equal(reply.provider, 'local');
  assert.match(reply.text, /enviei a mensagem para Tata Souza/);

  // Já enviado: um segundo "envia" não manda de novo, vai para a IA.
  const p = o.send(chat.id, { text: 'envia', runId: 'd3' });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(sent.length, 1);
  calls[1].finish();
  await p;
});

test('confirmação por voz também envia e a resposta é curta para falar', async () => {
  const { o, chat, sent, events } = await draftChat();
  const reply = await o.send(chat.id, { text: 'Pode enviar a mensagem.', source: 'voice', runId: 'v1' });
  assert.equal(sent.length, 1);
  assert.equal(reply.text, 'Pronto, enviei a mensagem para Tata Souza no WhatsApp.');
  assert.ok(events.some(([ch, p]) => ch === 'chat:done' && p.runId === 'v1' && p.source === 'voice'));
});

test('"cancela" descarta o rascunho e um pedido novo segue para a IA', async () => {
  const { o, chat, draft, sent } = await draftChat();
  // Troca de IA de propósito: a outra só conhece o rascunho pelo contexto transferido.
  const other = draft.provider === 'codex' ? 'claude:rapido' : 'codex';
  const p = o.send(chat.id, { text: 'muda o texto pra ficar mais curto', override: other, runId: 'c1' });
  await tick();
  assert.equal(calls.length, 2, 'ajuste no texto vai para a IA');
  assert.match(calls[1].opts.prompt, /Mensagem de WhatsApp para "Tata" \(aguardando confirmação\): Oi! Aqui é a Ohara\./, 'a IA vê o rascunho');
  calls[1].answer = 'Encurtei.\n[[whatsapp para="Tata"]]\nOi, sou a Ohara!\n[[/whatsapp]]';
  calls[1].finish();
  const second = await p;
  assert.equal(second.whatsappDrafts[0].status, 'pending', 'o rascunho vale mesmo sem citar o WhatsApp no pedido');

  const reply = await o.send(chat.id, { text: 'não envia, cancela', runId: 'c2' });
  assert.equal(second.whatsappDrafts[0].status, 'cancelled');
  assert.equal(draft.whatsappDrafts[0].status, 'pending', 'só a última resposta conta');
  assert.match(reply.text, /cancelei/);
  assert.equal(sent.length, 0);
});

test('"sim" com oferta de melhoria aberta é para a melhoria, não para o envio', async () => {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to }; } };
  const { o } = setup({ whatsappWeb, confirmContacts: true });
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'manda pra Tata no zap um oi', runId: 's1' });
  await tick();
  calls[0].answer = 'Preparei.\n[[whatsapp para="Tata"]]\nOi!\n[[/whatsapp]]\nPosso aprender a enviar sozinha.\n[[melhoria: enviar sem confirmação]]';
  calls[0].finish();
  await p1;
  const p2 = o.send(chat.id, { text: 'sim', runId: 's2' });
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(calls[1].opts.cwd, 'C:\\repositorios\\Projetos-Pessoais\\ohara');
  calls[1].finish();
  await p2;
});


test('edicao simples bloqueia voz e adaptadores de WhatsApp mesmo com dados antigos', async () => {
  const { simplifyConfig } = require('../src/core/config');
  const config = simplifyConfig(structuredClone(DEFAULT_CONFIG));
  let sends = 0;
  const adapter = { send: async () => { sends++; } };
  const { o } = setup({ getConfig: () => config, whatsapp: adapter, whatsappWeb: adapter });
  const chat = o.create(WORK);
  await assert.rejects(o.send(chat.id, { text: 'oi', source: 'voice' }), /voz desativados/);
  assert.equal(calls.length, 0);
  chat.messages.push({ id: 'old', role: 'assistant', at: Date.now(), whatsappDrafts: [{ to: 'Ana', text: 'Oi', status: 'pending' }] });
  await assert.rejects(o.confirmWhatsApp(chat.id, 'old', 0), /indispon/);
  const pending = o.send(chat.id, { text: 'envia a mensagem', runId: 'disabled' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /comandos de voz foram desativados/);
  calls[0].answer = 'Texto para copiar.';
  calls[0].finish();
  await pending;
  assert.equal(sends, 0);
});

test('pasta da conversa apagada: volta para a pasta padrão em vez de falhar com "spawn ENOENT"', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.defaultCwd = WORK;
  const { o } = setup({ getConfig: () => config });
  const chat = o.create(path.join(WORK, `ohara-pasta-que-nao-existe-${Date.now()}`));
  chat.sessions = { claude: { id: 'velha', syncedUpTo: 0 } };
  const pending = o.send(chat.id, { text: 'qual a capital da França?', runId: 'cwd' });
  await tick();
  assert.equal(calls[0].opts.cwd, WORK);
  assert.equal(calls[0].opts.sessionId, undefined, 'a sessão presa à pasta antiga é descartada');
  calls[0].finish();
  const msg = await pending;
  assert.equal(chat.cwd, WORK);
  assert.ok(msg.route.reasons.some((r) => /não existe mais/.test(r)));
});

test('envio de WhatsApp desligado: bloco que a IA montar vira texto para copiar', async () => {
  const { simplifyConfig } = require('../src/core/config');
  const config = simplifyConfig(structuredClone(DEFAULT_CONFIG));
  config.defaultCwd = WORK;
  const { o } = setup({ getConfig: () => config });
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'escreve um recado pra Ana', runId: 'wa-off' });
  await tick();
  calls[0].answer = 'Aqui está:\n[[whatsapp para="Ana"]]\nOi, Ana! Chego às 19h.\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await pending;
  assert.doesNotMatch(msg.text, /\[\[whatsapp/);
  assert.match(msg.text, /Mensagem para Ana/);
  assert.match(msg.text, /Chego às 19h/);
  assert.equal(msg.whatsappDrafts, undefined);
});

test('falha ao registrar o uso não impede o fim da resposta', async () => {
  const { o, events } = setup();
  o.usage.summary = () => { throw new Error('disco cheio'); };
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'oi', runId: 'uso' });
  await tick();
  calls[0].finish();
  await pending;
  assert.ok(events.some(([ch]) => ch === 'chat:done'));
});

test('pedido de navegador abre o Chrome antes e o prompt ensina a reconectar a extensão', async () => {
  const opened = [];
  const { o } = setup({ ensureChrome: async () => { opened.push(1); return { running: true, started: true }; } });
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'preenche o projeto no meu perfil do LinkedIn', runId: 'chrome' });
  await tick();
  assert.equal(opened.length, 1, 'abriu o Chrome antes de chamar a IA');
  assert.equal(calls[0].provider, 'claude');
  assert.match(calls[0].opts.systemPrompt, /Claude in Chrome/);
  assert.match(calls[0].opts.systemPrompt, /tente de novo/);
  calls[0].finish();
  const msg = await pending;
  assert.ok(msg.tools.some((t) => /Chrome: aberto/.test(t)));
});

test('pedido sem navegador não abre o Chrome; Chrome desligado em Ajustes também não', async () => {
  let opened = 0;
  const ensureChrome = async () => { opened++; return { running: true, started: false }; };
  const { o } = setup({ ensureChrome });
  const chat = o.create(WORK);
  const p1 = o.send(chat.id, { text: 'qual a capital da França?', runId: 'sem-nav' });
  await tick();
  calls[0].finish();
  await p1;
  assert.equal(opened, 0);

  const config = structuredClone(DEFAULT_CONFIG);
  config.claude.chrome = false;
  const off = setup({ ensureChrome, getConfig: () => config });
  const chat2 = off.o.create(WORK);
  const p2 = off.o.send(chat2.id, { text: 'abre o LinkedIn no Chrome e edita meu perfil', runId: 'chrome-off' });
  await tick();
  assert.equal(opened, 0);
  assert.doesNotMatch(calls[0].opts.systemPrompt, /Claude in Chrome/);
  calls[0].finish();
  await p2;
});

test('falha ao abrir o Chrome não impede a resposta e aparece nas ferramentas', async () => {
  const { o } = setup({ ensureChrome: async () => { throw new Error('acesso negado'); } });
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'confere a vaga no LinkedIn', runId: 'chrome-erro' });
  await tick();
  calls[0].finish();
  const msg = await pending;
  assert.ok(msg.tools.some((t) => /não consegui abrir \(acesso negado\)/.test(t)));
  assert.ok(msg.text);
});

test('pedido de LinkedIn que pareceria código vai para o Claude, que tem o navegador', async () => {
  const { o } = setup({ ensureChrome: async () => ({ running: true, started: false, bridge: true }) });
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'implementa o post no linkedin sobre o commit do repositorio', runId: 'li' });
  await tick();
  assert.equal(calls[0].provider, 'claude');
  assert.match(calls[0].opts.systemPrompt, /confira a conexão primeiro/);
  calls[0].finish();
  const msg = await pending;
  assert.ok(msg.route.reasons.some((r) => /Chrome logado/.test(r)));
});

test('ponte da extensão ausente: avisa antes de começar e a IA já sabe o motivo', async () => {
  const { o } = setup({ ensureChrome: async () => ({ running: true, started: false, bridge: false, error: 'a extensão Claude in Chrome não está registrada no Windows' }) });
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'confere meu perfil do LinkedIn', runId: 'ponte' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /Verificação do navegador antes de começar: a extensão Claude in Chrome não está registrada/);
  calls[0].finish();
  const msg = await pending;
  assert.ok(msg.tools.some((t) => /Chrome: a extensão Claude in Chrome não está registrada/.test(t)));
});

test('Claude bloqueado: o Codex recebe o pedido de navegador sem tentar abrir o Chrome', async () => {
  let opened = 0;
  const usage = { updateClaudeLimits() {}, summary: () => ({}), record() {}, refreshCodexLimits() {}, limits: () => ({ claude: { status: 'rejected' }, codex: { fiveHour: 0.1 } }), current: () => ({}) };
  const { o } = setup({ usage, ensureChrome: async () => { opened++; return { running: true, bridge: true }; } });
  const chat = o.create(WORK);
  const pending = o.send(chat.id, { text: 'faz um post no linkedin', runId: 'codex-nav' });
  await tick();
  assert.equal(calls[0].provider, 'codex');
  assert.equal(opened, 0);
  assert.match(calls[0].opts.systemPrompt, /você \(Codex\) não tem a extensão/);
  assert.doesNotMatch(calls[0].opts.systemPrompt, /mcp__claude-in-chrome/);
  calls[0].finish();
  await pending;
});
