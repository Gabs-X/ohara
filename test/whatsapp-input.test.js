const test = require('node:test');
const assert = require('node:assert/strict');
const { sendInput } = require('../src/integrations/whatsapp-input');

function window({ minimized = false, visible = false, allowFocus = true } = {}) {
  let focused = false;
  let contentsFocused = false;
  const received = [];
  return {
    received,
    isMinimized: () => minimized,
    restore: () => { minimized = false; },
    isVisible: () => visible,
    show: () => { visible = true; },
    focus: () => { focused = allowFocus && visible && !minimized; },
    isFocused: () => focused,
    blur: () => { focused = false; contentsFocused = false; },
    webContents: {
      focus: () => { contentsFocused = focused; },
      sendInputEvent: event => {
        // Janela escondida/sem foco não recebe entrada, como no Electron.
        if (visible && focused && contentsFocused && !minimized) received.push(event);
      },
    },
  };
}

test('clique e Enter chegam ao WhatsApp inicialmente escondido ou minimizado', () => {
  for (const minimized of [false, true]) {
    const win = window({ minimized });
    const events = [{ type: 'mouseDown', x: 50, y: 50 }, { type: 'mouseUp', x: 50, y: 50 }, { type: 'keyDown', keyCode: 'Enter' }];
    for (const event of events) { win.blur(); sendInput(win, event); }
    assert.deepEqual(win.received, events);
  }
});

test('não simula sucesso quando o Windows recusa o foco', () => {
  const win = window({ allowFocus: false });
  assert.throws(() => sendInput(win, { type: 'keyDown', keyCode: 'Enter' }), /não recebeu foco/);
  assert.deepEqual(win.received, []);
});
