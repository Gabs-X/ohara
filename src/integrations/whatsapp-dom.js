// Funções executadas na página e também verificadas nos testes de regressão.
function searchBox() {
  const visible = (e) => e && e.getClientRects().length && e.getAttribute('aria-hidden') !== 'true';
  const fields = [...document.querySelectorAll('[contenteditable="true"], input')].filter(visible);
  return fields.find((e) => !e.closest('#main, footer, [role="dialog"]') &&
    /pesquis|buscar|search/i.test([e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title')].filter(Boolean).join(' '))) ||
    fields.find((e) => e.closest('#side, aside, [data-testid="chat-list-search"]') && !e.closest('#main, footer, [role="dialog"]')) || null;
}

function contactRows() {
  const root = document.querySelector('#pane-side');
  if (!root) return [];
  return [...root.querySelectorAll('[role="listitem"], [role="row"]')]
    .map((item) => ({ item, name: item.querySelector('span[title]')?.getAttribute('title') }))
    .filter(({ name }) => name);
}

module.exports = { searchBox, contactRows };
