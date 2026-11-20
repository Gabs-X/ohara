// Pontos de restauração (edição Guia): antes e depois de cada pedido que mexe num projeto, a Ohara tira
// uma "foto" da pasta. "Desfazer" volta só os arquivos que a IA mexeu naquele pedido, sem perder o que você
// mudou à mão em outros arquivos. Funciona em qualquer pasta, mesmo sem Git no projeto: as fotos ficam num
// repositório separado em %APPDATA%\Ohara Guia\pontos, e o projeto nunca é tocado pelo Git da Ohara.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', '.cache/', 'dist/', 'out/', '*.log', '.DS_Store', 'Thumbs.db'];
const MAX_FILES = 15000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'dist', 'out']);

function git(args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim().slice(0, 400)), { code: err.code }));
      else resolve(String(stdout));
    });
  });
}

// Pasta grande demais (ou a pasta pessoal inteira): não vale fotografar.
function tooBig(dir) {
  let count = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count > MAX_FILES) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name)); } else count++;
    }
  };
  walk(dir);
  return count > MAX_FILES;
}

class Checkpoints {
  constructor({ dir }) {
    this.dir = dir;
  }

  /** Dá para fotografar esta pasta? (não pode ser a pasta pessoal, a raiz de um disco nem pasta enorme) */
  supported(cwd) {
    if (!cwd || !fs.existsSync(cwd)) return { ok: false, reason: 'pasta não existe' };
    const p = path.resolve(cwd);
    if (p.toLowerCase() === path.resolve(os.homedir()).toLowerCase()) return { ok: false, reason: 'é a pasta pessoal inteira' };
    if (path.parse(p).root.toLowerCase() === p.toLowerCase()) return { ok: false, reason: 'é a raiz do disco' };
    if (tooBig(p)) return { ok: false, reason: `tem mais de ${MAX_FILES} arquivos` };
    return { ok: true };
  }

  gitDir(cwd) {
    const key = crypto.createHash('sha1').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
    return path.join(this.dir, `${key}.git`);
  }

  #args(cwd, args) {
    return ['--git-dir', this.gitDir(cwd), '--work-tree', path.resolve(cwd), '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args];
  }

  async #ensure(cwd) {
    const gd = this.gitDir(cwd);
    if (fs.existsSync(path.join(gd, 'HEAD'))) return;
    fs.mkdirSync(this.dir, { recursive: true });
    await git(['init', '--bare', '-q', gd]);
    await git(['--git-dir', gd, 'config', 'user.name', 'Ohara']);
    await git(['--git-dir', gd, 'config', 'user.email', 'ohara@localhost']);
    await git(['--git-dir', gd, 'config', 'core.bare', 'false']);
    await git(['--git-dir', gd, 'config', 'core.quotepath', 'false']);
    fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gd, 'info', 'exclude'), `${EXCLUDES.join('\n')}\n`);
    fs.writeFileSync(path.join(gd, 'ohara-pasta.txt'), path.resolve(cwd));
  }

  /** Tira uma foto da pasta. Devolve o id da foto. */
  async snapshot(cwd, label = 'ponto de restauração') {
    await this.#ensure(cwd);
    await git(this.#args(cwd, ['add', '-A', '--ignore-errors', '.']), { cwd }).catch((e) => {
      if (!/warning|ignored/i.test(e.message)) throw e;
    });
    await git(this.#args(cwd, ['commit', '-q', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)]), { cwd });
    return (await git(this.#args(cwd, ['rev-parse', 'HEAD']), { cwd })).trim();
  }

  /** O que mudou entre duas fotos: [{ status: 'A'|'M'|'D', file }] */
  async changes(cwd, from, to) {
    const out = await git(this.#args(cwd, ['diff', '--name-status', '--no-renames', from, to]), { cwd });
    return out.split(/\r?\n/).filter(Boolean).map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], file: rest.join('\t') };
    });
  }

  /**
   * Desfaz o que mudou entre "from" e "to" (o antes e o depois de um pedido). Antes, tira uma foto do estado
   * atual, para o próprio desfazer também poder ser desfeito.
   */
  async undo(cwd, from, to) {
    const changed = await this.changes(cwd, from, to);
    const safety = await this.snapshot(cwd, 'antes de desfazer');
    const root = path.resolve(cwd);
    const restore = [];
    for (const { status, file } of changed) {
      const full = path.resolve(root, file);
      if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep)) continue; // nunca sai da pasta
      if (status === 'A') fs.rmSync(full, { force: true });
      else restore.push(file);
    }
    for (let i = 0; i < restore.length; i += 100) {
      await git(this.#args(cwd, ['checkout', from, '--', ...restore.slice(i, i + 100)]), { cwd });
    }
    // Pastas que ficaram vazias depois de apagar arquivos criados pela IA.
    for (const { status, file } of changed) {
      if (status !== 'A') continue;
      let d = path.dirname(path.resolve(root, file));
      while (d.toLowerCase() !== root.toLowerCase() && d.toLowerCase().startsWith(root.toLowerCase())) {
        try { fs.rmdirSync(d); } catch { break; }
        d = path.dirname(d);
      }
    }
    return { safety, files: changed };
  }

  /** Fotos da pasta, da mais nova para a mais antiga. */
  async list(cwd, limit = 30) {
    if (!fs.existsSync(path.join(this.gitDir(cwd), 'HEAD'))) return [];
    const out = await git(this.#args(cwd, ['log', `-n${limit}`, '--format=%H%x09%ct%x09%s']), { cwd }).catch(() => '');
    return out.split(/\r?\n/).filter(Boolean).map((l) => {
      const [id, t, label] = l.split('\t');
      return { id, at: Number(t) * 1000, label };
    });
  }
}

module.exports = { Checkpoints };
