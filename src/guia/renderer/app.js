/* global guia, renderMarkdown, renderTools, renderHelp */
// Tela da Ohara Guia: conversas, planos, uso e economia, primeiros passos e ajustes.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const usd = (n) => `US$ ${(n || 0).toFixed(n < 1 ? 3 : 2).replace('.', ',')}`;
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
// Codifica cada pedaço do caminho (inclusive # e ?, que o encodeURI deixaria passar).
const fileUrl = (p) => `file:///${String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  .map((seg, i) => (i === 0 && /^[a-z]:$/i.test(seg) ? seg : encodeURIComponent(seg))).join('/')}`;
// A CSP (style-src 'self') bloqueia atributos style="" vindos de innerHTML. Os templates usam
// data-css="..." e aqui o estilo é aplicado pelo CSSOM, que a CSP permite.
function applyDataCss(node) {
  if (node.nodeType !== 1) return;
  const els = node.matches('[data-css]') ? [node, ...node.querySelectorAll('[data-css]')] : node.querySelectorAll('[data-css]');
  for (const e of els) { e.style.cssText = e.dataset.css; e.removeAttribute('data-css'); }
}
new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(applyDataCss)))
  .observe(document.documentElement, { childList: true, subtree: true });
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
// Usados pela tela de Ferramentas (src/renderer/tools.js), que é a mesma da Ohara.
function relTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `há ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.round(diff / 3600)} h`;
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
const el = { input: document.querySelector('#input') };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// Chamada ao processo principal: devolve os dados ou mostra o erro.
async function call(promise, { quiet = false } = {}) {
  const r = await promise;
  if (r && r.ok === false) {
    if (!quiet) toast(r.error, 'error');
    throw new Error(r.error);
  }
  return r?.data;
}
const tryCall = (p) => call(p).catch(() => null);

let toastTimer;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 7000 : 3500);
}

function openModal(html) {
  const card = $('#modal-card');
  card.innerHTML = html;
  $('#modal').hidden = false;
  card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  setTimeout(() => card.querySelector('input,textarea')?.focus(), 30);
  return card;
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

const state = {
  config: null,
  health: null,
  providers: [],
  chatId: null,
  chat: null,
  pendingCwd: '', // pasta escolhida antes de existir a conversa
  attachments: [],
  running: new Map(), // chatId -> Set(runId)
  lives: new Map(), // runId -> mensagem em andamento
  planId: null,
  view: 'chat',
};

// ======================= Navegação =======================
const VIEWS = ['chat', 'plans', 'tools', 'usage', 'health', 'settings', 'help'];
function setView(view) {
  if (!VIEWS.includes(view)) view = 'chat';
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $('.side-chat').hidden = view !== 'chat';
  $('.side-spacer').hidden = view === 'chat';
  const tools = typeof renderTools === 'function' ? renderTools : null; // vem de src/renderer/tools.js
  const help = typeof renderHelp === 'function' ? () => renderHelp() : null; // vem de help.js
  ({ plans: renderPlans, tools, usage: renderUsage, health: renderHealth, settings: renderSettings, help }[view])?.();
  if (view === 'chat') $('#input').focus();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
guia.onView((v) => setView(v));

// ======================= Conversas =======================
const isBusy = (chatId) => (state.running.get(chatId)?.size || 0) > 0;
function markRunning(chatId, runId, on) {
  if (!state.running.has(chatId)) state.running.set(chatId, new Set());
  const set = state.running.get(chatId);
  if (on) set.add(runId); else set.delete(runId);
  if (!set.size) state.running.delete(chatId);
  updateSend();
}

// Apagar pede um segundo clique: o botão vira "Apagar?" por 4 s (sem janela de diálogo, que trava o app).
function armDelete(btn, onConfirm, label = 'Apagar?') {
  if (btn.dataset.armed === '1') {
    clearTimeout(Number(btn.dataset.timer));
    onConfirm();
    return;
  }
  const original = btn.innerHTML;
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = label;
  btn.dataset.timer = String(setTimeout(() => {
    btn.dataset.armed = '';
    btn.classList.remove('armed');
    btn.innerHTML = original;
  }, 4000));
}

async function deleteChats(ids) {
  for (const id of ids) await tryCall(guia.deleteChat(id));
  if (ids.includes(state.chatId)) newChat();
  updateDeleteButton();
  refreshChats();
}

// Modo "Selecionar": marca várias conversas e apaga de uma vez.
state.selecting = false;
state.selected = new Set();
function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  $('#bulk-bar').hidden = !on;
  $('#select-chats').hidden = on;
  updateBulkBar();
  refreshChats();
}
function updateBulkBar() {
  const n = state.selected.size;
  $('#bulk-count').textContent = n === 1 ? '1 marcada' : `${n} marcadas`;
  const del = $('#bulk-delete');
  del.disabled = !n;
  del.textContent = n ? `Apagar ${n}` : 'Apagar';
  del.dataset.armed = '';
  del.classList.remove('armed');
}
$('#select-chats').addEventListener('click', () => setSelecting(true));
$('#bulk-cancel').addEventListener('click', () => setSelecting(false));
$('#bulk-delete').addEventListener('click', (e) => {
  const ids = [...state.selected];
  if (!ids.length) return;
  armDelete(e.currentTarget, async () => {
    await deleteChats(ids);
    setSelecting(false);
  }, `Apagar ${ids.length}? Confirma`);
});
function updateDeleteButton() {
  $('#delete-chat').hidden = !state.chatId;
}
$('#delete-chat').addEventListener('click', (e) => {
  if (!state.chatId) return;
  const id = state.chatId;
  armDelete(e.currentTarget, () => deleteChats([id]), 'Apagar esta conversa?');
});

async function refreshChats() {
  const chats = (await tryCall(guia.listChats())) || [];
  const list = $('#chat-list');
  list.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    const picked = state.selected.has(c.id);
    item.className = `chat-item${c.id === state.chatId ? ' active' : ''}${state.selecting ? ' selecting' : ''}${picked ? ' picked' : ''}`;
    const label = `<span title="${esc(c.cwd || 'sem projeto')}">${isBusy(c.id) ? '⏳ ' : ''}${esc(c.title)}</span>`;
    item.innerHTML = state.selecting
      ? `<input type="checkbox" class="pick" ${picked ? 'checked' : ''} aria-label="Marcar" />${label}`
      : `${label}<button class="del" title="Apagar conversa">✕</button>`;
    item.addEventListener('click', () => {
      if (!state.selecting) return openChat(c.id);
      if (state.selected.has(c.id)) state.selected.delete(c.id);
      else state.selected.add(c.id);
      updateBulkBar();
      refreshChats();
    });
    item.querySelector('.del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      armDelete(e.currentTarget, () => deleteChats([c.id]), 'Apagar?');
    });
    list.appendChild(item);
  }
}

async function openChat(id) {
  state.chatId = id;
  const chat = await tryCall(guia.getChat(id));
  if (state.chatId !== id) return; // clicou em outra conversa enquanto esta carregava
  state.chat = chat;
  if (!state.chat) return newChat();
  renderMessages();
  await syncProjectSelect();
  refreshChats();
  updateSend();
  if (state.view !== 'chat') setView('chat');
}

function newChat() {
  state.chatId = null;
  state.chat = null;
  renderMessages();
  syncProjectSelect();
  refreshChats();
  updateSend();
  $('#input').focus();
}
$('#new-chat').addEventListener('click', newChat);

async function ensureChat() {
  if (state.chatId) return state.chat;
  const chat = await call(guia.createChat(state.pendingCwd || null));
  state.chatId = chat.id;
  state.chat = chat;
  refreshChats();
  return chat;
}

const currentCwd = () => (state.chat ? state.chat.cwd : state.pendingCwd) || '';

// ---------- Projeto ----------
async function syncProjectSelect() {
  const sel = $('#project-select');
  const { list = [], dir } = (await tryCall(guia.listProjects())) || {};
  const cwd = currentCwd();
  const opts = [['', '💬 Sem projeto (só conversa)']];
  for (const p of list) opts.push([p.path, `📂 ${p.name}`]);
  if (cwd && !list.some((p) => p.path === cwd)) opts.push([cwd, `📂 ${baseName(cwd)}`]);
  opts.push(['__new', '➕ Novo projeto…'], ['__pick', '📁 Escolher outra pasta…']);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = cwd;
  sel.title = cwd ? `Pasta do projeto: ${cwd}` : `Sem projeto. Os projetos novos ficam em ${dir || ''}`;
  const has = !!cwd;
  $('#run-project').hidden = !has;
  $('#open-folder').hidden = !has;
  if (has) {
    const d = await tryCall(guia.detectProject(cwd));
    $('#run-project').title = d?.kind === 'none' ? d.reason : d?.label || 'Abrir o projeto';
  }
  previewRoute();
}

async function setCwd(cwd) {
  if (state.chat) {
    if (state.chat.messages.length && state.chat.cwd !== cwd) toast('Pasta trocada. A IA começa uma sessão nova, mas leva o contexto da conversa.');
    await tryCall(guia.setCwd(state.chatId, cwd || null));
    state.chat.cwd = cwd || null;
  } else state.pendingCwd = cwd || '';
  syncProjectSelect();
}

$('#project-select').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v === '__pick') {
    const dir = await tryCall(guia.pickFolder());
    return dir ? setCwd(dir) : syncProjectSelect();
  }
  if (v === '__new') {
    const card = openModal(`<h2>Novo projeto</h2><p class="muted">A Ohara cria uma pasta só para ele. Tudo o que a IA fizer fica lá dentro, com pontos de restauração.</p>
      <input type="text" id="np-name" placeholder="Nome do projeto, ex.: site do escritório" />
      <div class="row" data-css="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="np-ok">Criar</button></div>`);
    const ok = async () => {
      try {
        const p = await call(guia.newProject(card.querySelector('#np-name').value));
        closeModal();
        await setCwd(p.path);
        toast(`Projeto "${p.name}" criado.`);
      } catch { /* toast já mostrou */ }
    };
    card.querySelector('#np-ok').addEventListener('click', ok);
    card.querySelector('#np-name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok(); });
    $('#modal').addEventListener('mousedown', () => syncProjectSelect(), { once: true });
    return syncProjectSelect();
  }
  setCwd(v);
});

$('#run-project').addEventListener('click', async () => {
  const d = await tryCall(guia.runProject(currentCwd()));
  if (!d) return;
  if (d.kind === 'none') toast(d.reason, 'error');
  else toast(d.kind === 'browser' ? 'Abri no navegador.' : 'Abri um terminal rodando o projeto. Para parar, feche a janela preta.');
});
$('#open-folder').addEventListener('click', () => guia.openFolder(currentCwd()));

// ---------- Mensagens ----------
function renderMessages() {
  const box = $('#messages');
  box.querySelectorAll('.msg').forEach((n) => n.remove());
  const msgs = state.chat?.messages || [];
  $('#empty').hidden = msgs.length > 0;
  $('#chat-title').textContent = state.chat?.title || 'Nova conversa';
  updateDeleteButton();
  for (const m of msgs) {
    // Resposta ainda rodando que começou fora desta tela (etapa de plano): passa a acompanhar ao vivo.
    if (m.pending && !state.lives.has(m.id)) {
      state.lives.set(m.id, { chatId: state.chatId, msg: { ...m, tools: [...(m.tools || [])] } });
      markRunning(state.chatId, m.id, true);
    }
    appendMessage(m);
  }
  for (const [runId, live] of state.lives) if (live.chatId === state.chatId) fillAssistant(findMsgEl(runId), live.msg, true);
  scrollBottom(true);
}

const findMsgEl = (id) => $('#messages').querySelector(`.msg[data-id="${CSS.escape(id)}"]`);

function appendMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  if (m.id) wrap.dataset.id = m.id;
  if (m.role === 'user') {
    const imgs = (m.images || []).map((p) => `<img src="${fileUrl(p)}" alt="">`).join('');
    wrap.innerHTML = `${imgs ? `<div class="imgs">${imgs}</div>` : ''}<div class="bubble"></div>`;
    wrap.querySelector('.bubble').textContent = m.text;
  } else {
    fillAssistant(wrap, m, false);
  }
  $('#messages').appendChild(wrap);
  $('#empty').hidden = true;
  return wrap;
}

function providerClass(p) { return ['claude', 'codex', 'gemini', 'ollama'].includes(p) ? p : ''; }

function fillAssistant(wrap, m, live) {
  if (!wrap) return;
  const reasons = (m.route?.reasons || []).join('\n');
  const tokens = m.tokens && (m.tokens.input || m.tokens.output) ? `${fmtNum((m.tokens.input || 0) + (m.tokens.cached || 0))} lidos · ${fmtNum(m.tokens.output)} escritos` : '';
  const tools = m.tools || [];
  const cp = m.checkpoint;
  wrap.innerHTML = `
    <div class="meta">
      ${m.provider ? `<span class="tag ${providerClass(m.provider)}">${esc(m.model || m.provider)}</span>` : ''}
      <span class="why" title="${esc(reasons)}">${esc(m.route?.label || '')} · por quê?</span>
      ${tokens ? `<span>${tokens}</span>` : ''}
      ${m.anonymized ? `<span title="CPF, nomes, e-mails etc. saíram do PC trocados por marcadores e voltaram na resposta">🕶️ ${m.anonymized} dado(s) protegidos</span>` : ''}
      ${!live && m.text ? '<button class="icon-btn" data-a="copy" title="Copiar a resposta">⧉</button>' : ''}
    </div>
    ${m.switched?.length ? `<div class="switched">↪ ${esc(m.switched.join(' · '))}</div>` : ''}
    ${tools.length ? `<details class="tools"><summary>🔧 ${tools.length} ${tools.length === 1 ? 'ação' : 'ações'} da IA</summary><ul>${tools.slice(-60).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
    <div class="bubble">${m.text ? renderMarkdown(m.text) : live ? '<span class="typing"><span class="spin"></span> pensando…</span>' : ''}${m.error ? `<div class="error">⚠️ ${esc(m.error)}</div>` : ''}</div>
    ${cp ? checkpointHtml(cp) : ''}
    ${!live && m.pcActions?.length ? pcActionsHtml(m) : ''}`;
  wirePcActions(wrap, m);
  wrap.querySelector('[data-a=copy]')?.addEventListener('click', () => { navigator.clipboard.writeText(m.text || ''); toast('Copiado.'); });
  wrap.querySelectorAll('.bubble pre .copy').forEach((b) => b.addEventListener('click', () => navigator.clipboard.writeText(b.nextElementSibling.textContent)));
  wrap.querySelectorAll('.bubble a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); guia.openExternal(a.href); }));
  wrap.querySelector('[data-a=undo]')?.addEventListener('click', () => undoMsg(m, 'undo'));
  wrap.querySelector('[data-a=redo]')?.addEventListener('click', () => undoMsg(m, 'redo'));
}

// Ações da Ohara-AI no PC que esperam confirmação (fechar programa, apagar, desligar...).
// O botão só diz qual item confirmar: o que roda é o que ficou guardado na mensagem.
const PC_ACTION_LABEL = { running: 'fazendo…', done: '✓ feito', error: '⚠️ falhou', cancelled: 'cancelada', expired: 'expirou' };
function pcActionsHtml(m) {
  return '<div class="pc-actions">' + m.pcActions.map((a, i) => {
    const detail = a.status === 'done' ? a.result : a.status === 'error' ? a.error : '';
    const right = a.status === 'pending'
      ? '<button class="btn small primary" data-pc="ok" data-i="' + i + '">Confirmar</button><button class="btn small" data-pc="no" data-i="' + i + '">Cancelar</button>'
      : '<span class="muted">' + esc(PC_ACTION_LABEL[a.status] || a.status) + (detail ? ' · ' + esc(detail) : '') + '</span>';
    return '<div class="pc-action ' + esc(a.status) + '"><span class="what">⚙️ ' + esc(a.resumo) + '</span>' + right + '</div>';
  }).join('') + '</div>';
}
function wirePcActions(wrap, m) {
  wrap.querySelectorAll('[data-pc]').forEach((b) => b.addEventListener('click', async (e) => {
    // Só clique de verdade (mouse/teclado): clique gerado por script não confirma ação no PC.
    if (!e.isTrusted) return;
    const i = Number(b.dataset.i);
    b.disabled = true;
    const r = b.dataset.pc === 'ok' ? await guia.pcActionConfirm(state.chatId, m.id, i) : await guia.pcActionCancel(state.chatId, m.id, i);
    if (r && r.ok === false) toast(r.error || 'Não deu certo.');
  }));
}

function checkpointHtml(cp) {
  const label = { A: 'criado', M: 'alterado', D: 'apagado' };
  const files = cp.files.map((f) => `<li>${esc(f.file)} <span class="muted">(${label[f.status] || f.status})</span></li>`).join('');
  return `<div class="checkpoint">
    ${cp.undone ? '↶ Desfeito: os arquivos voltaram a como estavam antes deste pedido.' : `💾 A IA mexeu em ${cp.count} ${cp.count === 1 ? 'arquivo' : 'arquivos'}. Não gostou?`}
    ${cp.undone ? '<button class="btn small" data-a="redo">↷ Refazer</button>' : '<button class="btn small" data-a="undo">↶ Desfazer</button>'}
    <details><summary>Ver arquivos</summary><ul>${files}</ul>${cp.count > cp.files.length ? `<span class="muted small">e mais ${cp.count - cp.files.length}…</span>` : ''}</details>
  </div>`;
}

async function undoMsg(m, kind) {
  try {
    const r = await call(kind === 'undo' ? guia.undo(state.chatId, m.id) : guia.redo(state.chatId, m.id));
    toast(kind === 'undo' ? `Pronto: ${r.files} ${r.files === 1 ? 'arquivo voltou' : 'arquivos voltaram'} a como estavam.` : 'Refeito.');
  } catch { /* toast já mostrou */ }
}

function scrollBottom(force) {
  const box = $('#messages');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

// ---------- Envio ----------
function updateSend() {
  const busy = state.chatId && isBusy(state.chatId);
  const empty = !$('#input').value.trim() && !state.attachments.length;
  $('#send').textContent = busy && empty ? 'Parar' : 'Enviar';
  $('#send').classList.toggle('danger', busy && empty);
}

async function send(textArg) {
  const input = $('#input');
  const text = (textArg ?? input.value).trim();
  if (!text && !state.attachments.length) {
    if (state.chatId && isBusy(state.chatId)) guia.cancel(state.chatId);
    return;
  }
  // Limpa o campo antes de esperar a conversa ser criada: um Enter duplo não manda o mesmo pedido duas vezes.
  const attachments = state.attachments;
  const images = attachments.map((a) => a.path);
  if (textArg === undefined) input.value = '';
  autosize();
  state.attachments = [];
  renderAttachments();
  const chat = await ensureChat().catch(() => null);
  if (!chat) {
    if (textArg === undefined && !input.value) input.value = text;
    state.attachments = attachments;
    renderAttachments();
    autosize();
    return;
  }
  const runId = uuid();
  const userMsg = { role: 'user', text: text || '(imagem)', images, at: Date.now() };
  state.chat.messages.push(userMsg);
  appendMessage(userMsg);
  const live = { id: runId, role: 'assistant', text: '', tools: [], route: null };
  state.lives.set(runId, { chatId: chat.id, msg: live });
  appendMessage({ ...live, id: runId });
  fillAssistant(findMsgEl(runId), live, true);
  markRunning(chat.id, runId, true);
  refreshChats();
  scrollBottom(true);
  $('#route-badge').hidden = true;
  const r = await guia.send(chat.id, { text: text || 'Veja a imagem anexada.', images, override: $('#model-select').value, fullAccess: $('#full-access').checked, runId });
  // Recusado antes de começar (conversa apagada, pedido já rodando na pasta...): não chega chat:done.
  if (r?.ok === false && state.lives.has(runId)) {
    state.lives.delete(runId);
    markRunning(chat.id, runId, false);
    fillAssistant(findMsgEl(runId), { ...live, error: r.error }, false);
    toast(r.error, 'error');
    refreshChats();
  }
}

$('#send').addEventListener('click', () => send());
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(220, t.scrollHeight)}px`;
}
let previewTimer;
$('#input').addEventListener('input', () => { autosize(); updateSend(); clearTimeout(previewTimer); previewTimer = setTimeout(previewRoute, 350); });
document.querySelectorAll('.chip[data-s]').forEach((c) => c.addEventListener('click', () => { $('#input').value = c.dataset.s; autosize(); previewRoute(); $('#input').focus(); }));
document.querySelector('.chip[data-plan]').addEventListener('click', () => { setView('plans'); newPlanForm(); });
document.querySelector('.chip[data-help]').addEventListener('click', () => setView('help'));

// Mostra para onde o pedido vai antes de enviar.
async function previewRoute() {
  const text = $('#input').value.trim();
  const badge = $('#route-badge');
  if (!text) { badge.hidden = true; return; }
  const r = await tryCall(guia.previewRoute(text, { chatId: state.chatId, hasImage: state.attachments.length > 0, override: $('#model-select').value }));
  if (!r) return;
  badge.hidden = false;
  badge.textContent = r.provider ? `→ ${r.modelLabel || r.model} · ${r.label}` : `⚠️ ${r.error}`;
  badge.title = (r.reasons || []).join('\n');
}

// ---------- Anexos ----------
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'att';
    d.innerHTML = `<img src="${a.preview || fileUrl(a.path)}" alt=""><button title="Tirar">✕</button>`;
    d.querySelector('button').addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachments(); updateSend(); });
    box.appendChild(d);
  });
}
$('#btn-screen').addEventListener('click', async () => {
  const shot = await tryCall(guia.captureScreen());
  if (shot) { state.attachments.push(shot); renderAttachments(); updateSend(); }
});
$('#btn-image').addEventListener('click', async () => {
  const files = (await tryCall(guia.pickImages())) || [];
  for (const p of files) state.attachments.push({ path: p });
  renderAttachments();
  updateSend();
});

// ---------- Eventos da IA ----------
guia.onRoute(({ chatId, runId, route }) => {
  const live = state.lives.get(runId);
  if (!live) return;
  live.msg.route = route;
  live.msg.provider = route.provider;
  live.msg.model = route.modelLabel || route.model;
  if (chatId === state.chatId) fillAssistant(findMsgEl(runId), live.msg, true);
});

let renderTimer = null;
guia.onEvent(({ chatId, runId, kind, text }) => {
  const live = state.lives.get(runId);
  if (!live) return;
  if (kind === 'delta') live.msg.text += text;
  if (kind === 'tool') live.msg.tools.push(text);
  if (chatId !== state.chatId || renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    // A resposta pode ter terminado nesses 120 ms: redesenhar "ao vivo" agora apagaria o que o fim mostrou
    // (botões de Confirmar, Desfazer...).
    if (!state.lives.has(runId)) return;
    fillAssistant(findMsgEl(runId), live.msg, true);
    scrollBottom();
  }, 120);
});

guia.onDone(async ({ chatId, runId, message }) => {
  state.lives.delete(runId);
  markRunning(chatId, runId, false);
  if (chatId === state.chatId && state.chat) {
    const i = state.chat.messages.findIndex((m) => m.id === runId);
    if (i >= 0) state.chat.messages[i] = message; else state.chat.messages.push(message);
    const el = findMsgEl(runId) || appendMessage(message);
    fillAssistant(el, message, false);
    scrollBottom();
    state.chat = (await tryCall(guia.getChat(chatId))) || state.chat;
    $('#chat-title').textContent = state.chat.title;
  }
  refreshChats();
  refreshQuota();
  if (state.view === 'plans') renderPlans();
});

guia.onMessage(({ chatId, message }) => {
  if (chatId !== state.chatId || !state.chat) return;
  const i = state.chat.messages.findIndex((m) => m.id === message.id);
  if (i >= 0) state.chat.messages[i] = message;
  fillAssistant(findMsgEl(message.id), message, false);
});

// ---------- Escolha da IA ----------
function fillModelSelect() {
  const sel = $('#model-select');
  const prev = sel.value || 'auto';
  const opts = ['<option value="auto">🤖 Automático (a Ohara escolhe)</option>'];
  for (const p of state.providers) {
    if (!p.ready) continue;
    opts.push(`<optgroup label="${esc(p.label)}">${p.tiers.map((t) => `<option value="${p.id}:${t.tier}">${esc(t.label)} · ${t.tierLabel}</option>`).join('')}</optgroup>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'auto';
}
$('#model-select').addEventListener('change', previewRoute);

// ======================= Cota na barra lateral =======================
function level(u) { return u >= 0.85 ? 'high' : u >= 0.6 ? 'mid' : ''; }
function quotaLines(p, l) {
  if (!l) return [];
  const out = [];
  if (l.fiveHour != null) out.push([`${p.label} · 5h`, l.fiveHour]);
  if (l.weekly != null) out.push([`${p.label} · semana`, l.weekly]);
  if (l.daily != null) out.push([`${p.label} · hoje (estimado)`, l.daily]);
  return out;
}
async function refreshQuota() {
  const u = await tryCall(guia.usage());
  if (!u) return;
  const box = $('#side-quota');
  const lines = [];
  for (const p of u.providers) {
    if (!p.ready) continue;
    if (p.id === 'ollama') { lines.push(`<div class="mini"><label><span>IA local</span><b>grátis</b></label></div>`); continue; }
    for (const [label, v] of quotaLines(p, u.limits[p.id])) {
      lines.push(`<div class="mini"><label><span>${esc(label)}</span><b>${pct(v)}</b></label><div class="bar"><i class="${level(v)}" data-css="width:${Math.min(100, v * 100)}%"></i></div></div>`);
    }
    if (!quotaLines(p, u.limits[p.id]).length) lines.push(`<div class="mini"><label><span>${esc(p.label)}</span><b class="muted">sem dados ainda</b></label></div>`);
  }
  const s = u.savingsWeek;
  box.innerHTML = `<h3>Cota das IAs</h3>${lines.join('') || '<span class="muted small">Nenhuma IA pronta.</span>'}
    ${s.calls ? `<div class="mini muted">Economia na semana: <b data-css="color:var(--ok)">${pct(s.ratio)}</b></div>` : ''}`;
}
guia.onUsage(() => refreshQuota());

// ======================= Planos =======================
async function renderPlans() {
  const plans = (await tryCall(guia.listPlans())) || [];
  const list = $('#plan-list');
  list.innerHTML = plans.length ? '' : '<p class="muted small">Nenhum plano ainda.</p>';
  for (const p of plans) {
    const d = document.createElement('div');
    d.className = `plan-item${p.id === state.planId ? ' active' : ''}`;
    d.innerHTML = `${esc(p.title)}<small>${p.done}/${p.total} etapas${p.cwd ? ` · ${esc(baseName(p.cwd))}` : ''}</small>`;
    d.addEventListener('click', () => { state.planId = p.id; renderPlans(); });
    list.appendChild(d);
  }
  if (state.planId && plans.some((p) => p.id === state.planId)) renderPlan(state.planId);
  else if (!$('#plan-detail').dataset.form) newPlanForm();
}

async function newPlanForm() {
  state.planId = null;
  document.querySelectorAll('.plan-item').forEach((i) => i.classList.remove('active'));
  const box = $('#plan-detail');
  box.dataset.form = '1';
  const { list = [] } = (await tryCall(guia.listProjects())) || {};
  const r = await tryCall(guia.previewRoute('planejar', { category: 'planejamento' }));
  box.innerHTML = `<div class="card">
    <h2>🗺️ Planejar uma ideia</h2>
    <p class="muted">Conte a ideia do seu jeito: o que quer criar, para quem, o que já tem. A Ohara monta um plano em etapas
      com um modelo forte${r?.modelLabel ? ` (agora: <b>${esc(r.modelLabel)}</b>)` : ''} e depois faz cada etapa com o modelo mais barato que resolve.</p>
    <textarea class="idea" id="plan-idea" placeholder="Ex.: quero um site para o escritório com página de contato e os serviços que a gente oferece. Não sei programar."></textarea>
    <div class="row" data-css="margin-top:10px">
      <label>Projeto (opcional)</label>
      <select id="plan-cwd"><option value="">Sem projeto ainda</option>${list.map((p) => `<option value="${esc(p.path)}">📂 ${esc(p.name)}</option>`).join('')}</select>
      <span data-css="flex:1"></span>
      <button class="btn primary" id="plan-go">Montar o plano</button>
    </div>
  </div>
  <div class="card muted small">
    Dicas: quanto mais contexto, melhor o plano. Diga o que você <b>não</b> quer também (ex.: "sem mensalidade", "nada de app de celular").
    Você pode pedir ajustes depois, e as etapas já feitas ficam guardadas.
  </div>`;
  box.querySelector('#plan-go').addEventListener('click', async () => {
    const idea = box.querySelector('#plan-idea').value;
    const cwd = box.querySelector('#plan-cwd').value || null;
    const btn = box.querySelector('#plan-go');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Montando o plano…';
    try {
      const plan = await call(guia.createPlan(idea, cwd));
      state.planId = plan.id;
      delete box.dataset.form;
      renderPlans();
    } catch {
      btn.disabled = false;
      btn.textContent = 'Montar o plano';
    }
  });
}
$('#plan-new').addEventListener('click', newPlanForm);

async function renderPlan(id) {
  const plan = await tryCall(guia.getPlan(id));
  const box = $('#plan-detail');
  delete box.dataset.form;
  if (!plan) { box.innerHTML = ''; return; }
  const TYPE = { codigo: '💻 programa', texto: '✍️ texto', pesquisa: '🔎 pesquisa', decisao: '🤔 decisão', tarefa: '🗂️ tarefa' };
  const next = plan.steps.find((s) => s.status === 'pendente');
  box.innerHTML = `
    <div class="card">
      <div class="row"><h2 data-css="flex:1;margin:0">${esc(plan.title)}</h2>
        ${plan.chatId ? '<button class="btn small" data-a="chat">💬 Conversa do plano</button>' : ''}
        <button class="btn small ghost danger" data-a="del">Apagar</button></div>
      ${plan.objective ? `<p><b>Objetivo:</b> ${esc(plan.objective)}</p>` : ''}
      ${plan.summary ? `<p class="muted">${esc(plan.summary)}</p>` : ''}
      <p class="muted small">Plano feito por ${esc(plan.madeBy || 'IA')}${plan.cwd ? ` · projeto <b>${esc(baseName(plan.cwd))}</b>` : ' · sem projeto (escolha uma pasta na conversa do plano se for criar arquivos)'}</p>
    </div>
    ${plan.steps.map((s, i) => `
      <div class="step ${s.status}" data-step="${s.id}">
        <div class="num">${s.status === 'feito' ? '✓' : i + 1}</div>
        <div class="txt"><b>${esc(s.title)}<span class="pill">${TYPE[s.type] || s.type}</span><span class="pill">${esc(s.size)}</span></b>
          <div>${esc(s.description)}</div>
          ${s.criteria ? `<div class="muted small">✔ Pronto quando: ${esc(s.criteria)}</div>` : ''}
          ${s.runAt ? `<div class="muted small">Executada ${new Date(s.runAt).toLocaleString('pt-BR')}</div>` : ''}</div>
        <div class="actions">
          ${s.status !== 'feito' ? `<button class="btn small ${next === s ? 'primary' : ''}" data-a="run">▶ Fazer esta etapa</button>` : ''}
          ${s.status !== 'feito' ? '<button class="btn small" data-a="done">✓ Marcar feita</button>' : '<button class="btn small ghost" data-a="reopen">Reabrir</button>'}
          ${s.status === 'pendente' ? '<button class="btn small ghost" data-a="skip">Pular</button>' : ''}
        </div>
      </div>`).join('')}
    ${plan.questions.length ? `<div class="card"><h2>🤔 Para você decidir</h2><ul>${plan.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    ${plan.risks.length ? `<div class="card"><h2>⚠️ Cuidados</h2><ul>${plan.risks.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><h2>✏️ Ajustar o plano</h2>
      <textarea class="idea" id="plan-fb" placeholder="Ex.: junta as etapas 2 e 3, e acrescenta uma etapa para colocar o site no ar."></textarea>
      <div class="row" data-css="justify-content:flex-end;margin-top:8px"><button class="btn" id="plan-revise">Refazer o plano com o ajuste</button></div>
    </div>`;
  box.querySelector('[data-a=chat]')?.addEventListener('click', () => openChat(plan.chatId));
  box.querySelector('[data-a=del]').addEventListener('click', async () => {
    const card = openModal(`<h2>Apagar o plano?</h2><p class="muted">A conversa do plano e os arquivos do projeto continuam.</p><div class="row" data-css="justify-content:flex-end"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="del-ok">Apagar</button></div>`);
    card.querySelector('#del-ok').addEventListener('click', async () => { closeModal(); await tryCall(guia.deletePlan(plan.id)); state.planId = null; renderPlans(); });
  });
  box.querySelectorAll('.step').forEach((el) => {
    const stepId = el.dataset.step;
    el.querySelector('[data-a=run]')?.addEventListener('click', async () => {
      const r = await tryCall(guia.runStep(plan.id, stepId));
      if (!r) return;
      await openChat(r.chatId);
      toast('Etapa enviada. Quando terminar, confira e marque como feita no plano.');
    });
    const mark = (status) => tryCall(guia.setStep(plan.id, stepId, { status })).then(() => renderPlans());
    el.querySelector('[data-a=done]')?.addEventListener('click', () => mark('feito'));
    el.querySelector('[data-a=reopen]')?.addEventListener('click', () => mark('pendente'));
    el.querySelector('[data-a=skip]')?.addEventListener('click', () => mark('pulado'));
  });
  box.querySelector('#plan-revise').addEventListener('click', async () => {
    const fb = box.querySelector('#plan-fb').value.trim();
    if (!fb) return toast('Escreva o ajuste que você quer.');
    const btn = box.querySelector('#plan-revise');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Refazendo…';
    try { await call(guia.revisePlan(plan.id, fb)); renderPlans(); } catch { btn.disabled = false; btn.textContent = 'Refazer o plano com o ajuste'; }
  });
}


// ======================= Uso e economia =======================
const MODE_INFO = {
  economia: ['💰 Economia', 'Sempre a IA mais barata que resolve. Recomendado.'],
  equilibrio: ['⚖️ Equilíbrio', 'Pesa custo e qualidade por igual.'],
  qualidade: ['🏆 Qualidade', 'Prefere o modelo mais forte, gasta mais cota.'],
};

async function renderUsage() {
  const u = await tryCall(guia.usage());
  if (!u) return;
  const body = $('#usage-body');
  const w = u.savingsWeek;
  const m = u.savingsMonth;
  const mode = state.config.orchestration?.mode || 'economia';
  const days = u.days.slice(-7);
  const callsOf = (d) => Object.values(d).reduce((a, p) => a + (p && typeof p === 'object' && 'calls' in p && p.byModel ? p.calls : 0), 0);
  const maxCalls = Math.max(1, ...days.map(callsOf));
  const provRows = u.providers.filter((p) => p.enabled).map((p) => {
    const t = u.today[p.id] || { calls: 0, input: 0, cached: 0, output: 0 };
    const lines = quotaLines(p, u.limits[p.id]);
    return `<tr><td><span class="tag ${p.id}">${esc(p.label)}</span> ${p.ready ? '' : '<span class="muted small">(não está pronta)</span>'}</td>
      <td>${t.calls}</td><td>${fmtNum(t.input + t.cached + t.output)}</td>
      <td>${p.id === 'ollama' ? 'grátis, sem limite' : lines.length ? lines.map(([l, v]) => `${esc(l.split(' · ')[1])}: <b>${pct(v)}</b>`).join(' · ') : '<span class="muted">aparece depois do primeiro uso</span>'}</td></tr>`;
  }).join('');
  body.innerHTML = `
    <div class="grid">
      <div class="card"><h2>Economia na semana</h2><div class="big ok">${pct(w.ratio)}</div>
        <p class="muted small">${w.calls} pedidos. Se tudo fosse no Claude Sonnet: <b>${usd(w.reference)}</b> · com a Ohara: <b>${usd(w.actual)}</b> (preço de API equivalente).</p></div>
      <div class="card"><h2>Últimos 30 dias</h2><div class="big">${usd(m.saved)}</div><p class="muted small">economizados em ${m.calls} pedidos (${pct(m.ratio)}).</p></div>
      <div class="card"><h2>Pedidos por dia</h2><div class="days">${days.map((d) => `<div><i data-css="height:${(callsOf(d) / maxCalls) * 70}px"></i>${esc(d.date.slice(8))}/${esc(d.date.slice(5, 7))}</div>`).join('')}</div></div>
    </div>
    <div class="card"><h2>Como a Ohara escolhe a IA</h2>
      <div class="seg" id="mode-seg">${Object.entries(MODE_INFO).map(([k, [l]]) => `<button data-mode="${k}" class="${k === mode ? 'active' : ''}">${l}</button>`).join('')}</div>
      <p class="muted">${esc(MODE_INFO[mode][1])} Em qualquer modo, quem já gastou mais da cota perde a vez, e se uma IA falhar a próxima assume sozinha.</p>
      <p class="muted small">Passe o mouse em "por quê?" em cada resposta para ver o motivo da escolha.</p>
    </div>
    <div class="card"><h2>Hoje, por IA</h2>
      <table class="simple"><tr><th>IA</th><th>Pedidos</th><th>Tokens</th><th>Cota</th></tr>${provRows}</table>
      <p class="muted small">Claude e Codex informam a cota de verdade. A do Gemini é estimada pelos pedidos do dia (limite em Ajustes). Os valores em US$ são só para comparar: as assinaturas não cobram por pedido.</p>
    </div>`;
  body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
    const saved = await tryCall(guia.setConfig({ orchestration: { mode: b.dataset.mode } }));
    if (!saved) return;
    state.config = saved;
    renderUsage();
    previewRoute();
  }));
}

// ======================= Primeiros passos =======================
async function renderHealth() {
  const body = $('#health-body');
  const h = state.health;
  if (!h || !h.checkedAt) { body.innerHTML = '<p class="muted"><span class="spin"></span> Verificando o seu PC…</p>'; return; }
  const icon = (i) => (i.ok ? '✅' : i.off ? '⏸️' : i.optional ? '💡' : '⚠️');
  const btn = (i) => {
    if (!i.fix) return '';
    if (i.fix.action === 'install') return `<button class="btn small primary" data-fix="${i.id}">Instalar</button>${i.fix.url ? ` <button class="btn small ghost" data-url="${esc(i.fix.url)}">Site</button>` : ''}`;
    if (i.fix.action === 'login') return `<button class="btn small primary" data-fix="${i.id}">Fazer login</button>`;
    return `<span class="muted small">${esc(i.fix.text || '')}</span>`;
  };
  const row = (i) => `<div class="check"><div class="icon">${icon(i)}</div><div class="txt"><b>${esc(i.label)}</b><span class="muted">${esc(i.detail)}</span>
    ${i.fix?.command ? `<div class="muted small">Comando: <code>${esc(i.fix.command)}</code></div>` : ''}</div><div>${btn(i)}</div></div>`;
  const base = h.items.filter((i) => i.group === 'base');
  const ias = h.items.filter((i) => i.group === 'ia');
  const readyIas = ias.filter((i) => i.ok).map((i) => i.label);
  const name = state.config.userName || '';
  body.innerHTML = `
    <div class="card"><h2>👋 Bem-vindo à Ohara${name ? `, ${esc(name)}` : ''}!</h2>
      <p>A Ohara junta as suas assinaturas de IA (Claude, ChatGPT/Codex, Gemini) e uma IA grátis no seu PC, e escolhe a mais barata que resolve cada pedido.
      Você precisa de <b>pelo menos uma IA pronta</b>. Quanto mais IAs, mais ela consegue economizar e repartir o trabalho.</p>
      <div class="row"><label for="hn">Como você quer ser chamado?</label><input type="text" id="hn" value="${esc(name)}" placeholder="Seu nome" /><button class="btn small" id="hn-save">Salvar</button></div>
    </div>
    <div class="card"><h2>1. Programas básicos</h2>${base.map(row).join('')}</div>
    <div class="card"><h2>2. Suas IAs</h2>${ias.map(row).join('')}
      <div class="hint" data-css="margin-top:10px">Ao clicar em <b>Instalar</b> ou <b>Fazer login</b>, abre uma janela preta (o terminal). Siga o que aparecer nela e,
      quando terminar, feche a janela e clique em <b>↻ Verificar de novo</b> aqui em cima.</div></div>
    <div class="card ohara-ai" id="ohara-ai-card"><h2>✨ Ohara-AI no seu PC</h2><p class="muted"><span class="spin"></span> Verificando…</p></div>
    <div class="card"><h2>3. Pronto?</h2>
      <p>${readyIas.length ? `IAs prontas: <b>${esc(readyIas.join(', '))}</b>.` : 'Nenhuma IA pronta ainda.'}</p>
      <button class="btn primary" id="start" ${readyIas.length ? '' : 'disabled'}>Começar a usar</button>
      <p class="muted small">Verificado ${new Date(h.checkedAt).toLocaleTimeString('pt-BR')}. A Ohara verifica de novo sozinha a cada 10 minutos.</p></div>`;
  body.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', async () => {
    const r = await tryCall(guia.fixHealth(b.dataset.fix));
    if (r) toast(r.hint ? `Abri o terminal. ${r.hint}` : 'Abri o terminal. Quando terminar, feche a janela e clique em "Verificar de novo".');
  }));
  body.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => guia.openExternal(b.dataset.url)));
  renderOharaAi();
  body.querySelector('#hn-save').addEventListener('click', async () => {
    const saved = await tryCall(guia.setConfig({ userName: body.querySelector('#hn').value.trim() }));
    if (!saved) return;
    state.config = saved;
    toast('Salvo.');
    greet();
  });
  body.querySelector('#start').addEventListener('click', async () => {
    const n = body.querySelector('#hn').value.trim();
    const saved = await tryCall(guia.setConfig({ onboarded: true, ...(n ? { userName: n } : {}) }));
    if (!saved) return;
    state.config = saved;
    greet();
    setView('help'); // primeira vez: mostra tudo o que ela faz
  });
}
// ---------- Ohara-AI: baixar o modelo local aqui dentro ----------
// O modelo só escolhe a ferramenta; quem lê e faz coisas no PC é o app (com confirmação para o arriscado).
let oharaAiProgress = null; // { id, percent, status, completedGB, totalGB } durante o download
const PULL_STATUS = (st) => (/manifest/.test(st) && !/writing/.test(st) ? 'preparando' : /verifying/.test(st) ? 'conferindo' : /writing|success/.test(st) ? 'finalizando' : 'baixando');

function oharaAiProgressHtml() {
  const p = oharaAiProgress;
  if (!p) return '';
  const pct = p.percent == null ? '' : ' ' + p.percent + '%';
  const size = p.totalGB ? ' (' + p.completedGB + ' de ' + p.totalGB + ' GB)' : '';
  return '<progress id="oa-progress" max="100"' + (p.percent == null ? '' : ' value="' + p.percent + '"') + '></progress>'
    + '<div class="muted small" id="oa-progress-txt">' + esc(PULL_STATUS(p.status || '')) + pct + size + '</div>';
}

async function renderOharaAi() {
  const box = $('#ohara-ai-card');
  if (!box) return;
  const r = await guia.oharaAiStatus();
  if (!r?.ok) { box.innerHTML = '<h2>✨ Ohara-AI no seu PC</h2><p class="muted">Não consegui verificar agora (' + esc(r?.error || 'erro') + ').</p>'; return; }
  const st = r.data;
  const hw = st.hardware || {};
  const busy = !!oharaAiProgress;
  const rows = st.models.map((m) => {
    const rec = m.id === st.recommended.id;
    let right;
    if (m.installed) right = st.current === m.id ? '<span class="muted">✅ em uso</span>' : '<button class="btn small" data-oa-use="' + esc(m.id) + '">Usar esta</button>';
    else if (busy && oharaAiProgress.id === m.id) right = '<button class="btn small" data-oa-cancel>Cancelar</button>';
    else right = '<button class="btn small' + (rec ? ' primary' : '') + '" data-oa-dl="' + esc(m.id) + '"' + (st.ollama && !busy ? '' : ' disabled') + '>Baixar (' + m.sizeGB + ' GB)</button>';
    return '<div class="model"><span class="name"><b>' + esc(m.label) + '</b>' + (rec ? ' <span class="rec">recomendada para este PC</span>' : '')
      + '<br><span class="muted small">' + esc(m.note) + (m.fits ? '' : ' · deve ficar lenta neste PC') + '</span></span>' + right + '</div>';
  }).join('');
  box.innerHTML = '<h2>✨ Ohara-AI no seu PC</h2>'
    + '<p>Uma IA grátis que roda no seu computador: <b>lê e faz coisas no PC</b> (volume, música, print, lembretes, achar e ler arquivos, '
    + 'fechar programas, limpar espaço, desligar). O que é arriscado sempre pede o seu <b>Confirmar</b> antes. Seus dados não saem do PC.</p>'
    + (st.ollama ? '' : '<p class="error">Primeiro instale o Ollama (item "IA local" acima) e clique em ↻ Verificar de novo.</p>')
    + (st.ready ? '<p>✅ Pronta. É só pedir no chat, por exemplo: "abaixa o volume", "acha o contrato nos downloads", "me lembra de ligar pro João em 20 minutos".</p>' : '')
    + '<p class="muted small">Seu PC: ' + (hw.ramGB || '?') + ' GB de memória' + (hw.vramGB ? ' · placa de vídeo com ' + hw.vramGB + ' GB' : ' · sem placa de vídeo dedicada') + '.</p>'
    + '<div class="models">' + rows + '</div><div id="oa-progress-box">' + oharaAiProgressHtml() + '</div>';
  box.querySelectorAll('[data-oa-dl]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.oaDl;
    oharaAiProgress = { id, percent: null, status: 'pulling manifest' };
    renderOharaAi();
    const res = await guia.oharaAiDownload(id);
    oharaAiProgress = null;
    if (res?.ok) {
      state.config = await call(guia.getConfig()).catch(() => state.config);
      toast('Ohara-AI pronta! Já pode pedir no chat.');
    } else toast(res?.error || 'O download não terminou.');
    renderOharaAi();
  }));
  box.querySelector('[data-oa-cancel]')?.addEventListener('click', () => guia.oharaAiCancel());
  box.querySelectorAll('[data-oa-use]').forEach((b) => b.addEventListener('click', async () => {
    const saved = await tryCall(guia.setConfig({ ollama: { model: b.dataset.oaUse } }));
    if (saved) { state.config = saved; toast('Pronto: a Ohara-AI agora usa ' + b.dataset.oaUse + '.'); }
    renderOharaAi();
  }));
}

// Progresso: só a barra muda (redesenhar o cartão a cada evento faria os botões piscarem).
guia.onOharaAiProgress((p) => {
  oharaAiProgress = p;
  const bar = $('#oa-progress');
  const txt = $('#oa-progress-txt');
  if (!bar || !txt) { const box = $('#oa-progress-box'); if (box) box.innerHTML = oharaAiProgressHtml(); return; }
  if (p.percent == null) bar.removeAttribute('value'); else bar.value = p.percent;
  txt.textContent = PULL_STATUS(p.status || '') + (p.percent == null ? '' : ' ' + p.percent + '%') + (p.totalGB ? ' (' + p.completedGB + ' de ' + p.totalGB + ' GB)' : '');
});

$('#health-recheck').addEventListener('click', async () => {
  $('#health-body').innerHTML = '<p class="muted"><span class="spin"></span> Verificando…</p>';
  await tryCall(guia.checkHealth());
});

function applyHealth(h) {
  state.health = h;
  const missing = h.items.filter((i) => !i.ok && !i.off && !i.optional).length;
  const b = $('#health-badge');
  b.hidden = !!h.available.length || !missing;
  b.textContent = '!';
  tryCall(guia.providers()).then((p) => { state.providers = p || []; fillModelSelect(); refreshQuota(); });
  if (state.view === 'health') renderHealth();
}
guia.onHealth(applyHealth);

// ======================= Ajustes =======================
async function renderSettings() {
  const c = state.config;
  const info = (await tryCall(guia.info())) || {};
  const login = (await tryCall(guia.loginItem())) || {};
  const prov = state.providers;
  const body = $('#settings-body');
  body.innerHTML = `
    <div class="card"><h2>Você</h2>
      <div class="row"><label>Nome</label><input type="text" id="s-name" value="${esc(c.userName || '')}" /></div>
      <div class="row" data-css="margin-top:8px"><label>Pasta dos projetos</label><input type="text" id="s-pdir" value="${esc(c.projectsDir)}" data-css="flex:1" /><button class="btn small" id="s-pick">Escolher…</button></div>
    </div>
    <div class="card"><h2>IAs</h2>
      ${prov.map((p) => `<div class="row" data-css="padding:4px 0"><label><input type="checkbox" data-prov="${p.id}" ${p.enabled ? 'checked' : ''}/> ${esc(p.label)} <span class="muted small">${esc(p.vendor)}</span></label>
        <span class="muted small" data-css="flex:1">${esc(p.help)}</span></div>`).join('')}
      <div class="row" data-css="margin-top:8px"><label>Pedidos por dia no Gemini</label><input type="number" id="s-gem" min="10" step="10" value="${esc(c.providers?.gemini?.dailyRequests ?? 1000)}" data-css="width:110px" /><span class="muted small">limite usado para estimar a cota grátis</span></div>
      <div class="row" data-css="margin-top:8px"><label>Modelo da IA local</label><input type="text" id="s-ollama" value="${esc(c.ollama?.model || '')}" data-css="width:180px" /><span class="muted small">ex.: qwen2.5:7b (leve) ou qwen2.5:14b (melhor, precisa de mais memória)</span></div>
    </div>
    <div class="card"><h2>Segurança</h2>
      <label class="row"><input type="checkbox" id="s-cp" ${c.safety?.checkpoints !== false ? 'checked' : ''}/> Pontos de restauração (botão Desfazer) antes de cada pedido num projeto</label>
      <label class="row"><input type="checkbox" id="s-ex" ${c.safety?.explain !== false ? 'checked' : ''}/> Explicar no fim o que foi feito, sem jargão</label>
    </div>
    <div class="card"><h2>Aplicativo</h2>
      <label class="row"><input type="checkbox" id="s-login" ${login.enabled ? 'checked' : ''} ${login.available ? '' : 'disabled'}/> Iniciar com o Windows ${login.available ? '' : '<span class="muted small">(só no app instalado)</span>'}</label>
      <div class="row" data-css="margin-top:8px"><button class="btn small" id="s-update">Verificar atualizações</button><span class="muted small" id="s-update-st"></span></div>
      <p class="muted small">Versão ${esc(info.version)} · dados em ${esc(info.dataDir)} · atalho para abrir: ${esc(c.hotkeys?.toggle || '')}</p>
    </div>
    <div class="row" data-css="justify-content:flex-end"><button class="btn primary" id="s-save">Salvar ajustes</button></div>`;
  body.querySelector('#s-pick').addEventListener('click', async () => {
    const d = await tryCall(guia.pickFolder());
    if (d) body.querySelector('#s-pdir').value = d;
  });
  body.querySelector('#s-login').addEventListener('change', (e) => guia.loginItem(e.target.checked));
  body.querySelector('#s-update').addEventListener('click', async () => {
    const st = await tryCall(guia.updateCheck());
    body.querySelector('#s-update-st').textContent = st?.status === 'unsupported' ? 'Só no app instalado.' : st?.status === 'idle' ? 'Você já está na versão mais nova.' : st?.status === 'error' ? `Não consegui verificar (${st.message || 'sem internet?'}).` : 'Baixando a versão nova…';
  });
  body.querySelector('#s-save').addEventListener('click', async () => {
    const providers = {};
    body.querySelectorAll('[data-prov]').forEach((cb) => { providers[cb.dataset.prov] = { enabled: cb.checked }; });
    providers.gemini = { ...providers.gemini, dailyRequests: Math.max(10, Number(body.querySelector('#s-gem').value) || 1000) };
    const saved = await tryCall(guia.setConfig({
      userName: body.querySelector('#s-name').value.trim(),
      projectsDir: body.querySelector('#s-pdir').value.trim() || c.projectsDir,
      providers,
      ollama: { model: body.querySelector('#s-ollama').value.trim() || c.ollama.model },
      safety: { checkpoints: body.querySelector('#s-cp').checked, explain: body.querySelector('#s-ex').checked },
    }));
    if (!saved) return;
    state.config = saved;
    toast('Ajustes salvos. Verificando as IAs de novo…');
    greet();
    syncProjectSelect();
  });
}

// ======================= Atualização =======================
function showUpdate(s) {
  const b = $('#update-banner');
  if (!s || !['downloading', 'ready'].includes(s.status)) { b.hidden = true; return; }
  b.hidden = false;
  $('#update-text').textContent = s.status === 'ready' ? `Versão ${s.version} pronta.` : `Baixando a versão ${s.version || 'nova'}… ${s.percent || 0}%`;
  $('#update-install').hidden = s.status !== 'ready';
}
$('#update-install').addEventListener('click', () => guia.updateInstall());
guia.onUpdate(showUpdate);

// ======================= Início =======================
function greet() {
  const n = state.config?.userName;
  $('#hello').textContent = n ? `Oi, ${n}! O que vamos criar hoje?` : 'O que vamos criar hoje?';
}

(async function init() {
  const info = await tryCall(guia.info());
  $('#app-version').textContent = info ? `v${info.version}` : '';
  state.config = await tryCall(guia.getConfig());
  greet();
  showUpdate(await tryCall(guia.updateState()));
  const h = await tryCall(guia.health());
  if (h) applyHealth(h);
  await refreshChats();
  await syncProjectSelect();
  setView(state.config?.onboarded ? 'chat' : 'health');
  updateSend();
})();
