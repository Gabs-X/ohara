const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeArgs } = require('../src/core/providers/claude');
const { DEFAULT_CONFIG } = require('../src/core/config');

const base = (claude = {}, extra = {}) => ({
  model: 'sonnet',
  effort: 'medium',
  systemPrompt: 'sp',
  config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, ...claude } },
  ...extra,
});

test('Claude in Chrome vem ligado por padrão', () => {
  assert.equal(DEFAULT_CONFIG.claude.chrome, true);
  assert.ok(buildClaudeArgs(base()).includes('--chrome'));
});

test('configuração antiga sem a chave chrome também liga o Chrome', () => {
  const o = base();
  delete o.config.claude.chrome;
  assert.ok(buildClaudeArgs(o).includes('--chrome'));
});

test('desligar o Chrome em Ajustes tira a flag', () => {
  assert.ok(!buildClaudeArgs(base({ chrome: false })).includes('--chrome'));
});

test('mantém modo de permissão, pasta extra e retomada de sessão', () => {
  const args = buildClaudeArgs(base({}, { sessionId: 'abc', permissionMode: 'bypassPermissions' }));
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'abc']);
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', DEFAULT_CONFIG.workspaceRoot]);
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'sp');
});
