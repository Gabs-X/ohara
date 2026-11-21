const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeSavings, priceKey } = require('../src/core/savings');
const { UsageTracker } = require('../src/core/usage');
const { JsonStore } = require('../src/core/store');

test('preço pelo nome do modelo', () => {
  assert.equal(priceKey('claude', 'claude-haiku-4-5'), 'haiku');
  assert.equal(priceKey('claude', 'claude-opus-4-1'), 'opus');
  assert.equal(priceKey('gemini', 'gemini-2.5-flash-lite'), 'flash-lite');
  assert.equal(priceKey('gemini', 'gemini-2.5-pro'), 'pro');
  assert.equal(priceKey('ollama', 'qwen'), 'local');
});

test('pedidos na IA local e no Gemini economizam contra o Sonnet', () => {
  const days = [{
    date: '2026-11-20',
    ollama: { input: 800, cached: 0, output: 200, byModel: { 'qwen2.5:7b': { calls: 2, tokens: 1000 } } },
    gemini: { input: 8000, cached: 0, output: 2000, byModel: { 'gemini-2.5-flash': { calls: 1, tokens: 10000 } } },
    claude: { input: 0, cached: 0, output: 0, byModel: {} },
  }];
  const s = computeSavings(days);
  assert.equal(s.calls, 3);
  assert.ok(s.saved > 0);
  assert.ok(s.ratio > 0.8, `economia alta (${s.ratio})`);
  assert.equal(s.byProvider.ollama.actual, 0);
});

test('tudo no modelo de referência: economia zero', () => {
  const days = [{ claude: { input: 900, cached: 0, output: 100, byModel: { sonnet: { calls: 1, tokens: 1000 } } } }];
  assert.equal(computeSavings(days).saved, 0);
});

test('uso: registra IA nova (Gemini) sem quebrar e conta os pedidos do dia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-uso-'));
  const store = new JsonStore(path.join(dir, 'u.json'), { days: {}, limits: {} });
  const u = new UsageTracker(store);
  u.record('gemini', 'gemini-2.5-flash', { input: 10, output: 5 });
  u.record('gemini', 'gemini-2.5-flash', { input: 10, output: 5 });
  u.record('ollama', 'qwen', { input: 1, output: 1 });
  assert.equal(u.callsToday('gemini'), 2);
  assert.equal(u.callsToday('codex'), 0);
  assert.equal(u.day().byFeature.chat.gemini, 30);
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});
