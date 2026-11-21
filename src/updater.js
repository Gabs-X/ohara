// Atualização automática pelos releases do GitHub (Gabs-X/ohara).
// Baixa a versão nova em segundo plano, avisa na tela e instala ao clicar "Reiniciar" (ou ao fechar a Ohara).
// O portátil e o modo de desenvolvimento não se atualizam: o portátil é baixado de novo à mão.
const { app } = require('electron');

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 4 * 60 * 60_000;

function startUpdater({ send, notify }) {
  let state = { status: 'unsupported' };
  const supported = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
  if (!supported) return { state: () => state, check: async () => state, install() {} };

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // se ele só fechar a Ohara, instala na saída
  autoUpdater.logger = null;

  const set = (s) => {
    state = s;
    send('update:status', s);
  };
  state = { status: 'idle' };
  let notified = null;

  autoUpdater.on('checking-for-update', () => set({ ...state, status: state.status === 'ready' ? 'ready' : 'checking' }));
  autoUpdater.on('update-not-available', () => set({ status: 'idle' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', version: state.version, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version });
    if (notified !== info.version) {
      notified = info.version;
      notify(`Ohara ${info.version} disponível`, 'A atualização já foi baixada. Clique em "Reiniciar e atualizar" ou ela instala quando você fechar a Ohara.');
    }
  });
  // Sem internet ou GitHub fora: tenta de novo no próximo ciclo, sem incomodar.
  autoUpdater.on('error', (err) => set(state.status === 'ready' ? state : { status: 'error', message: String(err?.message || err).slice(0, 200) }));

  const check = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // já tratado no evento "error"
    }
    return state;
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY_MS);

  return {
    state: () => state,
    check,
    // Silencioso (sem as telas do instalador) e abre a Ohara de novo no fim.
    install: () => state.status === 'ready' && autoUpdater.quitAndInstall(true, true),
  };
}

module.exports = { startUpdater };
