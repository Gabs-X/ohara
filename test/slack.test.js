const test = require('node:test');
const assert = require('node:assert');
const { Slack } = require('../src/integrations/slack');

const people = [
  { id: 'U1', real_name: 'João Silva', name: 'joao.silva', profile: { display_name: '' } },
  { id: 'U2', real_name: 'Jo Lima', name: 'jo', profile: { display_name: '' } },
  { id: 'U3', real_name: 'Maria Souza', name: 'msouza', profile: { display_name: 'Mari' } },
  { id: 'U4', real_name: 'Maria Costa', name: 'mcosta', profile: { display_name: '' } },
];
const slack = () => {
  const s = new Slack({ getConfig: () => ({ integrations: { slack: { token: 'x' } } }) });
  s.users = people;
  return s;
};

test('Slack: nome vazio não escolhe ninguém', async () => {
  assert.strictEqual(await slack().findUser(''), null);
  assert.strictEqual(await slack().findUser(null), null);
});

test('Slack: nome completo e prefixo por palavra inteira', async () => {
  assert.strictEqual((await slack().findUser('João Silva')).id, 'U1');
  assert.strictEqual((await slack().findUser('joao')).id, 'U1');
  assert.strictEqual((await slack().findUser('Jo Lima')).id, 'U2');
  assert.strictEqual((await slack().findUser('Maria Souza')).id, 'U3');
});

test('Slack: ambíguo não manda para ninguém', async () => {
  assert.strictEqual(await slack().findUser('Maria'), null);
});
