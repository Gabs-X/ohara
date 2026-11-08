// Envio para contatos pelo WhatsApp Web do próprio Gabriel, numa janela do Electron com sessão persistente.
// Conecta uma vez pelo QR Code. Não é API oficial: o WhatsApp pode mudar a página (e, em tese, restringir a conta).
// O Orchestrator acha o contato (resolve), mostra para ele confirmar e só então envia (send).
const { BrowserWindow, session } = require('electron');
const { pickContact } = require('./whatsapp');
const { searchBox, contactRows } = require('./whatsapp-dom');
const { focusForInput, sendInput } = require('./whatsapp-input');

const URL_WA = 'https://web.whatsapp.com/';
const PARTITION = 'persist:whatsapp';
// O WhatsApp Web recusa navegadores "desconhecidos"; usa o user agent do Chrome.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

class WhatsAppWeb {
  constructor({ icon } = {}) {
    this.icon = icon;
    this.win = null;
    this.queue = Promise.resolve(); // um envio por vez
  }

  #window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(UA);
    this.win = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      title: 'Ohara · WhatsApp',
      icon: this.icon,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.win.webContents.setUserAgent(UA);
    // Links clicados dentro do WhatsApp não abrem janelas novas do app.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        this.win.hide();
      }
    });
    this.win.loadURL(URL_WA, { userAgent: UA });
    return this.win;
  }

  #js(code) {
    return this.#window().webContents.executeJavaScript(code, true);
  }

  async #waitFor(code, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.#js(code)) return true;
      } catch { /* página ainda carregando */ }
      await sleep(400);
    }
    throw new Error(label);
  }

  /** Abre a janela para escanear o QR Code (ou só para ver o WhatsApp). */
  connect() {
    const w = this.#window();
    w.show();
    w.focus();
  }

  async status() {
    if (!this.win || this.win.isDestroyed()) {
      // Abre escondida para descobrir se a sessão salva ainda vale.
      this.#window();
    }
    try {
      await this.#waitFor('!!document.querySelector("#pane-side") || !!document.querySelector("canvas")', 20000, 'timeout');
      const logged = await this.#js('!!document.querySelector("#pane-side")');
      return { connected: logged };
    } catch {
      return { connected: false, loading: true };
    }
  }

  #ready() {
    return this.#waitFor('!!document.querySelector("#pane-side")', 45000, 'WhatsApp Web não conectado: abra Ajustes → WhatsApp → Conectar e escaneie o QR Code.');
  }

  async #typeInto(selector, text, expression = null) {
    focusForInput(this.#window());
    const wc = this.#window().webContents;
    const found = await this.#js(`(() => { const el = ${expression || `document.querySelector(${JSON.stringify(selector)})`}; if (!el) return false; el.focus(); if (el.tagName === 'INPUT') el.select(); else { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); } return true; })()`);
    if (!found) throw new Error('A página do WhatsApp mudou: campo não encontrado.');
    // Quebras de linha viram Shift+Enter para não enviar no meio.
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) {
        sendInput(this.#window(), { type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
        sendInput(this.#window(), { type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
      }
      if (lines[i]) await wc.insertText(lines[i]);
    }
  }

  #pressEnter() {
    sendInput(this.#window(), { type: 'keyDown', keyCode: 'Enter' });
    sendInput(this.#window(), { type: 'char', keyCode: '\r' });
    sendInput(this.#window(), { type: 'keyUp', keyCode: 'Enter' });
  }

  // Pesquisa na lista de conversas/contatos e devolve os nomes encontrados.
  async #search(query) {
    const expression = `(${searchBox.toString()})()`;
    await this.#waitFor(`!!${expression}`, 15000, 'Não encontrei a busca de contatos do WhatsApp Web.');
    await this.#typeInto(null, query, expression);
    await sleep(1500);
    // Só o título de cada resultado (o nome da conversa), não a prévia da última mensagem.
    return this.#js(`(${contactRows.toString()})().map(row => row.name)`);
  }

  // Acha o nome da conversa que corresponde a `query`, sem abrir nem enviar nada.
  async #findContact(query) {
    // Nome parcial ou mal transcrito: se a busca não achar nada, tenta a primeira palavra e depois só o começo dela.
    const first = String(query).trim().split(/\s+/)[0] || query;
    const tries = [...new Set([query, first, first.slice(0, 4), first.slice(0, 3)])].filter((t) => t.length >= 2);
    let titles = [];
    for (const t of tries) {
      titles = await this.#search(t);
      if (titles.length) break;
    }
    // Nome exato (ex.: o contato que ele já confirmou) ganha de qualquer parecido.
    const exact = [...new Set(titles.filter((t) => norm(t) === norm(query)))];
    if (exact.length === 1) return { name: exact[0] };
    return pickContact(query, titles);
  }

  async #openChatByName(query) {
    const pick = await this.#findContact(query);
    if (pick.error) throw new Error(pick.error);
    const target = await this.#js(`(() => {
      const item = (${contactRows.toString()})().find(row => row.name === ${JSON.stringify(pick.name)})?.item;
      if (!item) return null;
      item.scrollIntoView({ block: 'nearest' });
      const rect = (item.querySelector('span[title]') || item).getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    if (!target) throw new Error(`Não consegui abrir a conversa com ${pick.name}.`);
    sendInput(this.#window(), { type: 'mouseDown', ...target, button: 'left', clickCount: 1 });
    sendInput(this.#window(), { type: 'mouseUp', ...target, button: 'left', clickCount: 1 });
    return pick.name;
  }

  async #openChatByNumber(phone) {
    const digits = String(phone).replace(/\D/g, '');
    await this.#window().webContents.loadURL(`${URL_WA}send?phone=${digits}`, { userAgent: UA });
    await this.#ready();
    return `+${digits}`;
  }

  async #currentChatName() {
    return this.#js(`(() => { const h = document.querySelector('#main header span[title], #main header span[dir="auto"]'); return h ? (h.getAttribute('title') || h.textContent) : ''; })()`);
  }

  /**
   * Descobre para qual contato `to` iria, sem enviar: é o que a Ohara mostra para ele confirmar.
   * Retorna { to } com o nome exato da conversa (ou o número com DDI).
   */
  resolve(to) {
    const job = this.queue.then(async () => {
      const isNumber = /^\+?[\d\s()-]{10,}$/.test(String(to).trim());
      if (isNumber) return { to: `+${String(to).replace(/\D/g, '')}` };
      this.#window();
      await this.#ready();
      const pick = await this.#findContact(to);
      if (pick.error) throw new Error(pick.error);
      return { to: pick.name };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * Envia `text` para um contato (nome como está no WhatsApp) ou número com DDI.
   * Retorna { to } com o nome da conversa em que a mensagem foi enviada.
   */
  send(to, text) {
    const job = this.queue.then(async () => {
      if (!String(text || '').trim()) throw new Error('Mensagem vazia.');
      this.#window();
      await this.#ready();
      const isNumber = /^\+?[\d\s()-]{10,}$/.test(String(to).trim());
      const name = isNumber ? await this.#openChatByNumber(to) : await this.#openChatByName(to);
      if (!isNumber) await this.#waitFor(`(() => { const h = document.querySelector('#main header span[title], #main header span[dir="auto"]'); return h && (h.getAttribute('title') || h.textContent) === ${JSON.stringify(name)}; })()`, 15000, `A conversa com ${name} não abriu.`);
      await this.#waitFor('!!document.querySelector(\'#main footer [contenteditable="true"]\')', 15000, `A conversa com ${name} não abriu.`);
      const opened = (await this.#currentChatName()) || name;
      if (!isNumber && norm(opened) !== norm(name)) throw new Error(`Abriu a conversa errada (${opened}); nada foi enviado.`);
      await this.#typeInto('#main footer [contenteditable="true"]', text);
      await sleep(300);
      const messageIds = await this.#js(`[...document.querySelectorAll('#main .message-out')].map(e => e.getAttribute('data-id') || e.closest('[data-id]')?.getAttribute('data-id')).filter(Boolean)`);
      this.#pressEnter();
      await this.#waitFor(`(() => {
        const box = document.querySelector('#main footer [contenteditable="true"]');
        const messages = [...document.querySelectorAll('#main .message-out')];
        const normalize = s => String(s || '').replace(/\\s+/g, ' ').trim();
        return box && !box.textContent.trim() && messages.some(e => {
          const id = e.getAttribute('data-id') || e.closest('[data-id]')?.getAttribute('data-id');
          return id && !${JSON.stringify(messageIds)}.includes(id) && normalize(e.innerText).includes(normalize(${JSON.stringify(text)}));
        });
      })()`, 15000, 'Não confirmei a saída da mensagem; confira a conversa antes de tentar novamente.');
      return { to: opened };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  destroy() {
    this.quitting = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { WhatsAppWeb };
