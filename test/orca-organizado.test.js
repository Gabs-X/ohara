// Orca organizado: nome com ícone e assunto (a conta fica no comentário, não no nome) e status no quadro pelo Git.
const test = require('node:test');
const assert = require('node:assert');
const { orcaLabels, statusFor, syncOrcaStatus } = require('../src/integrations/orca');

const NOW = new Date(2026, 10, 21);

test('nome: ícone do tipo da branch + assunto do briefing; conta, data e objetivo no comentário', () => {
  const l = orcaLabels({ request: 'abre o orca ai pra eu fala da sua burrice', title: 'Roteamento da Ohara', branch: 'fix/ohara-roteamento', account: 'imlaw', objective: 'Parar de abrir o Orca para perguntas.', now: NOW });
  assert.equal(l.name, '🐛 Roteamento da Ohara');
  assert.equal(l.comment, 'Conta: Escritório (ImLaw) · aberto pela Ohara em 21/11 · Objetivo: Parar de abrir o Orca para perguntas.');
  assert.equal(l.terminalTitle, '🐛 Roteamento da Ohara · Escritório (ImLaw)');
  assert.doesNotMatch(l.name, /\[|ImLaw/, 'a conta não vai no nome (parecia o projeto)');
});

test('ícones por tipo e sem briefing: 💬 com as palavras do pedido', () => {
  const ic = (branch) => orcaLabels({ request: 'x', title: 'T', branch, now: NOW }).name.split(' ')[0];
  assert.deepEqual(['feat/a', 'fix/a', 'chore/a', 'docs/a', 'refactor/a', 'perf/a', 'sem-tipo', null].map(ic), ['✨', '🐛', '🔧', '📝', '♻️', '⚡', '💬', '💬']);
  const l = orcaLabels({ request: 'vamos colocar um bot para revisar os commits', account: 'pessoal', now: NOW });
  assert.equal(l.name, '💬 Vamos colocar bot revisar commits');
  assert.match(l.comment, /^Conta: Pessoal · aberto pela Ohara em 21\/11 · Objetivo: vamos colocar/);
});

test('status: pendente = Em andamento; commit pronto = Em revisão; entrou na principal = Concluído', () => {
  assert.equal(statusFor({ dirty: 3, merged: true, hadWork: true, ahead: 2 }), 'in-progress');
  assert.equal(statusFor({ dirty: 0, merged: false, hadWork: true, ahead: 2 }), 'in-review');
  assert.equal(statusFor({ dirty: 0, merged: true, hadWork: true, ahead: 0 }), 'completed');
  // recém-criada: mesma ponta da principal, mas sem commit próprio → ainda Em andamento
  assert.equal(statusFor({ dirty: 0, merged: true, hadWork: false, ahead: 0 }), 'in-progress');
});

test('sincronizar: só troca o que mudou e nunca mexe no principal, em pasta comum ou arquivado', async () => {
  const repos = [{ id: 'r1', path: 'C:/p/ohara', kind: 'git' }, { id: 'r2', path: 'C:/Claude', kind: 'folder' }];
  const worktrees = [
    { repoId: 'r1', path: 'C:/p/ohara', isMainWorktree: true, displayName: 'master' },
    { repoId: 'r1', path: 'C:/w/a', branch: 'refs/heads/feat/a', displayName: '✨ A', workspaceStatus: 'in-progress' },
    { repoId: 'r1', path: 'C:/w/b', branch: 'refs/heads/fix/b', displayName: '🐛 B', workspaceStatus: 'in-review' },
    { repoId: 'r1', path: 'C:/w/c', branch: 'refs/heads/feat/c', displayName: '✨ C', workspaceStatus: 'in-progress', isArchived: true },
    { repoId: 'r2', path: 'C:/Claude', displayName: 'Claude' },
  ];
  const git = { 'C:/w/a': { dirty: 0, merged: true, hadWork: true, ahead: 0 }, 'C:/w/b': { dirty: 0, merged: false, hadWork: true, ahead: 1 } };
  const sets = [];
  const changed = await syncOrcaStatus({ orca: {} }, {
    list: async () => ({ repos, worktrees }),
    set: async (w, s) => sets.push([w.path, s]),
    gitState: async (_repo, wt) => git[wt] || null,
  });
  assert.deepEqual(sets, [['C:/w/a', 'completed']]);
  assert.deepEqual(changed, [{ name: '✨ A', from: 'in-progress', to: 'completed' }]);
});

test('sincronizar com o Orca fechado não faz nada nem lança', async () => {
  const changed = await syncOrcaStatus({ orca: {} }, { list: async () => { throw new Error('Orca fechado'); } });
  assert.deepEqual(changed, []);
});
