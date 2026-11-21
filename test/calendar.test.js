const test = require('node:test');
const assert = require('node:assert');
const { expand } = require('../src/integrations/calendar');

const ev = (start, rrule, extra = {}) => ({ uid: 'u', start, end: new Date(start.getTime() + 3600e3), rrule, exdates: [], ...extra });

test('reunião semanal criada há mais de 400 dias continua aparecendo', () => {
  const start = new Date(2023, 0, 2, 9, 0); // segunda-feira
  const from = new Date(2026, 10, 16); // segunda
  const to = new Date(2026, 10, 23);
  const out = expand([ev(start, { FREQ: 'WEEKLY', BYDAY: 'MO' })], from, to);
  assert.equal(out.length, 1);
  assert.equal(out[0].start.getDay(), 1);
  assert.equal(out[0].start.getHours(), 9);
});

test('quinzenal antigo respeita o intervalo', () => {
  const start = new Date(2023, 0, 2, 9, 0);
  const from = new Date(2026, 10, 1);
  const to = new Date(2026, 11, 1);
  const out = expand([ev(start, { FREQ: 'WEEKLY', INTERVAL: '2' })], from, to);
  for (const o of out) assert.equal(Math.round((o.start - start) / 864e5) % 14, 0);
  assert.ok(out.length >= 2);
});

test('diário antigo aparece no dia', () => {
  const start = new Date(2022, 5, 1, 8, 30);
  const out = expand([ev(start, { FREQ: 'DAILY' })], new Date(2026, 10, 20), new Date(2026, 10, 21));
  assert.equal(out.length, 1);
});
