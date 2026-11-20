const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Checkpoints } = require('../src/core/checkpoints');
const { detectProject } = require('../src/core/project-runner');
const { checkHealth } = require('../src/core/health');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------- Pontos de restauração ----------
test('desfazer volta só o que a IA mexeu no pedido', async () => {
  const proj = tmp('ohara-proj-');
  const store = tmp('ohara-pontos-');
  const cp = new Checkpoints({ dir: store });
  fs.writeFileSync(path.join(proj, 'a.txt'), 'original');
  fs.writeFileSync(path.join(proj, 'b.txt'), 'b original');
  fs.mkdirSync(path.join(proj, 'node_modules'));
  fs.writeFileSync(path.join(proj, 'node_modules', 'x.js'), 'ignorado');

  const before = await cp.snapshot(proj, 'antes');
  // A "IA" muda a.txt, apaga b.txt e cria uma pasta nova.
  fs.writeFileSync(path.join(proj, 'a.txt'), 'mudado pela IA');
  fs.rmSync(path.join(proj, 'b.txt'));
  fs.mkdirSync(path.join(proj, 'novo'));
  fs.writeFileSync(path.join(proj, 'novo', 'c.txt'), 'criado');
  const after = await cp.snapshot(proj, 'depois');

  const changes = await cp.changes(proj, before, after);
  assert.deepEqual(changes.map((c) => `${c.status} ${c.file}`).sort(), ['A novo/c.txt', 'D b.txt', 'M a.txt']);

  // Depois do pedido, ele mexe à mão em outro arquivo: isso não pode ser desfeito.
  fs.writeFileSync(path.join(proj, 'meu.txt'), 'meu');
  await cp.undo(proj, before, after);
  assert.equal(fs.readFileSync(path.join(proj, 'a.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(proj, 'b.txt'), 'utf8'), 'b original');
  assert.ok(!fs.existsSync(path.join(proj, 'novo')), 'pasta criada pela IA some');
  assert.equal(fs.readFileSync(path.join(proj, 'meu.txt'), 'utf8'), 'meu');
  assert.ok(fs.existsSync(path.join(proj, 'node_modules', 'x.js')), 'node_modules intocado');
  assert.ok(!fs.existsSync(path.join(proj, '.git')), 'o projeto não ganha .git');

  const list = await cp.list(proj);
  assert.equal(list[0].label, 'antes de desfazer');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

test('não fotografa a pasta pessoal', () => {
  const cp = new Checkpoints({ dir: os.tmpdir() });
  assert.equal(cp.supported(os.homedir()).ok, false);
  assert.equal(cp.supported(path.join(os.tmpdir(), 'nao-existe-xyz')).ok, false);
});

// ---------- Abrir projeto ----------
test('detecta como rodar cada tipo de projeto', () => {
  const p = tmp('ohara-run-');
  assert.equal(detectProject(p).kind, 'none');
  fs.writeFileSync(path.join(p, 'index.html'), '<h1>oi</h1>');
  assert.equal(detectProject(p).kind, 'browser');
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const d = detectProject(p);
  assert.equal(d.kind, 'terminal');
  assert.equal(d.command, 'npm install && npm run dev');
  fs.mkdirSync(path.join(p, 'node_modules'));
  assert.equal(detectProject(p).command, 'npm run dev');
  fs.rmSync(p, { recursive: true, force: true });

  const py = tmp('ohara-py-');
  fs.writeFileSync(path.join(py, 'app.py'), 'print(1)');
  fs.writeFileSync(path.join(py, 'requirements.txt'), 'streamlit\n');
  assert.equal(detectProject(py).command, 'python -m pip install -r requirements.txt && streamlit run app.py');
  fs.rmSync(py, { recursive: true, force: true });
});

// ---------- Saúde ----------
const fakeRun = (installed) => async (cmd, args) => {
  if (cmd === 'node' || cmd === 'git') return { ok: installed.includes(cmd), stdout: 'v20', stderr: '' };
  if (cmd === 'where' || cmd === 'which') return installed.includes(args[0]) ? { ok: true, stdout: `C:\\bin\\${args[0]}.exe\n` } : { ok: false, stdout: '' };
  return { ok: false, stdout: '' };
};

test('saúde: só a IA instalada e logada fica disponível', async () => {
  const r = await checkHealth({
    config: { ollama: { model: 'qwen2.5:7b' } },
    run: fakeRun(['node', 'git', 'claude', 'gemini']),
    exists: (f) => f.includes('.claude') && f.endsWith('.credentials.json'),
    internet: async () => true,
    listOllama: async () => null,
    env: {},
  });
  assert.deepEqual(r.available, ['claude']);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by.gemini.fix.action, 'login');
  assert.equal(by.codex.fix.action, 'install');
  assert.match(by.codex.fix.command, /@openai\/codex/);
  assert.equal(by.ollama.optional, true);
  assert.equal(r.ready, true);
});

test('saúde: chave de API conta como login e modelo local faltando pede download', async () => {
  const r = await checkHealth({
    config: { ollama: { model: 'qwen2.5:7b' } },
    run: fakeRun(['node', 'git', 'gemini']),
    exists: () => false,
    internet: async () => true,
    listOllama: async () => ['llama3:8b'],
    env: { GEMINI_API_KEY: 'x' },
  });
  assert.deepEqual(r.available, ['gemini']);
  assert.equal(r.items.find((i) => i.id === 'ollama').fix.command, 'ollama pull qwen2.5:7b');
});

test('saúde: sem internet, só a IA local serve', async () => {
  const r = await checkHealth({
    config: { ollama: { model: 'qwen2.5:7b' } },
    run: fakeRun(['node', 'git', 'claude']),
    exists: () => true,
    internet: async () => false,
    listOllama: async () => ['qwen2.5:7b'],
    env: {},
  });
  assert.deepEqual(r.available, ['ollama']);
});
