// Diagnóstico manual isolado: node_modules/.bin/electron scripts/whatsapp-check.cjs
// Não envia mensagens sem --send. Usa uma cópia temporária da sessão existente.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.OHARA_WHATSAPP_CHECK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-whatsapp-check-'));
const source = path.join(process.env.APPDATA, 'ohara');
for (const name of process.env.OHARA_WHATSAPP_CHECK_DIR ? [] : ['Local State', 'Partitions/whatsapp']) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(source, name), target, { recursive: true, filter: (p) => !/(?:^|[\\/])(?:LOCK|Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache)$/.test(p) });
}
app.setPath('userData', root);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const { WhatsAppWeb } = require('../src/integrations/whatsapp-web');
  const wa = new WhatsAppWeb();
  try {
    console.log('STATUS', JSON.stringify(await wa.status()));
    const win = BrowserWindow.getAllWindows()[0];
    console.log('DOM', JSON.stringify(await win.webContents.executeJavaScript(`({ url: location.href, fields: [...document.querySelectorAll('input, [contenteditable="true"]')].map(e => ({tag:e.tagName,role:e.getAttribute('role'),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder'),dataTab:e.getAttribute('data-tab'),id:e.id,ancestors:[e.parentElement?.id,e.parentElement?.parentElement?.id,e.closest('[role]')?.getAttribute('role')]})), pane:!!document.querySelector('#pane-side'),side:!!document.querySelector('#side') })`)));
    if (process.argv.includes('--send')) console.log('SENT', JSON.stringify(await wa.send('Tata', 'Oi, Tata! Sou a Ohara, assistente pessoal do Gabriel. Ele pediu esta mensagem para testar o envio pelo WhatsApp.')));
  } catch (err) { console.error(err.stack); process.exitCode = 1; }
  finally { wa.destroy(); app.quit(); }
});
