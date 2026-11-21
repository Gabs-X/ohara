const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { isAppPage, sanitizeConfigPatch, assertSafeToOpen } = require('../src/core/ipc-guard');

const dir = path.join(__dirname, '..', 'src', 'renderer');

test('isAppPage aceita só as páginas do renderer', () => {
  assert.ok(isAppPage(pathToFileURL(path.join(dir, 'index.html')).href, dir));
  assert.ok(isAppPage(pathToFileURL(path.join(dir, 'quick.html')).href + '#x', dir));
  assert.ok(!isAppPage(pathToFileURL('C:\\Users\\x\\Downloads\\malicioso.html').href, dir));
  assert.ok(!isAppPage(pathToFileURL(path.join(dir, 'app.js')).href, dir));
  assert.ok(!isAppPage(pathToFileURL(path.join(dir, 'sub', 'a.html')).href, dir));
  assert.ok(!isAppPage('https://exemplo.com/', dir));
});

test('sanitizeConfigPatch remove executáveis e chaves de protótipo', () => {
  const out = sanitizeConfigPatch(JSON.parse('{"orca":{"bin":"C:/x.exe","enabled":true},"claude":{"bin":"x"},"__proto__":{"a":1},"voice":{"wakeWord":true}}'));
  assert.deepStrictEqual(out, { orca: { enabled: true }, claude: {}, voice: { wakeWord: true } });
  assert.deepStrictEqual(sanitizeConfigPatch(null), {});
  assert.deepStrictEqual(sanitizeConfigPatch({ list: [1, 2] }), { list: [1, 2] });
});

test('assertSafeToOpen recusa programas e atalhos', () => {
  assert.strictEqual(assertSafeToOpen('C:\\docs\\contrato.pdf'), 'C:\\docs\\contrato.pdf');
  assert.strictEqual(assertSafeToOpen('C:\\docs'), 'C:\\docs');
  for (const p of ['C:\\x\\a.exe', 'C:\\x\\a.BAT', 'C:\\x\\a.lnk', 'C:\\x\\a.ps1', 'C:\\x\\a.exe.', 'C:\\x\\a.url ']) {
    assert.throws(() => assertSafeToOpen(p), /segurança/, p);
  }
  assert.throws(() => assertSafeToOpen(''), /inválido/);
  assert.throws(() => assertSafeToOpen('ms-settings:privacy'), /inválido/);
});
