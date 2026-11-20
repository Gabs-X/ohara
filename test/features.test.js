const test = require('node:test');
const assert = require('node:assert');
const { parseICS, expand, meetCode } = require('../src/integrations/calendar');
const { learnPreferences, route } = require('../src/core/router');
const { pickProvider } = require('../src/core/ai');
const { DEFAULT_CONFIG } = require('../src/core/config');

const config = structuredClone(DEFAULT_CONFIG);
config.codex.enabled = true;
// Os testes de orçamento abaixo exercitam o modo "auto" (os padrões agora usam o modelo local).
for (const k of ['briefing', 'busca']) config.features[k].provider = 'auto';

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily-1
SUMMARY:Daily do time
DTSTART;TZID=America/Sao_Paulo:20261102T091500
DTEND;TZID=America/Sao_Paulo:20261102T093000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=America/Sao_Paulo:20261104T091500
DESCRIPTION:Entrar: https://meet.google.com/hwn-fknu-hur\\nOutro texto
END:VEVENT
BEGIN:VEVENT
UID:unica
SUMMARY:Call com cliente
DTSTART:20261106T180000Z
DTEND:20261106T190000Z
END:VEVENT
END:VCALENDAR`;

test('agenda: expande recorrência semanal com exceção', () => {
  const from = new Date(2026, 10, 2);
  const to = new Date(2026, 10, 9);
  const ev = expand(parseICS(ICS), from, to);
  const daily = ev.filter((e) => e.uid === 'daily-1');
  assert.equal(daily.length, 4); // seg a sex menos a quarta (EXDATE)
  assert.ok(!daily.some((e) => e.start.getDate() === 4));
  assert.equal(daily[0].start.getHours(), 9);
  assert.equal(daily[0].meetCode, 'meethwn-fknu-hur');
  assert.equal(ev.filter((e) => e.uid === 'unica').length, 1);
});

test('agenda: código do Meet bate com o nome do transcript', () => {
  assert.equal(meetCode({ description: 'https://meet.google.com/abc-defg-hij' }), 'meetabc-defg-hij');
});

test('roteador aprende após 3 escolhas iguais', () => {
  const o = [
    { category: 'escrita', choice: 'claude:profundo' },
    { category: 'escrita', choice: 'claude:profundo' },
    { category: 'escrita', choice: 'claude:profundo' },
    { category: 'codigo', choice: 'claude:equilibrado' },
  ];
  const learned = learnPreferences(o, 3);
  assert.deepEqual(learned, { escrita: 'claude:profundo' });
  const d = route('escreva um email para o cliente', { config, usage: {}, learned });
  assert.equal(d.model, 'opus');
  assert.ok(d.reasons.some((r) => r.startsWith('aprendido')));
});

test('orçamento: segundo plano troca para o Codex antes do chat', () => {
  const limits = { claude: { fiveHour: 0.75 }, codex: { fiveHour: 0.1 } };
  assert.equal(pickProvider('briefing', limits, config).provider, 'codex');
  assert.equal(pickProvider('busca', limits, config).provider, 'claude');
});

test('orçamento: com as duas cotas altas, segundo plano é adiado', () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const limits = { claude: { fiveHour: 0.8, fiveHourResetsAt: reset }, codex: { fiveHour: 0.9, fiveHourResetsAt: reset + 100 } };
  const r = pickProvider('briefing', limits, config);
  assert.ok(r.defer);
  assert.ok(r.defer >= reset * 1000);
});

test('análise de reunião é sempre no Claude, mesmo com o Codex ligado e a cota do Claude alta', () => {
  assert.equal(DEFAULT_CONFIG.features.meetings.provider, 'claude');
  assert.equal(DEFAULT_CONFIG.meetings.autoAnalyze, false, 'reunião nova espera você pedir a análise');
  assert.equal(pickProvider('meetings', { claude: { fiveHour: 0.95 }, codex: { fiveHour: 0 } }, config).provider, 'claude');
});

test('Codex desligado (o padrão): as funções automáticas não usam ele nem como reserva', () => {
  const off = structuredClone(DEFAULT_CONFIG);
  off.features.meetings.provider = 'codex';
  assert.equal(pickProvider('meetings', { claude: { fiveHour: 0.1 } }, off).provider, 'claude');
  off.features.briefing.provider = 'auto';
  const r = pickProvider('briefing', { claude: { fiveHour: 0.95, fiveHourResetsAt: Date.now() / 1000 + 600 }, codex: { fiveHour: 0 } }, off);
  assert.ok(r.defer, 'espera a cota do Claude em vez de ir para o Codex');
  assert.doesNotMatch(r.reason, /Codex/);
});

test('provedor ollama: respeita a função e liga/desliga pela config', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.features.correcao.provider = 'ollama';
  assert.equal(pickProvider('correcao', {}, c).provider, 'ollama');
  c.ollama.enabled = false;
  assert.equal(pickProvider('correcao', {}, c).provider, 'claude');
});

test('padrão: funções automáticas leves rodam no modelo local; reuniões seguem no Claude', () => {
  for (const k of ['briefing', 'busca', 'cobranca', 'slack', 'correcao']) assert.equal(pickProvider(k, {}, DEFAULT_CONFIG).provider, 'ollama', k);
  assert.equal(pickProvider('meetings', {}, DEFAULT_CONFIG).provider, 'claude');
});
