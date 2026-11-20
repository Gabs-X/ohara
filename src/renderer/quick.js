/* global central, renderMarkdown */
// Janela rápida: pergunta, área de transferência ou voz, com resposta na hora.

const q = {
  input: document.getElementById('q-input'),
  clip: document.getElementById('q-clip'),
  clipText: document.getElementById('q-clip-text'),
  route: document.getElementById('q-route'),
  answer: document.getElementById('q-answer'),
  tools: document.getElementById('q-tools'),
  text: document.getElementById('q-text'),
  meta: document.getElementById('q-meta'),
};
const st = { chatId: null, buf: '', tools: [], clipboard: '', busy: false, config: null };

const escq = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fit() {
  requestAnimationFrame(() => central.quickResize(document.getElementById('q').offsetHeight + 16));
}

function reset() {
  st.chatId = null;
  st.buf = '';
  st.tools = [];
  q.answer.hidden = true;
  q.route.hidden = true;
  q.clip.hidden = true;
  q.text.innerHTML = '';
  q.tools.innerHTML = '';
  q.meta.textContent = '';
}

central.onQuickOpen(async (p) => {
  st.config = await central.getConfig();
  if (p.mode === 'voiceTurn' || p.mode === 'voice') return;
  if (st.busy && p.mode === 'ask' && !p.text) {
    q.input.focus();
    return fit(); // mantém a resposta em andamento
  }
  reset();
  q.input.value = '';
  if (p.mode === 'clipboard') {
    st.clipboard = (p.text || '').trim();
    if (st.clipboard) {
      q.clipText.textContent = st.clipboard.length > 1200 ? `${st.clipboard.slice(0, 1200)}…` : st.clipboard;
      q.clip.hidden = false;
      q.input.placeholder = 'O que fazer com o texto copiado? (ou escolha abaixo)';
    } else {
      q.input.placeholder = 'A área de transferência está vazia. Pergunte algo…';
    }
  } else {
    st.clipboard = '';
    q.input.placeholder = 'Pergunte qualquer coisa…  (Enter envia · Esc fecha)';
    if (p.text) q.input.value = p.text;
  }
  q.input.focus();
  fit();
  if (p.autoSend && p.text) send(p.text);

});

async function send(text) {
  text = text.trim();
  if (!text || st.busy) return;
  const full = st.clipboard ? `${text}\n\n"""\n${st.clipboard}\n"""` : text;
  st.busy = true;
  central.quickPin(true);
  q.clip.hidden = true;
  q.answer.hidden = false;
  q.text.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  q.tools.innerHTML = '';
  st.buf = '';
  st.tools = [];
  fit();
  let res;
  try {
    const chat = await central.createChat(st.config?.defaultCwd, `⚡ ${text.slice(0, 44)}`);
    st.chatId = chat.id;
    res = await central.send(chat.id, { text: full, override: 'auto', source: 'quick' });
  } catch (err) {
    res = { error: err.message || String(err) };
  } finally {
    // Sem isto, um erro deixava a janela rápida "ocupada" e fixa na tela até reiniciar o app.
    st.busy = false;
    central.quickPin(false);
  }
  if (res?.error && !res.role) {
    q.text.innerHTML = `<p class="err">⚠️ ${escq(res.error)}</p>`;
    fit();
  }
}

central.onRoute(({ chatId, route }) => {
  if (chatId !== st.chatId) return;
  q.route.hidden = false;
  q.route.innerHTML = `→ <b class="${route.provider}">${{ codex: 'Codex', local: 'Ohara', ollama: 'Ohara-AI', orca: 'Orca' }[route.provider] || 'Claude'} ${escq(route.model)}</b> · ${escq(route.label)}`;
  fit();
});

let pending = false;
central.onEvent(({ chatId, kind, text }) => {
  if (chatId !== st.chatId) return;
  if (kind === 'delta') st.buf += text;
  if (kind === 'tool') st.tools.push(text);
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    q.tools.innerHTML = st.tools.slice(-4).map((t) => `<div>${escq(t)}</div>`).join('');
    if (st.buf) q.text.innerHTML = renderMarkdown(st.buf);
    q.text.scrollTop = q.text.scrollHeight;
    fit();
  });
});

central.onDone(({ chatId, message }) => {
  if (chatId !== st.chatId) return;
  st.buf = message.text || '';
  q.text.innerHTML = st.buf ? renderMarkdown(st.buf) : `<p class="err">⚠️ ${escq(message.error || 'Sem resposta')}</p>`;
  if (message.error && st.buf) q.text.insertAdjacentHTML('beforeend', `<p class="err">⚠️ ${escq(message.error)}</p>`);
  const t = message.tokens;
  q.meta.textContent = t ? `${message.model} · ${Math.round(((t.input || 0) + (t.cached || 0) + (t.output || 0)) / 100) / 10}k tokens` : message.model || '';
  q.tools.innerHTML = '';
  if (st.config?.voice?.speakReplies && st.buf) central.speak(st.buf); // na conversa por voz quem fala é o processo principal
  fit();
});

// ---------- Voz ----------
// ---------- Teclado e botões ----------
q.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    send(q.input.value);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    central.quickHide();
  }
});
document.querySelectorAll('.q-chips button').forEach((b) =>
  b.addEventListener('click', () => {
    q.input.value = b.dataset.a;
    send(b.dataset.a);
  }),
);
document.getElementById('q-copy').addEventListener('click', () => central.copy(st.buf));
document.getElementById('q-open').addEventListener('click', () => st.chatId && central.quickOpenInMain(st.chatId));

