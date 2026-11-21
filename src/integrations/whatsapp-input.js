// sendInputEvent exige uma BrowserWindow visível e focada, inclusive no Windows.
function focusForInput(win) {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.focus();
  if (!win.isFocused()) {
    throw new Error('O WhatsApp não recebeu foco. Abra a janela do WhatsApp pela Ohara e tente novamente.');
  }
}

function sendInput(win, event) {
  focusForInput(win);
  win.webContents.sendInputEvent(event);
}

module.exports = { focusForInput, sendInput };
