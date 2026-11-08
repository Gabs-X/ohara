const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { searchBox, contactRows } = require('../src/integrations/whatsapp-dom');

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
