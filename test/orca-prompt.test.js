const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { singleLinePrompt } = require('../src/integrations/orca');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-orca-test-'));

test('prompt curto de uma linha vai direto, sem arquivo', () => {
  const dir = tmp();
  assert.equal(singleLinePrompt('agora ajusta a tela de ajustes', { dir }), 'agora ajusta a tela de ajustes');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('prompt com várias linhas vira uma linha só apontando para o arquivo com o texto completo', () => {
  const dir = tmp();
  const prompt = 'Você foi aberto pela Ohara.\nRegras: sem push.\n\nPedido do Gabriel:\ncorrige o bug do login';
  const line = singleLinePrompt(prompt, { dir });
  assert.doesNotMatch(line, /[\r\n]/, 'quebra de linha encerraria o comando no shell do Orca');
  const [file] = fs.readdirSync(dir);
  assert.ok(line.includes(path.join(dir, file)));
  assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), `${prompt}\n`);
});

test('prompt longo também vai para arquivo e tarefas antigas são apagadas', () => {
  const dir = tmp();
  const old = path.join(dir, 'tarefa-velha.md');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 8 * 24 * 60 * 60_000);
  fs.utimesSync(old, past, past);
  const line = singleLinePrompt('a'.repeat(5000), { dir });
  assert.ok(line.length < 1000);
  assert.ok(!fs.existsSync(old));
  assert.equal(fs.readdirSync(dir).length, 1);
});
