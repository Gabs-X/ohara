const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { searchBox, contactRows, outgoingMessages, sendState } = require('../src/integrations/whatsapp-dom');

function field({ label = '', scope = '', visible = true } = {}) {
  return {
    getClientRects: () => visible ? [{}] : [],
    getAttribute: (name) => name === 'aria-label' ? label : null,
    closest: (selector) => scope && selector.split(',').map(s => s.trim()).includes(scope) ? {} : null,
  };
}

function find(fields) {
  return vm.runInNewContext(`(${searchBox.toString()})()`, { document: { querySelectorAll: () => fields } });
}

test('busca pelo rótulo atual sem depender do antigo #side', () => {
  for (const label of ['Pesquisar ou começar uma nova conversa', 'Search or start a new chat', 'Buscar']) {
    const search = field({ label });
    assert.equal(find([field({ scope: '#main', label: 'Pesquisar' }), search]), search);
  }
});

test('ignora busca oculta, campo da conversa e diálogos', () => {
  assert.equal(find([field({ label: 'Pesquisar', visible: false }), field({ scope: '#main', label: 'Search' }), field({ scope: '[role="dialog"]', label: 'Pesquisar' })]), null);
});

test('mantém busca antiga e reconhece painel aside', () => {
  for (const scope of ['#side', 'aside']) {
    const search = field({ scope });
    assert.equal(find([search]), search);
  }
});

test('resultados não são cortados antes de identificar o contato parcial', () => {
  const titles = [...Array.from({ length: 20 }, (_, i) => `Contato ${i}`), 'Tata Souza'];
  const items = titles.map(name => ({ querySelector: () => ({ getAttribute: () => name }) }));
  const rows = vm.runInNewContext(`(${contactRows.toString()})()`, { document: { querySelector: () => ({ querySelectorAll: () => items }) } });
  const { pickContact } = require('../src/integrations/whatsapp');
  assert.equal(pickContact('Tata', rows.map(row => row.name)).name, 'Tata Souza');
});

function bubble(id, text) {
  return { innerText: text, getAttribute: (name) => name === 'data-id' ? id : null, closest: () => null };
}

function state(before, text, { messages = [], composer = '' } = {}) {
  const box = composer === null ? null : { textContent: composer };
  const document = { querySelector: () => box, querySelectorAll: () => messages };
  const r = vm.runInNewContext(`(() => { ${outgoingMessages.toString()}; return (${sendState.toString()})(${JSON.stringify(before)}, ${JSON.stringify(text)}); })()`, { document });
  return { sent: r.sent, composer: r.composer };
}

const LONGA = 'Oi, eu sou a Ohara, assistente pessoal do Gabriel, rodando no PC dele (Windows 11).\n\nStack técnica:\n- App desktop em Electron, código em C:\repositorios\Projetos-Pessoais\ohara.\n- Organização: src/integrations (integrações), src/core (lógica), src/renderer (interface), test/ (testes).\n- Orquestra agentes de IA (claude e codex).\n- Entrada por voz: transcreve o pedido e responde em voz alta.\n- Envio de WhatsApp pelo WhatsApp Web do Gabriel, buscando o contato por nome, mesmo parcial.';

test('reconhece mensagem longa que o WhatsApp cortou com "Ler mais" e formatou como lista', () => {
  const shown = 'Oi, eu sou a Ohara, assistente pessoal do Gabriel, rodando no PC dele (Windows 11).\nStack técnica:\n• App desktop em Electron, código em C:\repositorios… Ler mais\n14:32';
  const messages = [bubble('true_123@g.us_OLD', 'antiga\n14:00'), bubble('true_123@g.us_NEW', shown)];
  assert.deepEqual(state(['true_123@g.us_OLD'], LONGA, { messages }), { sent: true, composer: 'empty' });
});

test('não confunde mensagem antiga igual com a nova', () => {
  const messages = [bubble('true_1@c.us_OLD', 'Chego tarde hoje\n10:00')];
  assert.deepEqual(state(['true_1@c.us_OLD'], 'Chego tarde hoje', { messages }), { sent: false, composer: 'empty' });
});

test('mensagem que ficou no campo de texto não conta como enviada', () => {
  const messages = [bubble('true_1@c.us_NEW', 'Chego tarde hoje\n10:00')];
  assert.deepEqual(state([], 'Chego tarde hoje', { messages, composer: 'Chego tarde hoje' }), { sent: false, composer: 'filled' });
});

test('identifica mensagens enviadas por data-id true_ mesmo sem a classe message-out', () => {
  const ids = vm.runInNewContext(`(${outgoingMessages.toString()})().map(m => m.id)`, {
    document: { querySelectorAll: () => [bubble('true_9@c.us_A', 'a'), bubble('true_9@c.us_A', 'a'), bubble('true_9@c.us_B', 'b')] },
  });
  assert.deepEqual([...ids], ['true_9@c.us_A', 'true_9@c.us_B']);
});
