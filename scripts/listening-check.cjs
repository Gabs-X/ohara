// Execute com node_modules/.bin/electron.cmd scripts/listening-check.cjs.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ohara-listening-check-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 15000);
let cfg = { voice: { wakeWord: false, showListeningIndicator: true } };
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 320, height: 76, frame: false, show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.handle('config:get', () => cfg);
  ipcMain.handle('config:set', (_e, partial) => {
    cfg.voice = { ...cfg.voice, ...partial.voice };
    w.webContents.send('config:changed', cfg);
    return cfg;
  });
  ipcMain.handle('voice:status', () => ({ mode: 'off', text: 'Microfone desligado' }));
  try {
    await w.loadFile(path.join(__dirname, '../src/renderer/listening.html'));
    await new Promise((r) => setTimeout(r, 250));
    const read = () => w.webContents.executeJavaScript(`({ text: document.getElementById('status').textContent, mode: document.getElementById('dot').dataset.mode, button: document.getElementById('toggle').textContent, overflow: document.body.scrollWidth > innerWidth || document.body.scrollHeight > innerHeight })`);
    assert.equal((await read()).text, 'Microfone desligado');
    assert.equal((await read()).overflow, false);
    await w.webContents.executeJavaScript("document.getElementById('toggle').click()");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cfg.voice.wakeWord, true);
    assert.equal((await read()).button, 'Desligar');
    for (const [mode, text] of [['listening', 'Ouvindo · diga “Ohara”'], ['paused', 'Escuta pausada: respondendo'], ['error', 'Erro no microfone · veja Ajustes']]) {
      w.webContents.send('voice:status', { mode, text });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await read()).mode, mode);
      assert.equal((await read()).text, text);
    }
    w.webContents.send('voice:status', { mode: 'listening', text: 'Ouvindo · diga “Ohara”' });
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(__dirname, '../dist/listening-preview.png'), (await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript("document.getElementById('hide').click()");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cfg.voice.showListeningIndicator, false);
    console.log('Indicador: renderização, estados, botão do microfone e ocultação OK.');
    clearTimeout(deadline);
    app.exit(0);
  } catch (err) { console.error(err); app.exit(1); }
});
