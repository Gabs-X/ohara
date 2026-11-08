const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(getUserMedia) {
  const states = [];
  const timers = new Map();
  let processor;
  let now = 1000;
  let speaking = false;
  const track = { readyState: 'live', muted: false, stopped: false, label: 'Teste',
    stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.state = 'running'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return processor = { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
    async resume() { this.state = 'running'; }
  }
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
    AudioContext, performance: { now: () => now },
    setInterval: (fn) => { timers.set(fn, fn); return fn; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn) => { timers.set(fn, fn); return fn; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/voice.js'), 'utf8') + '\nthis.Voice = Voice;', context);
  return {
    states, timers, track, stream,
    listen: () => context.Voice.listen({ onHeard: async () => {}, onCapture: (s) => states.push(s), isSpeaking: () => speaking }),
    speak: (value) => { speaking = value; },
    frame: (volume) => {
      now += 150;
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(volume) } });
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('indicador acompanha captura real, fala, pausa e microfone sem sinal', async () => {
  const h = harness();
  const stop = h.listen();
  assert.equal(h.states.at(-1).mode, 'starting');
  await tick();
  assert.equal(h.states.at(-1).mode, 'listening');
  h.frame(.15);
  assert.equal(h.states.at(-1).mode, 'hearing');
  h.speak(true);
  h.frame(.15);
  assert.equal(h.states.at(-1).mode, 'paused');
  h.speak(false);
  for (let i = 0; i < 6; i++) h.frame(0);
  assert.equal(h.states.at(-1).mode, 'listening');
  h.track.muted = true;
  h.frame(.15);
  assert.equal(h.states.at(-1).mode, 'paused');
  h.track.muted = false;
  h.frame(0);
  assert.equal(h.states.at(-1).mode, 'listening');
  stop();
  assert.equal(h.states.at(-1).mode, 'off');
  assert.equal(h.track.stopped, true);
  assert.equal(h.timers.size, 0);
});

test('desligar enquanto aguarda permissão fecha o microfone assim que abrir', async () => {
  let resolve;
  const h = harness(() => new Promise((r) => { resolve = r; }));
  const stop = h.listen();
  stop();
  resolve(h.stream);
  await tick();
  assert.equal(h.track.stopped, true);
  assert.equal(h.states.at(-1).mode, 'off');
  assert.equal(h.states.some((s) => s.mode === 'listening'), false);
  assert.equal(h.timers.size, 0);
});

test('erro de permissão aparece no indicador e desligar cancela nova tentativa', async () => {
  const h = harness(async () => { throw new Error('Permission denied'); });
  const stop = h.listen();
  await tick();
  assert.equal(h.states.at(-1).mode, 'error');
  assert.equal(h.timers.size, 1);
  stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.states.at(-1).mode, 'off');
});
