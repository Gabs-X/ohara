const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

function developmentPolicy(config, cwd, override) {
  const sameRepo = config.selfRepo && path.resolve(cwd).toLowerCase() === path.resolve(config.selfRepo).toLowerCase();
  const selected = sameRepo ? config.codex.developmentPermissions || 'restricted' : null;
  if (selected && !['restricted', 'full'].includes(selected)) throw new Error('Permissão de desenvolvimento inválida.');
  return {
    development: !!sameRepo,
    sandbox: override || (selected === 'full' ? 'danger-full-access' : config.codex.sandbox),
    preflight: !!sameRepo && config.codex.developmentPreflight !== false,
  };
}

async function checkDevelopment({ repo, desktopProbe, run = exec, fileSystem = fs }) {
  const checks = await Promise.all([
    (async () => {
      let probe;
      try {
        const { stdout } = await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, windowsHide: true, timeout: 10000 });
        probe = path.join(stdout.trim(), `ohara-access-${crypto.randomUUID()}.tmp`);
        const handle = await fileSystem.open(probe, 'wx');
        await handle.close();
        return { id: 'git', ok: true, detail: 'Gravação na pasta de metadados do Git disponível.' };
      } catch (err) {
        return { id: 'git', ok: false, detail: `Git sem acesso de gravação (${err.code || 'falha'}).` };
      } finally { if (probe) await fileSystem.unlink(probe).catch(() => {}); }
    })(),
    (async () => {
      try {
        const { stdout } = await run('gh', ['repo', 'view', '--json', 'viewerPermission', '--jq', '.viewerPermission'], { cwd: repo, windowsHide: true, timeout: 15000 });
        const canWrite = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(stdout.trim());
        return { id: 'github', ok: canWrite, detail: canWrite ? 'GitHub acessível, com login e permissão de escrita no repositório.' : 'GitHub acessível, mas a conta não tem permissão de escrita.' };
      } catch (err) {
        return { id: 'github', ok: false, detail: `GitHub indisponível: confira rede e login do gh (${err.code || 'falha'}).` };
      }
    })(),
    (async () => {
      try {
        if (!desktopProbe) return { id: 'electron', ok: false, detail: 'Teste gráfico não disponível neste processo.' };
        await desktopProbe();
        return { id: 'electron', ok: true, detail: 'Electron abriu, renderizou e recebeu entrada de teclado.' };
      } catch {
        return { id: 'electron', ok: false, detail: 'Electron não passou no teste de janela, renderização e foco.' };
      }
    })(),
  ]);
  return { ok: checks.every(c => c.ok), checks, scope: 'host', at: Date.now() };
}

module.exports = { developmentPolicy, checkDevelopment };
