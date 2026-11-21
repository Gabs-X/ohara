const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// No Windows, spawn sem shell só acha .exe/.com: os atalhos .cmd que o npm instala (gemini, claude
// instalado pelo npm...) davam ENOENT. Aqui o atalho é lido e o script .js roda direto no node,
// sem passar pelo cmd.exe (que reinterpretaria &, | e % do prompt).
const shimCache = new Map();
function resolveWindowsShim(cmd, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !cmd) return null;
  const PATH = String(env.PATH || env.Path || '');
  const key = `${cmd}|${PATH}`;
  if (shimCache.has(key)) return shimCache.get(key);
  let found = null;
  const dirs = /[\\/]/.test(cmd) ? [''] : PATH.split(';').filter(Boolean);
  const exts = path.extname(cmd) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  search: for (const d of dirs) {
    for (const e of exts) {
      const f = d ? path.join(d, cmd + e) : cmd + e;
      if (!fs.existsSync(f)) continue;
      if (/\.(cmd|bat)$/i.test(f)) {
        try {
          const m = fs.readFileSync(f, 'utf8').match(/"%~?dp0%?\\([^"]+?\.[cm]?js)"/i);
          const js = m && path.join(path.dirname(f), m[1]);
          if (js && fs.existsSync(js)) {
            const localNode = path.join(path.dirname(f), 'node.exe');
            found = { cmd: fs.existsSync(localNode) ? localNode : 'node', pre: [js] };
          }
        } catch { /* atalho ilegível: segue como estava */ }
      }
      break search; // vale o primeiro que o Windows acharia
    }
  }
  shimCache.set(key, found);
  return found;
}

// Executa um processo, entrega cada linha JSON do stdout para onJson e
// devolve uma promessa com o código de saída e o stderr.
function runJsonl({ cmd, args, cwd, input, env, onJson, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const shim = resolveWindowsShim(cmd);
      child = spawn(shim ? shim.cmd : cmd, shim ? [...shim.pre, ...args] : args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.replace(/^﻿/, '').trim();
      if (!trimmed.startsWith('{')) return;
      try {
        onJson(JSON.parse(trimmed));
      } catch {
        /* linha que não é JSON: ignora */
      }
    });

    const onAbort = () => killTree(child.pid);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(friendlySpawnError(err, cmd, cwd));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stderr, aborted: !!signal?.aborted });
    });

    // Processo que morre (ou nem abre) antes de ler a entrada gera EPIPE no stdin;
    // sem este handler o erro derruba o processo principal do app.
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

// "spawn claude ENOENT" vale tanto para programa ausente quanto para pasta de trabalho inexistente.
function friendlySpawnError(err, cmd, cwd) {
  if (err?.code !== 'ENOENT') return err;
  const msg = cwd && !fs.existsSync(cwd)
    ? `A pasta de trabalho "${cwd}" não existe mais. Escolha outra pasta no topo da conversa.`
    : `Não encontrei o programa "${cmd}". Confira se ele está instalado e no PATH do Windows.`;
  return Object.assign(new Error(msg), { code: err.code });
}

// No Windows, child.kill() não derruba os subprocessos: usa taskkill /T.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // Sem o listener, uma falha ao abrir o taskkill viraria exceção não tratada no processo principal.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* já saiu */
    }
  }
}

function shorten(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = { runJsonl, killTree, shorten, resolveWindowsShim };
