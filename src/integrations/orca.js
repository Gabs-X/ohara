// Integração com o Orca (https://github.com/stablyai/orca): quando um pedido exige o Claude
// (alterar código, comandos, pesquisa), a Ohara não chama o Claude sozinha: abre o Orca no
// projeto, cria uma worktree com a branch da tarefa e inicia o Claude no console já com o contexto.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STOP = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'no', 'na', 'nos', 'nas', 'em', 'para', 'pra', 'por', 'com', 'que', 'e', 'ou', 'me', 'te', 'se', 'ao', 'aos', 'isso', 'esse', 'essa', 'ele', 'ela', 'favor', 'pode', 'poderia', 'quero', 'preciso', 'voce', 'gostaria', 'ohara']);

function orcaBin(config) {
  const custom = config?.orca?.bin;
  if (custom && fs.existsSync(custom)) return custom;
  const std = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
  return fs.existsSync(std) ? std : 'orca';
}

function run(bin, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`o Orca não respondeu em ${Math.round(timeout / 1000)}s`));
    }, timeout);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error('Orca não encontrado (configure orca.bin nos Ajustes)') : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Roda um comando do Orca com --json e devolve `result`.
async function orcaJson(bin, args, opts) {
  const { code, stdout, stderr } = await run(bin, [...args, '--json'], opts);
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {}
  if (!parsed?.ok) {
    const msg = parsed?.error?.message || parsed?.error || stderr.trim() || stdout.trim() || `código ${code}`;
    throw new Error(`orca ${args.slice(0, 2).join(' ')}: ${String(msg).slice(0, 300)}`);
  }
  return parsed.result;
}

const norm = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Garante o Orca aberto e com o runtime pronto (abre o app se precisar).
async function ensureOrca(bin, { waitMs = 90_000 } = {}) {
  const ready = async () => {
    try {
      const { stdout } = await run(bin, ['status'], { timeout: 15_000 });
      return /runtimeReachable:\s*true/.test(stdout);
    } catch {
      return false;
    }
  };
  if (await ready()) return { started: false };
  const child = spawn(bin, ['open'], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await ready()) return { started: true };
  }
  throw new Error('o Orca não ficou pronto a tempo');
}

// Raiz do repositório git da pasta (ou null se for uma pasta comum).
function gitRoot(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { windowsHide: true }, (err, out) => resolve(err ? null : out.trim()));
  });
}

// "corrige o bug do login no taverna bot" → "corrige-bug-login-taverna-bot"
function branchSlug(text, max = 5) {
  const words = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const slug = words.slice(0, max).join('-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  return slug || 'tarefa';
}

// Seletor que o `orca account select` aceita para a conta escolhida ("imlaw" ou "pessoal").
function accountSelector(config, key) {
  const set = config?.orca?.accounts?.[key]?.account;
  if (set) return set;
  if (key === 'imlaw') return 'system';
  try {
    const dir = (config?.claude?.configDir || path.join(os.homedir(), '.claude-pessoal')).replace(/^~(?=$|[\\/])/, os.homedir());
    return JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount?.emailAddress || null;
  } catch {
    return null;
  }
}

// Faz o próximo Claude aberto no Orca usar a conta escolhida.
async function selectAccount(bin, config, key) {
  const label = config?.orca?.accounts?.[key]?.label || key;
  const selector = accountSelector(config, key);
  if (!selector) throw new Error(`não achei o login da conta "${label}" (configure orca.accounts.${key}.account)`);
  try {
    await orcaJson(bin, ['account', 'select', '--agent', 'claude', '--account', selector]);
  } catch (err) {
    throw new Error(`a conta "${label}" não está cadastrada no Orca. Rode \`orca account add --agent claude\` e entre com ela. (${err.message})`);
  }
}

async function findRepo(bin, root) {
  const { repos = [] } = await orcaJson(bin, ['repo', 'list']);
  return repos.find((r) => norm(r.path) === norm(root)) || null;
}

const ACCOUNT_TAG = { imlaw: 'ImLaw', pessoal: 'Pessoal' };

// Texto curto do pedido para servir de nome ("corrige o bug do login" → "Corrige bug login").
function taskTitle(request, max = 5) {
  const words = String(request || '').replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
  const t = words.slice(0, max).join(' ').slice(0, 40).trim() || 'tarefa';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Deixa fácil de achar no Orca qual console é de qual projeto/tarefa/conta: dá nome à aba do terminal
// ("[ImLaw] projeto · Tarefa") e ao workspace (nome + comentário). Só enfeite: se falhar, não atrapalha.
async function labelConsole(bin, { terminal, worktree, root, request, account }) {
  const tag = ACCOUNT_TAG[account] || null;
  const project = path.basename(root || '') || 'projeto';
  const task = taskTitle(request);
  const title = `${tag ? `[${tag}] ` : ''}${project} · ${task}`;
  if (terminal) await orcaJson(bin, ['terminal', 'rename', '--terminal', terminal, '--title', title]).catch(() => {});
  if (worktree) {
    const comment = `Ohara · ${tag ? `Conta: ${tag} · ` : ''}Pedido: ${String(request || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    await orcaJson(bin, ['worktree', 'set', '--worktree', `id:${worktree}`, '--display-name', `${tag ? `[${tag}] ` : ''}${task}`, '--comment', comment]).catch(() => {});
  }
  return title;
}

// O Orca roda o agente com o prompt na linha de comando do shell do terminal: a primeira quebra de linha
// encerra o comando (o Claude só recebia a 1ª linha, sem o pedido) e o cmd corta acima de ~8 mil caracteres.
// Prompt com várias linhas ou longo vai para um arquivo, e o Claude recebe uma linha só apontando para ele.
const INLINE_MAX = 1500;
const PROMPT_TTL = 7 * 24 * 60 * 60_000;

function singleLinePrompt(prompt, { dir = path.join(os.tmpdir(), 'ohara-orca'), now = Date.now() } = {}) {
  const text = String(prompt || '').trim();
  if (!/[\r\n]/.test(text) && text.length <= INLINE_MAX) return text;
  fs.mkdirSync(dir, { recursive: true });
  // Limpa tarefas antigas (só arrumação: se falhar, não atrapalha).
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > PROMPT_TTL) fs.rmSync(p, { force: true });
    }
  } catch {}
  const file = path.join(dir, `tarefa-${now}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  return `A Ohara, assistente pessoal do Gabriel, mandou uma tarefa. O pedido completo, com o contexto e as regras, está no arquivo ${file} - leia esse arquivo inteiro antes de qualquer coisa e siga o que ele pede. Responda em português do Brasil.`;
}

function handleOf(result) {
  return result?.launch?.outcome?.handle || result?.agentTerminalHandle || result?.launch?.handle || null;
}

/**
 * Manda a tarefa para o Claude no Orca.
 * @param {object} o
 * @param {object} o.config
 * @param {string} o.cwd       pasta do projeto (se for repositório git, cria worktree + branch)
 * @param {string} o.request   o pedido (usado no nome da branch)
 * @param {string} o.prompt    texto completo enviado ao Claude (pedido + contexto)
 * @param {object} [o.state]   estado anterior desta conversa neste projeto, para continuar no mesmo console
 * @param {string} [o.account] conta do Claude escolhida ("imlaw" ou "pessoal"); vale para o console novo
 * @returns {Promise<{state:object, branch:string|null, worktree:string|null, reused:boolean, root:string, kind:'git'|'folder', startedOrca:boolean}>}
 */
async function sendToOrca({ config, cwd, request, prompt, state = null, account = null }) {
  const bin = orcaBin(config);
  const agent = config.orca?.agent || 'claude';
  const { started: startedOrca } = await ensureOrca(bin);
  const line = singleLinePrompt(prompt);

  const top = await gitRoot(cwd);
  const root = top || cwd;
  const kind = top ? 'git' : 'folder';

  let repo = await findRepo(bin, root);
  if (!repo) {
    const args = ['repo', 'add', '--path', root];
    if (kind === 'folder') args.push('--kind', 'folder');
    const added = await orcaJson(bin, args);
    repo = added.repo || added;
    if (!repo?.id) repo = await findRepo(bin, root);
    if (!repo?.id) throw new Error('não consegui registrar o projeto no Orca');
  }

  // Continuação: o Claude desta conversa ainda está aberto no mesmo console → manda o pedido para ele.
  if (state && state.repoId === repo.id && state.terminal) {
    try {
      await orcaJson(bin, ['terminal', 'show', '--terminal', state.terminal]);
      await orcaJson(bin, ['terminal', 'send', '--terminal', state.terminal, '--text', line, '--enter']);
      return { state, branch: state.branch, worktree: state.worktree, reused: true, root, kind, startedOrca };
    } catch {
      // console fechado: segue e abre um novo na mesma worktree, se ela ainda existir
    }
  }

  // Console novo: o Claude que abrir usa a conta escolhida.
  const acc = account || state?.account || null;
  if (acc) await selectAccount(bin, config, acc);

  if (kind === 'git') {
    if (state?.repoId === repo.id && state.worktree) {
      try {
        const res = await orcaJson(bin, ['agent', 'launch', '--agent', agent, '--worktree', `id:${state.worktree}`, '--prompt', line, '--surface', 'terminal', '--focus']);
        const next = { ...state, account: acc, terminal: handleOf(res) };
        await labelConsole(bin, { terminal: next.terminal, worktree: state.worktree, root, request, account: acc });
        return { state: next, branch: state.branch, worktree: state.worktree, reused: true, root, kind, startedOrca };
      } catch {
        // worktree apagada: cria outra
      }
    }
    const name = branchSlug(request);
    const res = await orcaJson(bin, ['worktree', 'create', '--repo', `id:${repo.id}`, '--name', name, '--branch', name, '--agent', agent, '--prompt', line, '--surface', 'terminal', '--activate'], { timeout: 180_000 });
    const wt = res.worktree || res;
    const next = { repoId: repo.id, account: acc, worktree: wt.id || null, branch: String(wt.branch || name).replace(/^refs\/heads\//, ''), terminal: handleOf(res) };
    await labelConsole(bin, { terminal: next.terminal, worktree: next.worktree, root, request, account: acc });
    return { state: next, branch: next.branch, worktree: next.worktree, reused: false, root, kind, startedOrca };
  }

  // Pasta comum (sem git): abre o Claude na própria pasta.
  const res = await orcaJson(bin, ['agent', 'launch', '--agent', agent, '--worktree', `path:${root}`, '--prompt', line, '--surface', 'terminal', '--focus']);
  const next = { repoId: repo.id, account: acc, worktree: null, branch: null, terminal: handleOf(res) };
  await labelConsole(bin, { terminal: next.terminal, root, request, account: acc });
  return { state: next, branch: null, worktree: null, reused: false, root, kind, startedOrca };
}

module.exports = { sendToOrca, singleLinePrompt, taskTitle, accountSelector, branchSlug, orcaBin, ensureOrca, norm };
