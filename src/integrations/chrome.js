// Chrome do Gabriel para a extensão Claude in Chrome (claude -p --chrome).
// A extensão só conecta com o Chrome aberto: antes de pedidos de navegador a Ohara
// abre o Chrome sozinha, e o prompt ensina a IA a reabrir e tentar de novo se cair.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

function findChrome(env = process.env, exists = fs.existsSync) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const exe = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (exists(exe)) return exe;
  }
  return null;
}

// Pedidos que precisam do navegador logado (sem acento; o texto é normalizado antes).
const BROWSER_WORDS = [
  'chrome', 'navegador', 'linkedin', 'site', 'pagina', 'perfil', 'vaga', 'candidat', 'formulario',
  'preench', 'logad', 'login', 'aba ', 'abas', 'gmail', 'instagram', 'github.com', 'http', 'www.', '/vagas',
];

function wantsBrowser(text) {
  const t = ` ${String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
  return BROWSER_WORDS.some((w) => t.includes(w));
}

function isChromeRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      resolve(!err && /chrome\.exe/i.test(out || ''));
    });
  });
}

function launchChrome(exe) {
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Abre o Chrome se estiver fechado e espera a extensão subir.
 * @returns {Promise<{running:boolean, started:boolean, path?:string|null, error?:string}>}
 */
async function ensureChrome({
  chromePath = findChrome(),
  isRunning = isChromeRunning,
  launch = launchChrome,
  wait = sleep,
  settleMs = 4000,
  timeoutMs = 10_000,
} = {}) {
  if (await isRunning()) return { running: true, started: false, path: chromePath };
  if (!chromePath) return { running: false, started: false, path: null, error: 'Chrome não encontrado' };
  try {
    launch(chromePath);
  } catch (err) {
    return { running: false, started: false, path: chromePath, error: err.message };
  }
  for (let waited = 0; waited < timeoutMs; waited += 500) {
    if (await isRunning()) {
      await wait(settleMs); // tempo para a extensão Claude iniciar e conectar
      return { running: true, started: true, path: chromePath };
    }
    await wait(500);
  }
  return { running: false, started: true, path: chromePath, error: 'o Chrome não abriu a tempo' };
}

function chromeNote(chromePath) {
  const open = chromePath ? `Start-Process "${chromePath}"` : 'Start-Process chrome';
  return [
    'Você controla o Chrome do Gabriel, já logado nos sites dele (LinkedIn, GitHub, Gmail...), pela extensão Claude in Chrome (ferramentas mcp__claude-in-chrome__*).',
    `Se a extensão não responder ou a lista de navegadores conectados vier vazia, não desista: abra o Chrome você mesma pelo PowerShell (${open}),`,
    'espere uns 5 segundos e tente de novo (list_connected_browsers/select_browser e tabs_context_mcp), até 3 vezes. Use uma aba nova para trabalhar.',
    'Só peça ajuda se continuar desconectado depois disso: diga que falta clicar no ícone da extensão Claude no Chrome e entrar na conta dele.',
    'Ao editar perfis ou formulários (ex.: LinkedIn), siga o padrão do que já existe ali; deixe tudo preenchido e peça para ele conferir antes de salvar ou publicar, a não ser que ele já tenha mandado salvar.',
  ].join('\n');
}

module.exports = { findChrome, wantsBrowser, isChromeRunning, ensureChrome, chromeNote };
