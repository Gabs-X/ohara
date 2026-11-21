/* global central, el, renderMeetings, renderToday, renderAutomations, renderTools, renderUsageView, renderSettings, toast */
// Navegação entre as telas.

const VIEWS = ['today', 'chat', 'meetings', 'tools', 'auto', 'usage', 'settings'];
let currentView = 'chat';

function setView(view) {
  if (!VIEWS.includes(view)) view = 'chat';
  currentView = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  for (const v of VIEWS) document.getElementById(`view-${v}`).hidden = v !== view;
  document.querySelector('.side-chat').hidden = view !== 'chat';
  document.querySelector('.side-meetings').hidden = view !== 'meetings';
  document.querySelector('.side-spacer').hidden = view === 'chat' || view === 'meetings';
  const render = { today: renderToday, meetings: renderMeetings, tools: renderTools, auto: renderAutomations, usage: renderUsageView, settings: renderSettings }[view];
  render?.();
  if (view === 'chat') el.input.focus();
  try {
    localStorage.setItem('central:view', view);
  } catch {
    /* sem armazenamento: tudo bem */
  }
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
central.onView((view) => {
  if (view === 'meetings' && typeof mt !== 'undefined') mt.view = 'board';
  setView(view);
});

(async function initNav() {
  let saved = 'chat';
  try {
    saved = localStorage.getItem('central:view') || 'chat';
  } catch {
    /* ignora */
  }
  setView(saved);

})();
