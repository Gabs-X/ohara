const PREFIX = 'OHARA_DESKTOP_PROBE_OK';

function runDesktopProbe() {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  // Sessão isolada: não abre WhatsApp nem usa os dados do aplicativo principal.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-desktop-probe-')));
  app.disableHardwareAcceleration();
  const timer = setTimeout(() => app.exit(1), 10000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 280, height: 160, title: 'Ohara — teste de acesso', show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>Teste de acesso</title><p>Verificando acesso à área de trabalho…</p><input autofocus><script>window.probeKey=false; addEventListener("keydown",e=>{if(e.key==="F8")window.probeKey=true})</script>'));
    win.show();
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F8' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F8' });
    const key = await win.webContents.executeJavaScript('window.probeKey === true');
    const rendered = !(await win.webContents.capturePage()).isEmpty();
    clearTimeout(timer);
    if (key && rendered) console.log(PREFIX);
    app.exit(key && rendered ? 0 : 1);
  }).catch(() => app.exit(1));
}

function probeDesktop({ executable, appPath, packaged }) {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const args = packaged ? ['--ohara-desktop-probe'] : [appPath, '--ohara-desktop-probe'];
  return promisify(execFile)(executable, args, { windowsHide: true, timeout: 15000, maxBuffer: 65536 }).then(({ stdout }) => {
    if (!stdout.includes(PREFIX)) throw new Error('Teste gráfico não confirmou sucesso.');
  });
}

module.exports = { runDesktopProbe, probeDesktop };
