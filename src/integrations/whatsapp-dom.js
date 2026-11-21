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

// Mensagens enviadas por ele na conversa aberta: classe .message-out ou data-id "true_..." (fromMe).
function outgoingMessages() {
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('#main .message-out, #main [data-id^="true_"]')) {
    const id = el.getAttribute('data-id') || el.closest('[data-id]')?.getAttribute('data-id');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text: el.innerText || el.textContent || '' });
  }
  return out;
}

/**
 * Diz se a mensagem saiu depois do Enter.
 * O WhatsApp corta mensagens longas ("Ler mais"), formata listas e emojis e acrescenta a hora,
 * então a comparação é pelo começo do texto, só com letras e números.
 * Retorna { sent, composer: 'empty' | 'filled' | 'missing' }.
 */
function sendState(beforeIds, text) {
  const loose = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  const box = document.querySelector('#main footer [contenteditable="true"]');
  const composer = !box ? 'missing' : (box.textContent || '').trim() ? 'filled' : 'empty';
  const fresh = outgoingMessages().filter((m) => !beforeIds.includes(m.id));
  const wanted = loose(text).slice(0, 40);
  const sent = composer !== 'filled' && fresh.some((m) => !wanted || loose(m.text).includes(wanted));
  return { sent, composer };
}

module.exports = { searchBox, contactRows, outgoingMessages, sendState };
