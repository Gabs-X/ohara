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

// Pedidos que só dão certo no Chrome logado (LinkedIn, vagas, Gmail...). Esses vão sempre
// para o Claude, que é quem tem a extensão; o Codex não tem navegador.
const LOGGED_BROWSER_WORDS = [
  'chrome', 'navegador', 'linkedin', 'gmail', 'instagram', 'vaga', 'candidat', 'logad', '/vagas',
];

function needsBrowser(text) {
  const t = ` ${String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
  return LOGGED_BROWSER_WORDS.some((w) => t.includes(w));
}

// Host nativo da extensão Claude in Chrome (instalado pelo Claude Code com /chrome).
const NATIVE_HOST_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.anthropic.claude_code_browser_extension';

function readRegistryDefault(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = /REG_SZ\s+(.+)/.exec(out || '');
      resolve(m ? m[1].trim() : null);
    });
  });
}

/**
 * Confere se a ponte Chrome ↔ Claude Code está instalada: chave do host nativo,
 * manifesto e o executável que ele aponta.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function checkBridge({ readKey = readRegistryDefault, exists = fs.existsSync, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const missing = 'a extensão Claude in Chrome não está registrada no Windows (falta o host nativo do Claude Code)';
  const manifest = await readKey(NATIVE_HOST_KEY);
  if (!manifest || !exists(manifest)) return { ok: false, error: missing };
  try {
    const host = JSON.parse(readFile(manifest)).path;
    if (host && !exists(path.isAbsolute(host) ? host : path.join(path.dirname(manifest), host))) {
      return { ok: false, error: `o host nativo da extensão aponta para um arquivo que não existe (${host})` };
    }
  } catch {
    return { ok: false, error: missing };
  }
  return { ok: true };
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
 * Verifica se o navegador está disponível antes de começar: ponte da extensão instalada
 * e Chrome aberto (abre se estiver fechado e espera a extensão subir).
 * @returns {Promise<{running:boolean, started:boolean, bridge:boolean, path?:string|null, error?:string}>}
 */
async function ensureChrome(opts = {}) {
  const { bridge = checkBridge } = opts;
  const b = await Promise.resolve(bridge()).catch((err) => ({ ok: false, error: err.message }));
  const chrome = await openChrome(opts);
  if (!b.ok) return { ...chrome, bridge: false, error: b.error };
  return { ...chrome, bridge: true };
}

async function openChrome({
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
    'Antes de começar uma tarefa no navegador, confira a conexão primeiro (list_connected_browsers e tabs_context_mcp), sem planejar nem redigir nada antes disso.',
    `Se a extensão não responder ou a lista de navegadores conectados vier vazia, não desista: abra o Chrome você mesma pelo PowerShell (${open}),`,
    'espere uns 5 segundos e tente de novo (list_connected_browsers/select_browser e tabs_context_mcp), até 3 vezes. Use uma aba nova para trabalhar.',
    'Só peça ajuda se continuar desconectado depois disso: diga que falta clicar no ícone da extensão Claude no Chrome e entrar na conta dele.',
    'Ao editar perfis ou formulários (ex.: LinkedIn), siga o padrão do que já existe ali; deixe tudo preenchido e peça para ele conferir antes de salvar ou publicar, a não ser que ele já tenha mandado salvar.',
  ].join('\n');
}

// Problema detectado antes de começar (ponte ausente, Chrome que não abriu): a IA já sabe e explica.
function chromeIssueNote(error) {
  return `Verificação do navegador antes de começar: ${error}. Tente mesmo assim pelas ferramentas mcp__claude-in-chrome__*; se não conectar, explique isso ao Gabriel e diga que dá para reinstalar a ponte rodando "claude" no terminal e digitando /chrome.`;
}

// O Codex não tem a extensão: não deve tentar automatizar o navegador.
const CODEX_BROWSER_NOTE = [
  'Este pedido precisa do Chrome logado do Gabriel, mas você (Codex) não tem a extensão Claude in Chrome nesta sessão.',
  'Não tente abrir nem automatizar o navegador. Faça o que der sem ele (ex.: redigir o texto pronto para colar)',
  'e diga em uma frase que, para executar no navegador, basta reenviar o pedido escolhendo o Claude.',
].join(' ');

module.exports = { findChrome, wantsBrowser, needsBrowser, checkBridge, isChromeRunning, ensureChrome, chromeNote, chromeIssueNote, CODEX_BROWSER_NOTE };
