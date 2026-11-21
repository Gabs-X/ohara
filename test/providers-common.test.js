const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { runJsonl } = require('../src/core/providers/common');

test('pasta de trabalho inexistente vira mensagem clara (não "spawn ENOENT")', async () => {
  const cwd = path.join(os.tmpdir(), `ohara-nao-existe-${Date.now()}`);
  await assert.rejects(runJsonl({ cmd: process.execPath, args: ['-e', ''], cwd, input: 'x', onJson() {} }), /não existe mais/);
});

test('programa ausente vira mensagem clara', async () => {
  await assert.rejects(runJsonl({ cmd: 'ohara-programa-inexistente', args: [], cwd: os.tmpdir(), input: 'x', onJson() {} }), /Não encontrei o programa/);
});

test('processo que sai sem ler a entrada não derruba o app (EPIPE)', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024);
  const r = await runJsonl({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], cwd: os.tmpdir(), input: big, onJson() {} });
  assert.equal(r.code, 0);
});

test('entrega as linhas JSON e ignora o resto', async () => {
  const got = [];
  const script = 'console.log("lixo"); console.log(JSON.stringify({a:1})); process.stdin.resume(); process.stdin.on("end",()=>{})';
  const r = await runJsonl({ cmd: process.execPath, args: ['-e', script], cwd: os.tmpdir(), input: 'oi', onJson: (j) => got.push(j) });
  assert.equal(r.code, 0);
  assert.deepEqual(got, [{ a: 1 }]);
});
