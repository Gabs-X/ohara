// Checagem de saúde (edição Guia): o que está instalado, logado e funcionando, em português simples,
// com o conserto de cada item. Também diz ao roteador quais IAs estão prontas para uso.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDERS } = require('./providers/registry');
const { ollamaModels } = require('./providers/ollama');

function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 8000, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function defaultInternet() {
  try {
    const res = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(4000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

const home = () => os.homedir();

// Onde cada CLI guarda o login. A presença do arquivo (ou da chave de API) basta: validar de verdade gastaria cota.
function loginFiles(id, config, env = process.env) {
  switch (id) {
    case 'claude': {
      const dir = (config.claude?.configDir || env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude')).replace(/^~(?=$|[\\/])/, home());
      return { files: [path.join(dir, '.credentials.json')], env: ['ANTHROPIC_API_KEY'] };
    }
    case 'codex':
      return { files: [path.join(env.CODEX_HOME || path.join(home(), '.codex'), 'auth.json')], env: ['OPENAI_API_KEY'] };
    case 'gemini':
      return { files: [path.join(home(), '.gemini', 'oauth_creds.json'), path.join(home(), '.gemini', '.env')], env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] };
    default:
      return { files: [], env: [] };
  }
}

async function installedPath(bin, run) {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [bin]);
  if (r.ok && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  // O Codex do npm às vezes não está no PATH do app: confere a pasta global do npm.
  if (bin === 'codex') {
    const js = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return js;
  }
  return null;
}

/**
 * @param {object} o { config, run?, exists?, internet?, listOllama?, env? } (os opcionais servem para testes)
 * @returns {Promise<{ items: object[], available: string[], ready: boolean, checkedAt: number }>}
 */
async function checkHealth(o) {
  const { config } = o;
  const run = o.run || defaultRun;
  const exists = o.exists || fs.existsSync;
  const env = o.env || process.env;
  const items = [];

  const [node, git, online] = await Promise.all([
    run('node', ['-v']),
    run('git', ['--version']),
    (o.internet || defaultInternet)(),
  ]);
  items.push({
    id: 'internet', group: 'base', label: 'Internet', ok: online,
    detail: online ? 'Conectado.' : 'Sem internet: só a IA local funciona.',
    fix: online ? null : { action: 'info', text: 'Confira o Wi-Fi ou o cabo de rede.' },
  });
  items.push({
    id: 'node', group: 'base', label: 'Node.js', ok: node.ok,
    detail: node.ok ? `Instalado (${node.stdout.trim()}).` : 'Não instalado. É necessário para instalar as IAs e rodar projetos.',
    fix: node.ok ? null : { action: 'install', command: 'winget install --id OpenJS.NodeJS.LTS -e', url: 'https://nodejs.org' },
  });
  items.push({
    id: 'git', group: 'base', label: 'Git', ok: git.ok,
    detail: git.ok ? 'Instalado. A Ohara usa para os pontos de restauração.' : 'Não instalado. Sem ele não há "desfazer" nos projetos.',
    fix: git.ok ? null : { action: 'install', command: 'winget install --id Git.Git -e', url: 'https://git-scm.com' },
  });

  const available = [];
  for (const id of ['claude', 'codex', 'gemini']) {
    const p = PROVIDERS[id];
    if (config.providers?.[id]?.enabled === false) {
      items.push({ id, group: 'ia', label: p.label, ok: false, off: true, detail: 'Desligada nos Ajustes.', fix: null });
      continue;
    }
    const bin = config[id]?.bin || p.bin;
    const where = await installedPath(bin, run);
    if (!where) {
      items.push({ id, group: 'ia', label: p.label, ok: false, detail: `Não instalado. ${p.help}`, fix: node.ok ? { action: 'install', command: p.install.command, url: p.install.url } : { action: 'info', text: 'Instale o Node.js primeiro.' } });
      continue;
    }
    const lf = loginFiles(id, config, env);
    const logged = lf.files.some((f) => exists(f)) || lf.env.some((k) => !!env[k]);
    if (!logged) {
      items.push({ id, group: 'ia', label: p.label, ok: false, detail: 'Instalado, mas falta fazer login.', fix: { action: 'login', command: p.login.command, hint: p.login.hint } });
      continue;
    }
    items.push({ id, group: 'ia', label: p.label, ok: true, detail: `Pronto para uso (${p.vendor}).`, fix: null });
    if (online) available.push(id);
  }

  // IA local.
  if (config.providers?.ollama?.enabled === false || config.ollama?.enabled === false) {
    items.push({ id: 'ollama', group: 'ia', label: 'IA local', ok: false, off: true, detail: 'Desligada nos Ajustes.', fix: null });
  } else {
    const models = await (o.listOllama || ollamaModels)(config);
    const want = config.ollama?.model;
    if (!models) {
      items.push({ id: 'ollama', group: 'ia', label: 'IA local', ok: false, optional: true, detail: 'O Ollama não está instalado ou não está aberto. É opcional: deixa conversas simples de graça.', fix: { action: 'install', command: PROVIDERS.ollama.install.command, url: PROVIDERS.ollama.install.url } });
    } else if (want && !models.some((m) => m === want || m.startsWith(`${want}:`))) {
      items.push({ id: 'ollama', group: 'ia', label: 'IA local', ok: false, optional: true, detail: `O Ollama está aberto, mas o modelo ${want} não foi baixado (uns 5 GB).`, fix: { action: 'install', command: `ollama pull ${want}` } });
    } else {
      items.push({ id: 'ollama', group: 'ia', label: 'IA local', ok: true, detail: `Pronta (${want}).`, fix: null });
      available.push('ollama');
    }
  }

  return { items, available, ready: available.length > 0, checkedAt: Date.now() };
}

/** Abre um terminal visível com o comando (instalar ou logar), para ele acompanhar e responder ao que for pedido. */
function openTerminal(command, cwd = os.homedir()) {
  if (!/^[\w@:./\- ]+$/.test(command)) throw new Error('Comando inválido.');
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '"Ohara"', 'cmd.exe', '/k', command], { cwd, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', command], { cwd, detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { checkHealth, openTerminal, loginFiles };
