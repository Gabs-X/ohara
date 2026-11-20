// Ohara Guia: a edição da Ohara para quem não é desenvolvedor.
// Mesmo núcleo da Ohara (IAs, roteador, cota), sem as integrações pessoais. Roda com `npm run start:guia`
// e é empacotada à parte (`npm run dist:guia`), com outro nome, outra pasta de dados e outro canal de atualização.
const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, dialog, desktopCapturer, screen, shell, nativeImage, session,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { guiaDefaults } = require('./config');
const { JsonStore, deepMerge } = require('../core/store');
const { UsageTracker } = require('../core/usage');
const { GuideAgent } = require('./agent');
const { Planner, stepPrompt, stepCategory } = require('./planner');
const { Checkpoints } = require('../core/checkpoints');
const { checkHealth, openTerminal } = require('../core/health');
const { detectProject, runProject } = require('../core/project-runner');
const { computeSavings } = require('../core/savings');
const { allSpecs, PROVIDERS, TIER_LABEL, routeLabel } = require('../core/providers/registry');
const { MODES } = require('../core/multi-router');
const { DocIndex } = require('../core/doc-index');
const localTools = require('../core/local-tools');
const localLlm = require('../core/local-llm');
const { extractText } = require('../core/doc-text');
const { isAppPage, sanitizeConfigPatch, assertSafeToOpen } = require('../core/ipc-guard');

const APP_NAME = 'Ohara Guia';
const ROOT = path.join(__dirname, '..', '..');
const VERSION = app.isPackaged ? app.getVersion() : require(path.join(ROOT, 'package.json')).version;
app.setName(APP_NAME);
app.setPath('userData', process.env.GUIA_DATA_DIR || path.join(app.getPath('appData'), APP_NAME));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const dataDir = app.getPath('userData');
const configFile = path.join(dataDir, 'config.json');
const ICON = path.join(ROOT, 'src', 'assets', 'icon.png');

function errorLog(kind, err) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'erros.log'), `${new Date().toLocaleString('pt-BR')}  [${kind}] ${err?.stack || err}\n`);
  } catch { /* opcional */ }
}
process.on('uncaughtException', (err) => errorLog('exceção', err));
process.on('unhandledRejection', (err) => errorLog('promessa', err));

// ---------- Configuração ----------
function readUserConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; }
}
function loadConfig() {
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, '{}');
  }
  return deepMerge(guiaDefaults(), readUserConfig());
}
let config = loadConfig();
const getConfig = () => config;

const ALLOWED_KEYS = new Set(['userName', 'onboarded', 'projectsDir', 'providers', 'orchestration', 'safety', 'ollama', 'hotkeys', 'documents', 'privacy']);
function updateConfig(partial) {
  const clean = Object.fromEntries(Object.entries(partial || {}).filter(([k]) => ALLOWED_KEYS.has(k)));
  if (clean.orchestration?.mode && !MODES[clean.orchestration.mode]) throw new Error('Modo inválido.');
  const user = deepMerge(readUserConfig(), clean);
  fs.writeFileSync(configFile, JSON.stringify(user, null, 2));
  config = deepMerge(guiaDefaults(), user);
  if (clean.providers || clean.ollama) refreshHealth();
  if (clean.hotkeys) registerHotkeys();
  return config;
}

// ---------- Serviços ----------
const store = (name, defaults) => new JsonStore(path.join(dataDir, name), defaults);
const chatsStore = store('chats.json', { chats: [] });
const usageStore = store('usage.json', { days: {}, limits: { claude: null, codex: null } });
const plansStore = store('plans.json', { plans: [] });
const stores = [chatsStore, usageStore, plansStore];

const usage = new UsageTracker(usageStore);
let health = { items: [], available: [], ready: false, checkedAt: 0 };
usage.codexOn = () => health.available.includes('codex');

let win = null;
let tray = null;
let quitting = false;
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

const checkpoints = new Checkpoints({ dir: path.join(dataDir, 'pontos') });
const docIndex = new DocIndex({ file: path.join(dataDir, 'documentos-indice.json'), getConfig, emit: (ch, p) => send(ch, p) });
const agent = new GuideAgent({ chatsStore, usage, getConfig, getAvailable: () => new Set(health.available), emit: send, checkpoints });

// O planejador usa o agente numa conversa própria do plano: o plano fica registrado e dá para conversar sobre ele.
const planner = new Planner({
  store: plansStore,
  ask: async ({ prompt, cwd, category }) => {
    const chat = agent.create(cwd, '🗺️ Planejamento', { hidden: true });
    try {
      const m = await agent.send(chat.id, { text: prompt, category, label: 'Montar o plano' });
      return { text: m.text, error: m.error, provider: m.provider, model: m.model };
    } finally {
      agent.remove(chat.id);
    }
  },
});

let healthRun = null;
function refreshHealth() {
  if (healthRun) return healthRun;
  healthRun = checkHealth({ config })
    .then((h) => { health = h; send('health:update', h); return h; })
    .catch((err) => { errorLog('saúde', err); return health; })
    .finally(() => { healthRun = null; });
  return healthRun;
}

// ---------- Janela ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 760, minHeight: 520,
    backgroundColor: '#0f1117', title: APP_NAME, icon: ICON, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // Só a página da própria Guia; um arquivo arrastado para a janela abriria com o preload.
    if (isAppPage(url, path.join(__dirname, 'renderer'))) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  // Desenvolvimento: GUIA_SNAPSHOT=arquivo.png (+ GUIA_VIEW) salva um print e fecha.
  if (process.env.GUIA_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.GUIA_VIEW) {
        send('app:view', process.env.GUIA_VIEW);
        await new Promise((r) => setTimeout(r, Number(process.env.GUIA_WAIT || 1500)));
      }
      fs.writeFileSync(process.env.GUIA_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
      quitting = true;
      app.quit();
    }, 2500));
  }
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'src', 'assets', 'tray.png')));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { win.show(); win.focus(); } },
    { label: 'Verificar se está tudo certo', click: () => { win.show(); send('app:view', 'health'); } },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, enabled: app.isPackaged, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { label: 'Abrir pasta de dados', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => toggleWindow());
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const accel = config.hotkeys?.toggle;
  if (accel) {
    try { globalShortcut.register(accel, toggleWindow); } catch { /* atalho inválido ou em uso */ }
  }
}

async function captureScreen() {
  const wasVisible = win?.isVisible();
  if (wasVisible) win.hide();
  await new Promise((r) => setTimeout(r, 350));
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) } });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source) throw new Error('Nenhuma tela disponível para captura');
    const dir = path.join(dataDir, 'capturas');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tela-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    return { path: file, preview: source.thumbnail.resize({ width: 320 }).toDataURL() };
  } finally {
    if (wasVisible) { win.show(); win.focus(); }
  }
}

// ---------- Dados para a tela ----------
function providersInfo() {
  return allSpecs(config).map((s) => ({
    id: s.id, label: s.label, vendor: s.vendor, help: s.help, enabled: s.enabled, quota: s.quota,
    caps: s.caps, ready: health.available.includes(s.id),
    tiers: Object.entries(s.tiers).map(([t, v]) => ({ tier: t, tierLabel: TIER_LABEL[t], model: v.model, label: routeLabel(s.id, t, s.id === 'codex' ? '' : v.model) })),
  }));
}

function usageReport() {
  const summary = usage.summary();
  const week = summary.days.slice(-7);
  return {
    limits: agent.limits(),
    today: summary.today,
    days: summary.days,
    savingsWeek: computeSavings(week, { prices: config.orchestration?.prices }),
    savingsMonth: computeSavings(summary.days, { prices: config.orchestration?.prices }),
    providers: providersInfo(),
  };
}

function listProjects() {
  const dir = config.projectsDir;
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

function newProject(name) {
  const clean = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60);
  if (!clean) throw new Error('Dê um nome ao projeto.');
  const dir = path.join(config.projectsDir, clean);
  if (fs.existsSync(dir)) throw new Error('Já existe um projeto com esse nome.');
  fs.mkdirSync(dir, { recursive: true });
  return { name: clean, path: dir };
}

// ---------- IPC ----------
const safe = (fn) => async (...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
};

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => safe(fn)(...a));

  handle('app:info', () => ({ version: VERSION, dataDir, name: APP_NAME }));
  handle('config:get', () => config);
  handle('config:set', (partial) => updateConfig(sanitizeConfigPatch(partial)));

  handle('health:get', () => health);
  handle('health:check', () => refreshHealth());
  handle('health:fix', (id) => {
    const item = health.items.find((i) => i.id === id);
    if (!item?.fix?.command) throw new Error('Nada para consertar automaticamente.');
    openTerminal(item.fix.command);
    return { opened: true, hint: item.fix.hint || null };
  });
  handle('providers:get', () => providersInfo());

  handle('chats:list', () => agent.list().filter((c) => !agent.get(c.id)?.hidden));
  handle('chat:get', (id) => agent.get(id));
  handle('chat:create', (cwd, title) => agent.create(cwd, title));
  handle('chat:delete', (id) => agent.remove(id));
  handle('chat:setCwd', (id, cwd) => agent.setCwd(id, cwd));
  handle('chat:send', (id, payload) => agent.send(id, payload));
  handle('chat:cancel', (id, runId) => agent.cancel(id, runId));
  handle('chat:undo', (id, msgId) => agent.undo(id, msgId));
  handle('chat:redo', (id, msgId) => agent.redo(id, msgId));
  handle('route:preview', (text, opts) => agent.preview(text, opts));

  handle('projects:list', () => ({ dir: config.projectsDir, list: listProjects() }));
  handle('projects:new', (name) => newProject(name));
  handle('project:detect', (cwd) => detectProject(cwd));
  handle('project:run', (cwd) => runProject(cwd, { openFile: (f) => shell.openPath(f) }));
  handle('project:openFolder', (cwd) => shell.openPath(cwd));

  handle('plans:list', () => planner.list());
  handle('plan:get', (id) => planner.get(id));
  handle('plan:create', (idea, cwd) => planner.create({ idea, cwd }));
  handle('plan:revise', (id, feedback) => planner.revise(id, feedback));
  handle('plan:delete', (id) => planner.remove(id));
  handle('plan:step', (id, stepId, patch) => planner.setStep(id, stepId, patch));
  // Executa uma etapa na conversa do plano (cria a conversa na primeira vez). A resposta chega pelos eventos do chat.
  handle('plan:runStep', (id, stepId) => {
    const plan = planner.get(id);
    const step = plan?.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('Etapa não encontrada.');
    let chat = plan.chatId && agent.get(plan.chatId);
    if (!chat) {
      chat = agent.create(plan.cwd, `🗺️ ${plan.title}`, { planId: plan.id });
      planner.linkChat(plan.id, chat.id);
    }
    planner.setStep(id, stepId, { runAt: Date.now() });
    const idx = plan.steps.indexOf(step) + 1;
    agent.send(chat.id, { text: stepPrompt(plan, step), category: stepCategory(step), label: `Etapa ${idx}: ${step.title}` }).catch((err) => errorLog('etapa', err));
    return { chatId: chat.id };
  });

  handle('usage:get', () => usageReport());

  // Ferramentas locais (mesma tela da Ohara): tudo no modelo local, sem cota e sem o dado sair do PC.
  handle('tools:status', async () => {
    const models = await localLlm.installedModels(config);
    const o = config.ollama || {};
    const need = { texto: o.model, embeddings: o.embedModel || 'bge-m3', visao: o.visionModel || 'qwen2.5vl:7b' };
    return {
      ollama: models !== null,
      missing: models ? Object.values(need).filter((m) => m && !localLlm.hasModel(models, m)) : [],
      models: need,
      docs: docIndex.status(),
      privacy: config.privacy,
      tabs: ['docs', 'extract', 'triage', 'photo', 'privacy', 'log'],
      privacyScope: 'antes de cada pedido sair para Claude, Codex ou Gemini na conversa. Atenção: os arquivos que a IA abrir dentro do projeto não passam por isso.',
      handoffLabel: 'Mandar para a IA resolver',
      handoffPrefix: '',
    };
  });
  handle('dialog:file', async (kind) => {
    const filters = kind === 'image'
      ? [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      : [{ name: 'Documentos', extensions: ['pdf', 'docx', 'txt', 'md', 'html', 'htm', 'rtf', 'csv', 'json', 'log'] }];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('docs:index', () => docIndex.rebuild());
  handle('docs:ask', (q) => docIndex.ask(q));
  handle('tools:extract', async ({ file, text } = {}) => localTools.extractFields({ config, text: file ? await extractText(file) : text }));
  handle('tools:triage', (text) => localTools.triage({ config, text }));
  handle('tools:photo', (file) => localTools.readPhoto({ config, image: file }));
  handle('tools:anonymize', (text) => localTools.anonymize({ config, text, names: config.privacy?.names !== false, keep: [...(config.privacy?.keep || []), config.userName] }));
  handle('tools:log', (text) => localTools.diagnoseLog({ config, text }));
  handle('shell:openPath', (p) => shell.openPath(assertSafeToOpen(p)));
  handle('clipboard:write', (text) => require('electron').clipboard.writeText(String(text || '')));

  handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('screen:capture', () => captureScreen());
  handle('shell:openExternal', (url) => (/^https?:/.test(url) ? shell.openExternal(url) : null));

  handle('update:state', () => updater.state());
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());
  handle('app:loginItem', (on) => {
    if (on !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    return { enabled: app.getLoginItemSettings().openAtLogin, available: app.isPackaged };
  });
}

// Atualização automática pelos releases do GitHub (só no app instalado).
let updater = { state: () => ({ status: 'unsupported' }), check: async () => ({ status: 'unsupported' }), install() {} };
function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

// ---------- Ciclo de vida ----------
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

app.whenReady().then(() => {
  app.setAppUserModelId('com.gabsx.ohara-guia');
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  registerIpc();
  try { updater = require('../updater').startUpdater({ send, notify }); } catch (err) { errorLog('atualização', err); }
  createWindow();
  createTray();
  registerHotkeys();
  refreshHealth();
  setInterval(() => refreshHealth(), 10 * 60_000);
  setInterval(() => { try { usage.sampleLimits(); } catch { /* opcional */ } }, 5 * 60_000);
});

app.on('before-quit', () => {
  quitting = true;
  for (const s of stores) s.flush();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());

module.exports = { PROVIDERS };
