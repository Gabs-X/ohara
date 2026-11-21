const test = require('node:test');
const assert = require('node:assert');
const { branchSlug, norm } = require('../src/integrations/orca');
const { buildHistory, systemPrompt } = require('../src/core/local-chat');
const { DEFAULT_CONFIG } = require('../src/core/config');

test('nome da branch: palavras do pedido, sem acento nem palavras vazias', () => {
  assert.equal(branchSlug('corrige o bug do login no taverna bot'), 'corrige-bug-login-taverna-bot');
  assert.equal(branchSlug('Preciso que você adicione um botão de exportação!'), 'adicione-botao-exportacao');
  assert.equal(branchSlug('???'), 'tarefa');
  assert.ok(branchSlug('uma frase extremamente longa '.repeat(10)).length <= 40);
});

test('caminhos do Windows e do Orca são comparados do mesmo jeito', () => {
  assert.equal(norm('C:\\Repositorios\\pixaflow\\snake-window\\'), norm('c:/repositorios/pixaflow/snake-window'));
});

test('histórico do modelo local: mantém as mensagens mais recentes dentro do orçamento', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', text: `mensagem ${i} ` + 'x'.repeat(1000) });
  const h = buildHistory(msgs);
  assert.ok(h.length < 40 && h.length > 3);
  assert.match(h.at(-1).content, /mensagem 39/, 'a última entra');
  assert.ok(h.reduce((n, m) => n + m.content.length, 0) <= 14_000);
  assert.deepEqual(buildHistory([{ role: 'user', text: '' }]), [], 'mensagem vazia fica de fora');
});

test('o prompt do modelo local diz que ele consulta o PC, não altera nada e oferece a automelhoria', () => {
  const p = systemPrompt(DEFAULT_CONFIG, { project: 'ohara' });
  assert.match(p, /NÃO altera nada/);
  assert.match(p, /CONSULTA o PC/);
  assert.match(p, /\[\[melhoria:/);
  assert.match(p, /Projeto em foco nesta conversa: ohara/);
});

test('taskTitle: nome curto e legível para a aba do console', () => {
  const { taskTitle } = require('../src/integrations/orca');
  assert.equal(taskTitle('corrige o bug do login no taverna bot'), 'Corrige bug login taverna bot');
  assert.equal(taskTitle(''), 'Tarefa');
});
