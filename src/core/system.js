// Integrações diretas com o Windows que não precisam de IA.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ttsProc = null;

function powershell(script) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {}); // EPIPE se o PowerShell sair antes de ler o script
  child.stdin.end(script);
  return child;
}

// Lê um texto em voz alta com a voz pt-BR do Windows (offline).
function speak(text, voice) {
  stopSpeaking();
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' bloco de código. ')
    .replace(/[`*_#>|]/g, '')
    .slice(0, 4000);
  const b64 = Buffer.from(clean, 'utf8').toString('base64');
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('${String(voice).replace(/'/g, "''")}') } catch {}
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$s.Speak($t)`;
  ttsProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  ttsProc.on('error', () => {});
  ttsProc.stdin.on('error', () => {});
  ttsProc.stdin.end(script);
}

function stopSpeaking() {
  if (ttsProc && ttsProc.exitCode === null) {
    spawn('taskkill', ['/pid', String(ttsProc.pid), '/T', '/F'], { windowsHide: true });
  }
  ttsProc = null;
}

// Abre a digitação por voz do Windows (Win+H), que entende pt-BR.
// O campo de texto da janela precisa estar focado antes.
function startVoiceTyping() {
  powershell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class K { [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }
'@
[K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)
[K]::keybd_event(0x48,0,0,[UIntPtr]::Zero)
[K]::keybd_event(0x48,0,2,[UIntPtr]::Zero)
[K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`);
}

// Envia Ctrl+<tecla> para a janela em foco, depois que você soltar Ctrl/Alt/Shift/Win do atalho
// (senão o app receberia Ctrl+Shift+F8 e o atalho dispararia de novo).
// Compila o acesso ao teclado uma vez numa DLL em %TEMP% (compilar a cada uso custa ~2 s).
const KEYS_SCRIPT = `
$src = @'
using System; using System.Runtime.InteropServices;
public static class OharaKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
}
'@
$dll = Join-Path $env:TEMP 'OharaKeys-2.dll'
try {
  if (-not (Test-Path $dll)) { Add-Type -TypeDefinition $src -OutputAssembly $dll }
  Add-Type -Path $dll
} catch { Add-Type -TypeDefinition $src }
$until = (Get-Date).AddSeconds(2)
while ((Get-Date) -lt $until -and (@(0x10,0x11,0x12,0x5B,0x5C) | Where-Object { [OharaKeys]::GetAsyncKeyState($_) -band 0x8000 })) { Start-Sleep -Milliseconds 20 }
function Key([byte]$k, [uint32]$up) {
  $sc = [byte][OharaKeys]::MapVirtualKey($k, 0)
  $ext = 0; if ($k -eq 0x2D) { $ext = 1 }
  [OharaKeys]::keybd_event($k, $sc, ($up -bor $ext), [UIntPtr]::Zero)
}
function Send-Ctrl([byte]$k) {
  Key 0x11 0; Start-Sleep -Milliseconds 30; Key $k 0; Start-Sleep -Milliseconds 30
  Key $k 2; Start-Sleep -Milliseconds 30; Key 0x11 2
}
$fg = [string][OharaKeys]::GetForegroundWindow().ToInt64()
`;

function powershellOutput(script, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('o Windows demorou demais para copiar/colar')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim().split('\n')[0] || `PowerShell saiu com código ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

// Copia a seleção da janela em foco; devolve o identificador dessa janela.
function copySelection() {
  return powershellOutput(`${KEYS_SCRIPT}
Send-Ctrl 0x43
[Console]::Out.Write($fg)`);
}

// Cola na janela só se ela ainda estiver em foco. Devolve false se você trocou de janela.
async function pasteInto(target) {
  const id = String(target || '').replace(/\D/g, '');
  const out = await powershellOutput(`${KEYS_SCRIPT}
if ('${id}' -and $fg -ne '${id}') { [Console]::Out.Write('moved'); exit 0 }
Send-Ctrl 0x56
[Console]::Out.Write('ok')`);
  return out === 'ok';
}

// Lista as pastas de projeto (com .git) até dois níveis abaixo da raiz.
function listRepos(root) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((e) => e.name === '.git')) {
      out.push(dir);
      return;
    }
    if (depth >= 2) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

module.exports = { speak, stopSpeaking, startVoiceTyping, listRepos, copySelection, pasteInto };
