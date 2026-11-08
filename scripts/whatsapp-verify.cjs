const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.OHARA_WA_VERIFY_DIR);
app.whenReady().then(async () => {
  const { WhatsAppWeb } = require('../src/integrations/whatsapp-web');
  const wa = new WhatsAppWeb();
  try {
    console.log('STATUS', JSON.stringify(await wa.status()));
    const win = BrowserWindow.getAllWindows()[0];
    console.log('DOM', JSON.stringify(await win.webContents.executeJavaScript(`({ fields: [...document.querySelectorAll('input, [contenteditable="true"]')].map(e => ({tag:e.tagName,role:e.getAttribute('role'),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder'),outer:e.outerHTML.slice(0,1500),parents:[e.parentElement?.outerHTML.slice(0,200),e.parentElement?.parentElement?.outerHTML.slice(0,200)]})),pane:!!document.querySelector('#pane-side'),side:!!document.querySelector('#side') })`)));
    if (process.argv.includes('--send')) {
      wa.connect();
      console.log('SENT', JSON.stringify(await wa.send('Tata', 'Oi, Tata! Estou testando o envio de mensagens da Ohara, minha assistente pessoal. Se esta mensagem chegou, o teste funcionou. — Gabriel')));
      console.log('EVIDENCE', JSON.stringify(await win.webContents.executeJavaScript(`({chat:document.querySelector('#main header')?.innerText,messages:[...document.querySelectorAll('#main .message-out')].slice(-2).map(e=>({text:e.innerText,icons:[...e.querySelectorAll('[data-icon]')].map(i=>i.getAttribute('data-icon'))}))})`)));
      const fs = require('node:fs');
      fs.writeFileSync(require('node:path').join(process.env.OHARA_WA_VERIFY_DIR,'sent.png'), (await win.webContents.capturePage()).toPNG());
      console.log('SCREENSHOT', require('node:path').join(process.env.OHARA_WA_VERIFY_DIR,'sent.png'));
      await new Promise(r=>setTimeout(r,20000));
    }
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
  finally { wa.destroy(); app.quit(); }
});
