const test = require('node:test');
const assert = require('node:assert');
const { routeMulti } = require('../src/core/multi-router');
const { geminiStream, buildGeminiArgs, statsTokens, friendlyGeminiError } = require('../src/core/providers/gemini');
const { providerSpec, routeLabel } = require('../src/core/providers/registry');

const config = { codex: { model: '' }, ollama: { model: 'qwen2.5:7b' }, orchestration: { mode: 'economia' } };
const all = new Set(['claude', 'codex', 'gemini', 'ollama']);
const r = (prompt, extra = {}) => routeMulti(prompt, { config, available: all, ...extra });

test('pergunta curta fica na IA local, que não gasta cota', () => {
  const d = r('quanto é 15% de 240?');
  assert.equal(d.category, 'rapida');
  assert.equal(d.provider, 'ollama');
  assert.ok(d.fallbacks.length >= 2, 'guarda reservas');
});

test('pedido com ferramentas nunca vai para a IA local', () => {
  const d = r('corrige o bug na função de login do repositório');
  assert.equal(d.category, 'codigo');
  assert.notEqual(d.provider, 'ollama');
  assert.ok(!d.fallbacks.some((f) => f.provider === 'ollama'));
});

test('no modo economia, o mais barato com ferramentas ganha (Gemini)', () => {
  assert.equal(r('corrige o bug na função de login do repositório').provider, 'gemini');
});

test('IA com a cota alta perde a vez para outra', () => {
  const d = r('corrige o bug na função de login do repositório', { limits: { gemini: { daily: 0.9 } } });
  assert.notEqual(d.provider, 'gemini');
  assert.equal(d.fallbacks.at(-1).provider, 'gemini', 'fica como última reserva');
});

test('cota esgotada tira a IA da lista', () => {
  const d = r('corrige o bug na função de login', { limits: { gemini: { status: 'rejected' } } });
  assert.ok(![d.provider, ...d.fallbacks.map((f) => f.provider)].includes('gemini'));
  assert.ok(d.reasons.some((x) => /cota esgotada/.test(x)));
});

test('planejamento pede o nível profundo', () => {
  const d = r('qualquer coisa', { category: 'planejamento' });
  assert.equal(d.tier, 'profundo');
  assert.notEqual(d.provider, 'ollama');
});

test('modo qualidade prefere o modelo mais forte', () => {
  const d = routeMulti('planeje a arquitetura', { config: { ...config, orchestration: { mode: 'qualidade' } }, available: all, category: 'planejamento' });
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, 'opus');
});

test('nível profundo cai para equilibrado com a cota acima de 70%', () => {
  const cfg = { ...config, orchestration: { mode: 'qualidade' } };
  const d = routeMulti('x', { config: cfg, available: new Set(['claude']), category: 'planejamento', limits: { claude: { fiveHour: 0.75 } } });
  assert.equal(d.model, 'sonnet');
  assert.ok(d.reasons.some((x) => /profundo trocado/.test(x)));
});

test('só as IAs disponíveis entram', () => {
  const d = r('corrige o bug na função', { available: new Set(['codex']) });
  assert.equal(d.provider, 'codex');
  assert.deepEqual(d.fallbacks, []);
});

test('sem nenhuma IA, devolve erro amigável', () => {
  const d = r('oi', { available: new Set() });
  assert.equal(d.provider, null);
  assert.match(d.error, /Primeiros passos/);
});

test('imagem não vai para a IA local', () => {
  const d = r('o que tem nessa tela?', { hasImage: true });
  assert.equal(d.category, 'visao');
  assert.notEqual(d.provider, 'ollama');
});

test('escolha manual respeita a IA e o nível', () => {
  const d = r('oi', { override: 'claude:profundo' });
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, 'opus');
});

test('escolha manual de IA indisponível volta para o automático', () => {
  const d = r('oi', { override: 'codex:medium', available: new Set(['ollama']) });
  assert.equal(d.provider, 'ollama');
  assert.ok(d.reasons[0].includes('não está disponível'));
});

test('preferência por categoria puxa a IA', () => {
  const cfg = { ...config, orchestration: { mode: 'economia', prefer: { codigo: 'claude' } } };
  assert.equal(routeMulti('corrige o bug na função de login', { config: cfg, available: all }).provider, 'claude');
});

test('conversa dentro de projeto exige ferramentas', () => {
  const d = r('me explica melhor esse ponto aqui sobre a tela de cadastro dos clientes', { needsTools: true });
  assert.notEqual(d.provider, 'ollama');
});

test('IA desligada nos ajustes não entra', () => {
  const cfg = { ...config, providers: { gemini: { enabled: false } } };
  const d = routeMulti('corrige o bug na função', { config: cfg, available: all });
  assert.ok(![d.provider, ...d.fallbacks.map((f) => f.provider)].includes('gemini'));
});

test('registro: modelo da IA local vem da configuração', () => {
  assert.equal(providerSpec('ollama', config).tiers.rapido.model, 'qwen2.5:7b');
  assert.equal(routeLabel('claude', 'profundo', 'opus'), 'Claude Opus');
});

// ---------- Gemini ----------
test('gemini: lê o fluxo de eventos do CLI', () => {
  const events = [];
  const { onJson, state } = geminiStream((e) => events.push(e), 'flash');
  onJson({ type: 'init', session_id: 'abc', model: 'gemini-2.5-flash' });
  onJson({ type: 'message', role: 'user', content: 'oi' });
  onJson({ type: 'message', role: 'assistant', content: 'Olá', delta: true });
  onJson({ type: 'tool_use', tool_name: 'run_shell_command', parameters: { command: 'dir' } });
  onJson({ type: 'message', role: 'assistant', content: ', tudo certo.', delta: true });
  onJson({ type: 'result', status: 'success', stats: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } });
  assert.equal(state.sessionId, 'abc');
  assert.equal(state.model, 'gemini-2.5-flash');
  assert.equal(state.text, 'Olá, tudo certo.');
  assert.deepEqual(state.tokens, { input: 120, cached: 0, output: 30 });
  assert.ok(events.some((e) => e.kind === 'tool' && e.text.includes('dir')));
});

test('gemini: resposta final só no result', () => {
  const { onJson, state } = geminiStream(() => {}, 'pro');
  onJson({ type: 'result', status: 'success', response: 'pronto', stats: { total_tokens: 40 } });
  assert.equal(state.text, 'pronto');
  assert.equal(statsTokens({ total_tokens: 40 }).input, 40);
});

test('gemini: erro de cota vira mensagem amigável', () => {
  const { onJson, state } = geminiStream(() => {}, 'pro');
  onJson({ type: 'result', status: 'error', error: { message: '429 RESOURCE_EXHAUSTED' } });
  assert.match(friendlyGeminiError(state.error), /cota grátis/);
});

test('gemini: argumentos do modo sem interface', () => {
  const a = buildGeminiArgs({ model: 'flash' });
  assert.deepEqual(a.slice(0, 2), ['--output-format', 'stream-json']);
  assert.ok(a.includes('-m') && a.includes('flash'));
  assert.ok(a.includes('--approval-mode'));
  assert.ok(!buildGeminiArgs({ model: 'auto' }).includes('-m'));
});
