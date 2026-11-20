// Correções de robustez: gravação de JSON, atalhos .cmd do npm, documentos malformados,
// privacidade e economia.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { JsonStore } = require('../src/core/store');
const { resolveWindowsShim } = require('../src/core/providers/common');
const { anonymize } = require('../src/core/local-tools');
const { computeSavings } = require('../src/core/savings');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-teste-'));

test('JsonStore recupera do .tmp quando o arquivo principal está corrompido ou sumiu', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'chats.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ chats: [{ id: 'a' }] }));
  fs.writeFileSync(file, '{"chats": [');
  assert.deepStrictEqual(new JsonStore(file, { chats: [] }).data.chats, [{ id: 'a' }]);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrompido-')));
  fs.rmSync(file);
  assert.deepStrictEqual(new JsonStore(file, { chats: [] }).data.chats, [{ id: 'a' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonStore sem arquivo nenhum volta aos padrões', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(new JsonStore(path.join(dir, 'x.json'), { a: 1 }).data, { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveWindowsShim lê o atalho .cmd do npm e roda o .js com o node', () => {
  const dir = tmpDir();
  const js = path.join(dir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '');
  fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n');
  const env = { PATH: dir };
  assert.deepStrictEqual(resolveWindowsShim('gemini', { platform: 'win32', env }), { cmd: 'node', pre: [js] });
  assert.strictEqual(resolveWindowsShim('gemini', { platform: 'linux', env }), null);
  assert.strictEqual(resolveWindowsShim('naoexiste', { platform: 'win32', env }), null);
  // Um .exe antes do .cmd no PATH: o spawn já acha sozinho.
  fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '"%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js"');
  assert.strictEqual(resolveWindowsShim('claude', { platform: 'win32', env }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractText não quebra com entidade inválida em HTML', async () => {
  const { extractText } = require('../src/core/doc-text');
  const dir = tmpDir();
  const f = path.join(dir, 'a.html');
  fs.writeFileSync(f, '<p>Oi &#99999999; &amp; tchau &#x41;</p>');
  const text = await extractText(f);
  assert.match(text, /Oi &#99999999; & tchau A/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zip bomb no .docx dá erro em vez de estourar a memória', async () => {
  const { extractText } = require('../src/core/doc-text');
  const dir = tmpDir();
  // Monta um zip mínimo com word/document.xml que descompacta para 150 MB.
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(Buffer.alloc(150 * 1024 * 1024, 0x41));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(name.length, 28);
  const cdOffset = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  const f = path.join(dir, 'bomba.docx');
  fs.writeFileSync(f, Buffer.concat([local, name, data, central, name, eocd]));
  await assert.rejects(() => extractText(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('anonymize strict lança erro quando a IA local falha; sem strict marca namesFailed', async () => {
  const ai = { generate: async () => { throw new Error('Ollama fora do ar'); } };
  const text = 'Maria Souza, CPF 123.456.789-09';
  const lenient = await anonymize({ config: {}, text, ai });
  assert.strictEqual(lenient.namesFailed, true);
  assert.ok(!lenient.text.includes('123.456.789-09'));
  await assert.rejects(() => anonymize({ config: {}, text, ai, strict: true }), /nomes/);
});

test('computeSavings com referência desconhecida usa a padrão', () => {
  const days = [{ byModel: { 'claude|claude-sonnet-4-5': { input: 1000, output: 1000, calls: 1 } } }];
  assert.doesNotThrow(() => computeSavings(days, { reference: 'inexistente' }));
});
