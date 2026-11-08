const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');

// Executa um processo, entrega cada linha JSON do stdout para onJson e
// devolve uma promessa com o código de saída e o stderr.
function runJsonl({ cmd, args, cwd, input, env, onJson, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
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
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
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

module.exports = { runJsonl, killTree, shorten };
