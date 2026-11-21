/* global central, renderMarkdown */
const $ = (sel) => document.querySelector(sel);

const state = {
  chatId: null,
  chat: null,
  attachments: [], // { path, preview }
  running: new Map(), // chatId -> Set(runId): agentes rodando em cada conversa
  config: null,
  lives: new Map(), // runId -> { chatId, wrap, msg }: respostas em andamento nesta janela
};

const isBusy = (chatId) => (state.running.get(chatId)?.size || 0) > 0;
function markRunning(chatId, runId, on) {
  if (!state.running.has(chatId)) state.running.set(chatId, new Set());
  const set = state.running.get(chatId);
  if (on) set.add(runId);
  else set.delete(runId);
  if (!set.size) state.running.delete(chatId);
}

// Ao reabrir uma conversa, religa as respostas em andamento aos novos elementos da tela.
function relinkLives() {
  for (const [runId, live] of state.lives) {
    if (live.chatId !== state.chatId) continue;
    const wrap = el.messages.querySelector(`.msg[data-id="${runId}"]`);
    if (!wrap) continue;
    live.wrap = wrap;
    fillAssistant(wrap, live.msg, { live: true });
  }
}

const el = {
  list: $('#chat-list'),
  messages: $('#messages'),
  empty: $('#empty'),
  input: $('#input'),
  send: $('#send'),
  title: $('#chat-title'),
  cwd: $('#cwd-select'),
  model: $('#model-select'),
  badge: $('#route-badge'),
  attachments: $('#attachments'),
  fullAccess: $('#full-access'),
  speak: $('#speak-replies'),
};

// Codifica cada pedaço do caminho: nomes com espaço, # ou ? não quebram a URL da imagem.
const fileUrl = (p) => `file:///${String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  .map((seg, i) => (i === 0 && /^[a-z]:$/i.test(seg) ? seg : encodeURIComponent(seg))).join('/')}`;
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));

function providerTag(msg) {
  const name = { codex: 'Codex', local: 'Ohara', ollama: 'Ohara-AI', orca: 'Orca' }[msg.provider] || 'Claude';
  return `<span class="tag ${msg.provider}">${name} · ${escapeHtml(msg.model || '')}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Conversas ----------
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
  for (const id of ids) await central.deleteChat(id);
  if (ids.includes(state.chatId)) {
    state.chatId = null;
    state.chat = null;
    renderMessages();
    el.title.textContent = 'Nova conversa';
  }
  updateDeleteButton();
  refreshList();
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
  refreshList();
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

async function refreshList() {
  const chats = await central.listChats();
  el.list.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    const picked = state.selected.has(c.id);
    item.className = `chat-item${c.id === state.chatId ? ' active' : ''}${state.selecting ? ' selecting' : ''}${picked ? ' picked' : ''}`;
    const busy = isBusy(c.id) ? `⏳${state.running.get(c.id).size > 1 ? state.running.get(c.id).size : ''} ` : '';
    item.innerHTML = state.selecting
      ? `<input type="checkbox" class="pick" ${picked ? 'checked' : ''} aria-label="Marcar" /><span title="${escapeHtml(c.cwd)}">${busy}${escapeHtml(c.title)}</span>`
      : `<span title="${escapeHtml(c.cwd)}">${busy}${escapeHtml(c.title)}</span><button class="del" title="Apagar conversa">✕</button>`;
    item.addEventListener('click', () => {
      if (!state.selecting) return openChat(c.id);
      if (state.selected.has(c.id)) state.selected.delete(c.id);
      else state.selected.add(c.id);
      updateBulkBar();
      refreshList();
    });
    item.querySelector('.del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      armDelete(e.currentTarget, () => deleteChats([c.id]), 'Apagar?');
    });
    el.list.appendChild(item);
  }
}

async function openChat(id) {
  state.chatId = id;
  const chat = await central.getChat(id);
  if (state.chatId !== id) return; // clicou em outra conversa enquanto esta carregava
  state.chat = chat;
  renderMessages();
  relinkLives();
  syncCwdSelect();
  refreshList();
  updateSendButton();
  el.input.focus();
}

// Uma só criação por vez: dois envios seguidos numa conversa nova não criam duas conversas.
let creatingChat = null;
function ensureChat() {
  if (state.chatId) return Promise.resolve(state.chat);
  creatingChat ||= central.createChat(el.cwd.value || state.config.defaultCwd).then((chat) => {
    state.chatId = chat.id;
    state.chat = chat;
    refreshList();
    return chat;
  }).finally(() => { creatingChat = null; });
  return creatingChat;
}

// ---------- Mensagens ----------
function renderMessages() {
  el.messages.querySelectorAll('.msg').forEach((n) => n.remove());
  const msgs = state.chat?.messages || [];
  el.empty.hidden = msgs.length > 0;
  el.title.textContent = state.chat?.title || 'Nova conversa';
  updateDeleteButton();
  for (const m of msgs) appendMessage(m);
  scrollBottom(true);
}

function appendMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  if (m.id) wrap.dataset.id = m.id;
  if (m.role === 'user') {
    const imgs = (m.images || []).map((p) => `<img src="${fileUrl(p)}" alt="">`).join('');
    wrap.innerHTML = `${imgs ? `<div class="imgs">${imgs}</div>` : ''}<div class="bubble"></div>`;
    wrap.querySelector('.bubble').textContent = m.text;
  } else {
    wrap.innerHTML = `<div class="meta"></div><div class="tools"></div><div class="bubble"></div>`;
    fillAssistant(wrap, m);
  }
  el.messages.appendChild(wrap);
  return wrap;
}

function fillAssistant(wrap, m, { live = false } = {}) {
  const meta = wrap.querySelector('.meta');
  const reasons = (m.route?.reasons || []).join(' · ');
  const tokens = m.tokens ? `${fmtNum((m.tokens.input || 0) + (m.tokens.cached || 0))} in · ${fmtNum(m.tokens.output)} out` : '';
  const wa = m.whatsapp
    ? m.whatsapp.sent
      ? '<span title="Enviado para o seu WhatsApp">📱 enviado</span>'
      : `<span class="bad" title="${escapeHtml(m.whatsapp.error || '')}">📱 não enviado</span>`
    : '';
  const par = m.parallel ? '<span class="tag parallel" title="Rodou ao mesmo tempo que outra tarefa desta conversa">⫽ paralelo</span>' : '';
  meta.innerHTML = `${providerTag(m)}${par}<span title="${escapeHtml(reasons)}">${escapeHtml(m.route?.label || '')}</span>${tokens ? `<span>${tokens}</span>` : ''}${wa}${
    live ? '' : '<button class="act" data-a="copy" title="Copiar">⧉</button><button class="act" data-a="speak" title="Ler em voz alta">🔊</button>'
  }`;
  meta.querySelector('[data-a=copy]')?.addEventListener('click', () => navigator.clipboard.writeText(m.text || ''));
  meta.querySelector('[data-a=speak]')?.addEventListener('click', () => central.speak(m.text || ''));


  const tools = wrap.querySelector('.tools');
  const list = m.tools || [];
  if (list.length > 6 && !live) {
    tools.innerHTML = `<details><summary>${list.length} ações executadas</summary>${list.map((t) => `<div>${escapeHtml(t)}</div>`).join('')}</details>`;
  } else {
    tools.innerHTML = list.map((t) => `<div>${escapeHtml(t)}</div>`).join('');
  }

  const bubble = wrap.querySelector('.bubble');
  bubble.classList.toggle('error', !!m.error && !m.text);
  if (live && !m.text) {
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  } else {
    bubble.innerHTML = renderMarkdown(m.text || (m.error ? `⚠️ ${m.error}` : ''));
    if (m.error && m.text) bubble.insertAdjacentHTML('beforeend', `<p class="error">⚠️ ${escapeHtml(m.error)}</p>`);
    bubble.querySelectorAll('pre .copy').forEach((b) =>
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(b.nextElementSibling.textContent);
        b.textContent = 'copiado';
        setTimeout(() => (b.textContent = 'copiar'), 1200);
      }),
    );
  }

  if (!live) renderImprovementOffer(wrap, m);
  if (!live) renderPcActions(wrap, m);
}

// Ações da Ohara-AI no PC que esperam confirmação (fechar programa, apagar, desligar...).
// O botão só diz qual item confirmar: o que roda é o que ficou guardado na mensagem.
const PC_ACTION_LABEL = { pending: '', running: 'fazendo…', done: '✓ feito', error: '⚠️ falhou', cancelled: 'cancelada', expired: 'expirou' };
function renderPcActions(wrap, m) {
  wrap.querySelector('.pc-actions')?.remove();
  if (!m.pcActions?.length) return;
  const box = document.createElement('div');
  box.className = 'pc-actions';
  box.innerHTML = m.pcActions
    .map((a, i) => {
      const pending = a.status === 'pending';
      const detail = a.status === 'done' ? a.result : a.status === 'error' ? a.error : '';
      return `<div class="pc-action ${escapeHtml(a.status)}" data-i="${i}">
        <span class="what">⚙️ ${escapeHtml(a.resumo)}</span>
        ${pending ? '<button class="btn small-btn primary" data-a="ok">Confirmar</button><button class="btn small-btn" data-a="no">Cancelar</button>' : `<span class="state">${escapeHtml(PC_ACTION_LABEL[a.status] || a.status)}${detail ? ` · ${escapeHtml(detail)}` : ''}</span>`}
      </div>`;
    })
    .join('');
  box.querySelectorAll('.pc-action').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('[data-a=ok]')?.addEventListener('click', async (e) => {
      // Só clique de verdade (mouse/teclado): clique gerado por script não confirma ação no PC.
      if (!e.isTrusted) return;
      e.target.disabled = true;
      const r = await central.pcActionConfirm(state.chatId, m.id, i);
      if (!r?.ok) row.querySelector('.what').insertAdjacentHTML('afterend', `<span class="state">⚠️ ${escapeHtml(r?.error || 'falhou')}</span>`);
    });
    row.querySelector('[data-a=no]')?.addEventListener('click', () => central.pcActionCancel(state.chatId, m.id, i));
  });
  wrap.appendChild(box);
}

// Ela se ofereceu para se alterar: um clique aceita (o mesmo que responder "sim").
function renderImprovementOffer(wrap, m) {
  wrap.querySelector('.improve-offer')?.remove();
  const last = state.chat?.messages?.[state.chat.messages.length - 1];
  if (!m.improvementOffer || (last && last.id && last.id !== m.id)) return;
  const box = document.createElement('div');
  box.className = 'improve-offer';
  box.innerHTML = `<span>✨ Posso me alterar para: <b>${escapeHtml(m.improvementOffer)}</b></span><button class="btn small-btn primary">Sim, pode se alterar</button>`;
  box.querySelector('button').addEventListener('click', () => {
    box.remove();
    el.input.value = 'Sim, pode se alterar.';
    sendMessage();
  });
  wrap.appendChild(box);
}

function scrollBottom(force = false) {
  const m = el.messages;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}

// ---------- Envio ----------
// Pode enviar a qualquer momento: se já houver uma tarefa rodando, a nova vira outro agente, em paralelo.
// Com o campo vazio e algo rodando, o botão vira "Parar" (para todos os agentes da conversa).
async function sendMessage() {
  const text = el.input.value.trim();
  if (!text) return;

  // Limpa o campo antes de esperar: um Enter duplo não manda o mesmo pedido duas vezes.
  const attachments = state.attachments;
  el.input.value = '';
  state.attachments = [];
  let chat;
  try {
    chat = await ensureChat();
  } catch (err) {
    if (!el.input.value) el.input.value = text;
    state.attachments = attachments;
    renderAttachments();
    throw err;
  }
  const images = attachments.map((a) => a.path);
  const runId = crypto.randomUUID();
  const parallel = isBusy(chat.id);
  const userMsg = { role: 'user', text, images };
  chat.messages.push(userMsg);
  el.empty.hidden = true;
  appendMessage(userMsg);

  const liveMsg = { id: runId, role: 'assistant', text: '', tools: [], provider: 'claude', model: '…', route: null, parallel };
  chat.messages.push(liveMsg);
  const wrap = appendMessage(liveMsg);
  state.lives.set(runId, { chatId: chat.id, wrap, msg: liveMsg });
  fillAssistant(wrap, liveMsg, { live: true });
  scrollBottom(true);

  el.input.value = '';
  autosize();
  state.attachments = [];
  renderAttachments();
  el.badge.hidden = true;

  markRunning(chat.id, runId, true);
  updateSendButton();
  refreshList();

  const res = await central.send(chat.id, {
    text,
    images,
    runId,
    override: el.model.value,
    permissionMode: el.fullAccess.checked ? 'bypassPermissions' : undefined,
  });

  if (res?.error && !res.role) {
    // Falhou antes de começar (não houve "chat:done").
    markRunning(chat.id, runId, false);
    const live = state.lives.get(runId);
    state.lives.delete(runId);
    liveMsg.error = res.error;
    if (live && state.chatId === chat.id) fillAssistant(live.wrap, liveMsg);
    updateSendButton();
  }
  refreshList();
}

function updateSendButton() {
  const busy = isBusy(state.chatId) && !el.input.value.trim();
  el.send.textContent = busy ? 'Parar' : 'Enviar';
  el.send.classList.toggle('stop', busy);
}

central.onRoute(({ chatId, runId, route }) => {
  const live = state.lives.get(runId);
  if (!live) return;
  Object.assign(live.msg, { provider: route.provider, model: route.model, route });
  // O roteador pode ter levado a conversa para a pasta do projeto citado.
  if (route.project && state.chat?.id === chatId && (state.chat.messages?.length || 0) <= 2) {
    state.chat.cwd = route.project.path;
    syncCwdSelect();
  }
  if (state.chatId === chatId) fillAssistant(live.wrap, live.msg, { live: true });
});

const dirty = new Set();
let renderPending = false;
central.onEvent(({ chatId, runId, kind, text }) => {
  const live = state.lives.get(runId);
  if (!live) return;
  const m = live.msg;
  if (kind === 'delta') m.text += text;
  if (kind === 'tool') m.tools.push(text);
  if (state.chatId !== chatId) return;
  dirty.add(runId);
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      for (const id of dirty) {
        const l = state.lives.get(id);
        if (l && l.chatId === state.chatId) fillAssistant(l.wrap, l.msg, { live: true });
      }
      dirty.clear();
      scrollBottom();
    });
  }
});

central.onDone(async ({ chatId, runId, message, source }) => {
  markRunning(chatId, runId, false);
  updateSendButton();
  const live = state.lives.get(runId);
  state.lives.delete(runId);
  if (live) {
    Object.assign(live.msg, message);
    if (chatId === state.chatId) {
      fillAssistant(live.wrap, live.msg);
      scrollBottom();
      const fresh = await central.getChat(chatId);
      if (fresh) el.title.textContent = fresh.title; // a conversa pode ter sido apagada enquanto rodava
    }
  } else if (chatId === state.chatId) {
    // Terminou uma conversa que foi reaberta no meio da execução.
    state.chat = await central.getChat(chatId);
    renderMessages();
  }
  if (source === 'quick') return refreshList(); // a janela rápida mostra a resposta
  if (el.speak.checked && message.text) central.speak(message.text);
  if (document.hidden || !document.hasFocus()) {
    new Notification('Ohara', { body: (message.text || message.error || 'Tarefa concluída').slice(0, 140) });
  }
  refreshList();
});

// ---------- Prévia da rota ----------
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const text = el.input.value.trim();
    if (!text) { el.badge.hidden = true; return; }
    const r = await central.previewRoute(text, { hasImage: state.attachments.length > 0, override: el.model.value, chatId: state.chatId });
    const name = { codex: 'Codex', local: 'Ohara', ollama: 'Ohara-AI', orca: 'Orca' }[r.provider] || 'Claude';
    el.badge.innerHTML = `→ <b class="${r.provider}">${name} ${escapeHtml(r.model)}</b> · ${escapeHtml(r.label)}${r.reasons.length > 1 ? ` · ${escapeHtml(r.reasons.slice(1).join(' · '))}` : ''}`;
    el.badge.title = r.reasons.join('\n');
    el.badge.hidden = false;
  }, 250);
}

// ---------- Anexos ----------
function renderAttachments() {
  el.attachments.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'att';
    d.innerHTML = `<img src="${a.preview || fileUrl(a.path)}" alt=""><button title="Remover">✕</button>`;
    d.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachments();
      schedulePreview();
    });
    el.attachments.appendChild(d);
  });
}

$('#btn-screen').addEventListener('click', async () => {
  try {
    const shot = await central.captureScreen();
    state.attachments.push(shot);
    renderAttachments();
    schedulePreview();
  } catch (err) {
    alertInline(`Não consegui capturar a tela: ${err.message}`);
  }
});

$('#btn-image').addEventListener('click', async () => {
  const files = await central.pickImages();
  files.forEach((p) => state.attachments.push({ path: p }));
  renderAttachments();
  schedulePreview();
});

// 🎤 Ditado: grava, o Whisper transcreve e o texto entra no campo para você revisar e enviar.
// Nunca envia sozinho. Sem o Whisper instalado, abre o ditado do Windows (Win+H).
let recording = null;
$('#btn-voice').addEventListener('click', async () => {
  const btn = $('#btn-voice');
  if (recording) {
    recording.stop();
    return;
  }
  const ws = await central.whisperStatus();
  if (!ws.installed) {
    el.input.focus();
    central.dictate();
    return;
  }
  try {
    recording = await Voice.record({ onLevel: (l) => (btn.style.boxShadow = `0 0 0 ${Math.round(l * 6)}px rgba(255,92,122,.5)`) });
    btn.classList.add('rec');
    btn.title = 'Gravando… clique para parar';
    const bytes = await recording.done;
    btn.classList.remove('rec');
    btn.style.boxShadow = '';
    btn.title = 'Ditar: fale e o texto aparece aqui para você revisar e enviar';
    recording = null;
    if (!bytes) return toast('Não ouvi nada.');
    btn.textContent = '⏳';
    const text = await Voice.transcribe(bytes);
    btn.textContent = '🎤';
    if (!text) return toast('Não consegui entender o áudio.');
    el.input.value = (el.input.value ? `${el.input.value} ` : '') + text;
    autosize();
    schedulePreview();
    el.input.focus();
  } catch (err) {
    recording = null;
    btn.textContent = '🎤';
    btn.classList.remove('rec');
    btn.style.boxShadow = '';
    toast(`Voz: ${err.message}`, 'error');
  }
});

function alertInline(text) {
  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = `<div class="bubble error">⚠️ ${escapeHtml(text)}</div>`;
  el.messages.appendChild(d);
  scrollBottom(true);
}

// ---------- Pasta de trabalho ----------
async function loadRepos() {
  const repos = await central.listRepos();
  const opts = [state.config.defaultCwd, state.config.workspaceRoot, ...repos];
  el.cwd.innerHTML = '';
  for (const p of [...new Set(opts)]) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p.replace(state.config.workspaceRoot, '…') || p;
    el.cwd.appendChild(o);
  }
  const pick = document.createElement('option');
  pick.value = '__pick__';
  pick.textContent = 'Escolher outra pasta…';
  el.cwd.appendChild(pick);
}

function syncCwdSelect() {
  const cwd = state.chat?.cwd || state.config.defaultCwd;
  if (![...el.cwd.options].some((o) => o.value === cwd)) {
    const o = document.createElement('option');
    o.value = cwd;
    o.textContent = cwd;
    el.cwd.insertBefore(o, el.cwd.lastElementChild);
  }
  el.cwd.value = cwd;
}

el.cwd.addEventListener('change', async () => {
  if (el.cwd.value === '__pick__') {
    const p = await central.pickFolder();
    if (!p) return syncCwdSelect();
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    el.cwd.insertBefore(o, el.cwd.lastElementChild);
    el.cwd.value = p;
  }
  if (state.chatId) {
    await central.setCwd(state.chatId, el.cwd.value);
    state.chat.cwd = el.cwd.value;
  }
});

// ---------- Uso ----------
function setMeter(key, value, resetsAt) {
  const m = document.querySelector(`.meter[data-key="${key}"]`);
  const bar = m.querySelector('i');
  if (value == null) {
    m.querySelector('b').textContent = '—';
    bar.style.width = '0';
    m.querySelector('small').textContent = 'sem dados ainda';
    return;
  }
  const pct = Math.round(value * 100);
  m.querySelector('b').textContent = `${pct}%`;
  bar.style.width = `${Math.min(100, pct)}%`;
  bar.className = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  m.querySelector('small').textContent = resetsAt ? `renova ${fmtReset(resetsAt)}` : '';
}

function fmtReset(sec) {
  const d = new Date(sec * 1000);
  const diffH = (d - Date.now()) / 36e5;
  if (diffH < 0) return 'já renovou';
  if (diffH < 24) return `em ${diffH < 1 ? `${Math.round(diffH * 60)} min` : `${diffH.toFixed(1)} h`}`;
  return d.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// Codex desligado nos Ajustes: some do menu de modelos e dos medidores de cota.
function applyCodex() {
  const on = state.config?.codex?.enabled === true;
  for (const o of el.model.querySelectorAll('option[value^="codex"]')) { o.hidden = !on; o.disabled = !on; }
  if (!on && el.model.value.startsWith('codex')) el.model.value = 'auto';
  for (const m of document.querySelectorAll('.meter[data-key^="codex"]')) m.hidden = !on;
}
central.onConfigChanged((cfg) => { state.config = cfg; applyCodex(); });

function renderUsage(u) {
  const c = u.limits.claude || {};
  const x = u.limits.codex || {};
  setMeter('claude-5h', c.fiveHour, c.fiveHourResetsAt);
  setMeter('claude-7d', c.weekly, c.weeklyResetsAt);
  setMeter('codex-5h', x.fiveHour, x.fiveHourResetsAt);
  setMeter('codex-7d', x.weekly, x.weeklyResetsAt);
  const t = u.today;
  const tot = (p) => fmtNum(p.input + p.cached + p.output);
  const codex = state.config?.codex?.enabled === true ? `<br>Codex ${t.codex.calls} pedidos (${tot(t.codex)} tokens)` : '';
  $('#usage-today').innerHTML = `Hoje: Claude ${t.claude.calls} pedidos (${tot(t.claude)} tokens)${codex}`;
}

central.onMessage(({ chatId, message }) => {
  if (chatId !== state.chatId) return;
  const local = state.chat?.messages.find((m) => m.id === message.id);
  if (local) Object.assign(local, message);
  const wrap = el.messages.querySelector(`.msg[data-id="${message.id}"]`);
  if (wrap) fillAssistant(wrap, local || message);
});

central.onUsage(renderUsage);

// ---------- Entrada ----------
function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(240, el.input.scrollHeight)}px`;
}

el.input.addEventListener('input', () => { autosize(); schedulePreview(); });
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
el.model.addEventListener('change', schedulePreview);
el.send.addEventListener('click', () => {
  if (isBusy(state.chatId) && !el.input.value.trim()) central.cancel(state.chatId);
  else sendMessage();
});
el.input.addEventListener('input', updateSendButton);

$('#new-chat').addEventListener('click', () => {
  state.chatId = null;
  state.chat = null;
  renderMessages();
  updateSendButton();
  refreshList();
  el.input.focus();
});

document.querySelectorAll('.suggestions .chip').forEach((c) =>
  c.addEventListener('click', () => {
    el.input.value = c.dataset.s;
    autosize();
    schedulePreview();
    el.input.focus();
  }),
);

el.speak.addEventListener('change', () => {
  central.setConfig({ voice: { speakReplies: el.speak.checked } });
  if (!el.speak.checked) central.stopSpeaking();
});

el.fullAccess.addEventListener('change', () => {
  document.body.classList.toggle('full-access', el.fullAccess.checked);
});

central.onFocusInput(() => el.input.focus());
central.onChatOpen((id) => {
  if (typeof setView === 'function') setView('chat');
  openChat(id);
});
central.onChatsChanged(({ openId } = {}) => {
  refreshList();
  if (openId) {
    if (typeof setView === 'function') setView('chat');
    openChat(openId);
  }
});

// Usado por outras telas: abre uma conversa nova com um texto pronto (e a pasta certa).
async function newChatWithPrompt(text, { cwd, send = false, override } = {}) {
  if (typeof setView === 'function') setView('chat');
  state.chatId = null;
  state.chat = null;
  renderMessages();
  updateSendButton();
  if (cwd) {
    if (![...el.cwd.options].some((o) => o.value === cwd)) {
      const o = document.createElement('option');
      o.value = cwd;
      o.textContent = cwd;
      el.cwd.insertBefore(o, el.cwd.lastElementChild);
    }
    el.cwd.value = cwd;
  }
  if (override) el.model.value = override;
  el.input.value = text;
  autosize();
  schedulePreview();
  el.input.focus();
  el.input.setSelectionRange(text.length, text.length);
  refreshList();
  if (send) await sendMessage();
}

// ---------- Início ----------
(async function init() {
  state.config = await central.getConfig();
  central.appVersion().then((v) => { document.getElementById('app-version').textContent = 'v' + v; });
  // Versão nova: avisa enquanto baixa e oferece reiniciar quando estiver pronta.
  const showUpdate = (s) => {
    const banner = document.getElementById('update-banner');
    const btn = document.getElementById('update-install');
    const txt = document.getElementById('update-text');
    if (s?.status === 'downloading') txt.textContent = `Baixando a versão ${s.version}${s.percent ? ` (${s.percent}%)` : ''}…`;
    else if (s?.status === 'ready') txt.textContent = `Versão ${s.version} pronta para instalar.`;
    banner.hidden = !['downloading', 'ready'].includes(s?.status);
    btn.hidden = s?.status !== 'ready';
  };
  document.getElementById('update-install').onclick = () => central.updateInstall();
  central.onUpdateStatus(showUpdate);
  central.updateState().then(showUpdate).catch(() => {});
  el.speak.checked = !!state.config.voice.speakReplies;
  applyCodex();
  await loadRepos();
  syncCwdSelect();
  await refreshList();
  renderUsage(await central.getUsage());
  el.input.focus();
})();

// ---------- Voz neural ----------
// O processo principal manda um MP3 por trecho; tocam em fila, na ordem em que chegam.
const tts = { id: 0, queue: [], audio: null };
function ttsNext() {
  if (tts.audio || !tts.queue.length) return;
  const file = tts.queue.shift();
  const a = new Audio(fileUrl(file));
  tts.audio = a;
  let finished = false;
  let guard = null;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(guard);
    if (tts.audio === a) tts.audio = null;
    ttsNext();
  };
  a.addEventListener('ended', done);
  a.addEventListener('error', done);
  // Trava de segurança: se o áudio não começar ou não avisar que terminou, libera a fila (e a escuta).
  guard = setTimeout(done, 10000);
  a.addEventListener('loadedmetadata', () => {
    clearTimeout(guard);
    guard = setTimeout(done, (a.duration || 8) * 1000 + 3000);
  });
  a.play().catch(done);
}
central.onTtsPlay(({ id, file, first }) => {
  if (first || id !== tts.id) {
    // fala nova: descarta o que sobrou da anterior
    tts.id = id;
    tts.queue = [];
    if (tts.audio) { tts.audio.pause(); tts.audio = null; }
  }
  tts.queue.push(file);
  ttsNext();
});
central.onTtsStop(() => {
  tts.queue = [];
  if (tts.audio) { tts.audio.pause(); tts.audio = null; }
});
