const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findChrome, wantsBrowser, needsBrowser, checkBridge, ensureChrome: realEnsure, chromeNote, chromeIssueNote, CODEX_BROWSER_NOTE } = require('../src/integrations/chrome');

// Ponte da extensão instalada, a não ser que o teste diga o contrário.
const ensureChrome = (o) => realEnsure({ bridge: async () => ({ ok: true }), ...o });

test('acha o chrome.exe em Arquivos de Programas ou na pasta do usuário', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\U\\Local' };
  const at = (root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findChrome(env, (p) => p === at('C:\\PF86')), at('C:\\PF86'));
  assert.equal(findChrome(env, (p) => p === at('C:\\U\\Local')), at('C:\\U\\Local'));
  assert.equal(findChrome(env, () => false), null);
});

test('reconhece pedidos que precisam do navegador logado', () => {
  for (const t of ['preenche o projeto no meu LinkedIn', 'abre o Chrome e confere', 'roda /vagas', 'me candidata nessa vaga', 'entra no site e faz login', 'Edita o perfil']) {
    assert.ok(wantsBrowser(t), t);
  }
  for (const t of ['qual a capital da França?', 'corrige o bug do roteador', 'resume a reunião de ontem']) {
    assert.ok(!wantsBrowser(t), t);
  }
});

test('Chrome já aberto: não abre outro', async () => {
  let launched = 0;
  const r = await ensureChrome({ chromePath: 'chrome.exe', isRunning: async () => true, launch: () => launched++, wait: async () => {} });
  assert.deepEqual([r.running, r.started, launched], [true, false, 0]);
});

test('Chrome fechado: abre e espera a extensão subir', async () => {
  let running = false;
  const launched = [];
  const waits = [];
  const r = await ensureChrome({
    chromePath: 'C:\\chrome.exe',
    isRunning: async () => running,
    launch: (p) => { launched.push(p); setTimeout(() => { running = true; }, 0); },
    wait: (ms) => { waits.push(ms); return new Promise((res) => setTimeout(res, 1)); },
    settleMs: 4000,
  });
  assert.deepEqual(launched, ['C:\\chrome.exe']);
  assert.equal(r.running, true);
  assert.equal(r.started, true);
  assert.equal(waits.at(-1), 4000, 'dá tempo para a extensão conectar');
});

test('sem Chrome instalado ou se não abrir: avisa o motivo', async () => {
  const none = await ensureChrome({ chromePath: null, isRunning: async () => false, launch: () => assert.fail('não deveria abrir') });
  assert.equal(none.running, false);
  assert.match(none.error, /não encontrado/);

  const stuck = await ensureChrome({ chromePath: 'chrome.exe', isRunning: async () => false, launch() {}, wait: async () => {}, timeoutMs: 1500 });
  assert.equal(stuck.running, false);
  assert.match(stuck.error, /não abriu/);
});

test('o prompt ensina a reabrir o Chrome e tentar de novo antes de pedir ajuda', () => {
  const note = chromeNote('C:\\Chrome\\chrome.exe');
  assert.match(note, /Start-Process "C:\\Chrome\\chrome\.exe"/);
  assert.match(note, /tente de novo/);
  assert.match(note, /list_connected_browsers/);
  assert.match(chromeNote(null), /Start-Process chrome/);
});

test('pedidos que só dão certo no Chrome logado (vão sempre para o Claude)', () => {
  for (const t of ['faca um post no linkedin tambem igual aos que fiz falando sobre a Ohara', 'roda /vagas', 'me candidata nessa vaga', 'abre no navegador']) {
    assert.ok(needsBrowser(t), t);
  }
  for (const t of ['corrige o bug na página de perfil do site', 'faz o login da API funcionar', 'resume a reunião']) {
    assert.ok(!needsBrowser(t), t);
  }
});

test('confere a ponte da extensão: chave do host nativo, manifesto e executável', async () => {
  const manifest = 'C:\\Host\\host.json';
  const host = 'C:\\Host\\chrome-native-host.bat';
  const files = { [manifest]: JSON.stringify({ path: host }) };
  const exists = (p) => p in files || p === host;
  const readFile = (p) => files[p];
  assert.deepEqual(await checkBridge({ readKey: async () => manifest, exists, readFile }), { ok: true });

  const noKey = await checkBridge({ readKey: async () => null, exists, readFile });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /não está registrada/);

  const badHost = await checkBridge({ readKey: async () => manifest, exists: (p) => p === manifest, readFile });
  assert.equal(badHost.ok, false);
  assert.match(badHost.error, /não existe/);

  const badJson = await checkBridge({ readKey: async () => manifest, exists, readFile: () => '{' });
  assert.equal(badJson.ok, false);
});

test('ponte ausente: ainda abre o Chrome, mas avisa o motivo antes de começar', async () => {
  let launched = 0;
  const r = await realEnsure({
    bridge: async () => ({ ok: false, error: 'a extensão Claude in Chrome não está registrada' }),
    chromePath: 'chrome.exe', isRunning: async () => true, launch: () => launched++, wait: async () => {},
  });
  assert.equal(r.running, true);
  assert.equal(r.bridge, false);
  assert.match(r.error, /não está registrada/);

  const ok = await ensureChrome({ chromePath: 'chrome.exe', isRunning: async () => true, launch() {}, wait: async () => {} });
  assert.equal(ok.bridge, true);
});

test('o prompt manda conferir a conexão antes de começar; o Codex não tenta usar o navegador', () => {
  assert.match(chromeNote('chrome.exe'), /confira a conexão primeiro/);
  assert.match(chromeIssueNote('falta o host'), /falta o host/);
  assert.match(chromeIssueNote('x'), /\/chrome/);
  assert.match(CODEX_BROWSER_NOTE, /Não tente abrir nem automatizar o navegador/);
});
