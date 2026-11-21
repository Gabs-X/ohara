'use strict';
// Ações da Ohara-AI no PC (modelo local com "tools" do Ollama), além das leituras de pc-tools.js.
//
// Duas classes:
//   livre      → roda na hora: dá para desfazer (volume, mídia, print, copiar, lembrete, bloquear a tela,
//                abrir arquivo/pasta/configuração, buscar e ler arquivos, criar pasta, cancelar desligamento).
//   confirmar  → NÃO roda: vira um pedido pendente na resposta, com botão "Confirmar" (ou ele responde
//                "confirma"). Fechar programa, mover, renomear, mandar para a Lixeira, limpar temporários,
//                esvaziar a Lixeira, desligar/reiniciar/suspender e abrir um executável.
//
// O pedido pendente fica guardado no app (na mensagem); a tela só manda "confirmar o item N da mensagem X".
// Assim, nem a interface nem um texto malicioso lido de um arquivo conseguem disparar uma ação arriscada
// sem ele ver e confirmar. Caminhos do sistema e processos do Windows ficam sempre de fora.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { psLiteral } = require('./ps');
const { psJson, resolveFolder } = require('./pc-tools');
const { extractText, SUPPORTED_EXT } = require('./doc-text');
const { EXECUTABLE } = require('./ipc-guard');

const MAX_READ_CHARS = 6000;
const PENDING_TTL = 10 * 60_000; // um pedido pendente vale por 10 min

// ---------- Travas ----------

// Pastas que nenhuma ação altera (nem dentro delas).
function blockedRoots(home = os.homedir()) {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  return [
    sys,
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.ProgramData || 'C:\\ProgramData',
    path.join(path.parse(sys).root, '$Recycle.Bin'),
    path.join(path.parse(sys).root, 'System Volume Information'),
  ].map((p) => path.resolve(p).toLowerCase());
}

const under = (p, root) => p === root || p.startsWith(root.endsWith('\\') ? root : `${root}\\`);

/**
 * Caminho que uma ação pode alterar, já resolvido ("downloads\\x.pdf" → C:\Users\...\Downloads\x.pdf).
 * Lança com o motivo quando é do sistema, a raiz de um disco ou a própria pasta do usuário (ou AppData).
 */
function guardPath(input, { home = os.homedir() } = {}) {
  const p = resolvePlain(input, home);
  const low = p.toLowerCase().replace(/\\+$/, '');
  if (low === path.parse(p).root.toLowerCase().replace(/\\+$/, '')) throw new Error('não mexo na raiz de um disco');
  const h = path.resolve(home).toLowerCase();
  if (low === h) throw new Error('não mexo na sua pasta de usuário inteira');
  if (under(low, path.join(h, 'appdata').toLowerCase())) throw new Error('não mexo nas pastas de configuração dos programas (AppData)');
  if (blockedRoots(home).some((r) => under(low, r))) throw new Error('não mexo em pastas do sistema (Windows, Arquivos de Programas, ProgramData)');
  return p;
}

// Processos que nunca fecho: o Windows cai ou trava, ou é a própria Ohara/o modelo local.
const PROTECTED_PROCS = new Set([
  'system', 'idle', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm',
  'fontdrvhost', 'registry', 'memory compression', 'secure system', 'msmpeng', 'securityhealthservice',
  'ohara', 'electron', 'ollama', 'ollama app', 'ollama_llama_server', 'powershell', 'conhost',
]);
function cleanProcName(input) {
  const n = String(input || '').trim().replace(/\.exe$/i, '');
  if (!n || !/^[\w .+-]{1,60}$/.test(n)) throw new Error('nome de programa inválido');
  if (PROTECTED_PROCS.has(n.toLowerCase())) throw new Error(`"${n}" é do sistema ou da própria Ohara: não fecho`);
  return n;
}

const isExecutable = (p) => EXECUTABLE.has(path.extname(String(p || '').trim().replace(/[.\s]+$/, '')).toLowerCase());

// ---------- Execução ----------

function run(file, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve(String(stdout).trim())));
  });
}

// Telas de configuração do Windows que dá para abrir (nada além desta lista).
const SETTINGS = {
  som: 'ms-settings:sound',
  tela: 'ms-settings:display',
  bluetooth: 'ms-settings:bluetooth',
  wifi: 'ms-settings:network-wifi',
  rede: 'ms-settings:network',
  notificacoes: 'ms-settings:notifications',
  nao_perturbe: 'ms-settings:notifications',
  armazenamento: 'ms-settings:storagesense',
  apps: 'ms-settings:appsfeatures',
  inicializacao: 'ms-settings:startupapps',
  energia: 'ms-settings:powersleep',
  bateria: 'ms-settings:batterysaver',
  atualizacao: 'ms-settings:windowsupdate',
  privacidade: 'ms-settings:privacy',
  impressoras: 'ms-settings:printers',
  mouse: 'ms-settings:mousetouchpad',
  teclado: 'ms-settings:typing',
  data_hora: 'ms-settings:dateandtime',
  idioma: 'ms-settings:regionlanguage',
  personalizacao: 'ms-settings:personalization',
  fundo: 'ms-settings:personalization-background',
  vpn: 'ms-settings:network-vpn',
};

const KEYS = { subir: 175, baixar: 174, mudo: 173, tocar_pausar: 179, proxima: 176, anterior: 177, parar: 178 };
// Teclas de volume/mídia: [[código, vezes], ...] numa chamada só.
const sendKeys = (...presses) =>
  `$w=New-Object -ComObject WScript.Shell; ${presses
    .map(([code, times = 1]) => `for($i=0;$i -lt ${Math.max(0, Math.min(60, times | 0))};$i++){$w.SendKeys([string][char]${code | 0})}`)
    .join('; ')}; @{ok=$true}|ConvertTo-Json -Compress`;

const IMPLS = {
  async volume({ acao = 'subir', nivel, passos } = {}, ctx) {
    if (acao === 'mudo') {
      await ctx.ps(sendKeys([KEYS.mudo, 1]));
      return { feito: 'liguei/desliguei o mudo' };
    }
    if (acao === 'definir') {
      const n = Number(nivel);
      if (nivel == null || !Number.isFinite(n)) throw new Error('faltou o nível (0 a 100)');
      const v = Math.max(0, Math.min(100, n));
      // Sem ler o volume atual: zera (50 passos de 2%) e sobe até o nível.
      await ctx.ps(sendKeys([KEYS.baixar, 50], [KEYS.subir, Math.round(v / 2)]));
      return { feito: `volume em ${v}%` };
    }
    if (acao !== 'subir' && acao !== 'baixar') throw new Error('ação de volume inválida');
    const p = Math.max(1, Math.min(25, Number(passos) || 5)); // cada passo = 2%
    await ctx.ps(sendKeys([KEYS[acao], p]));
    return { feito: `${acao === 'subir' ? 'aumentei' : 'baixei'} o volume em ${p * 2}%` };
  },

  async midia({ acao = 'tocar_pausar' } = {}, ctx) {
    if (!KEYS[acao] || ['subir', 'baixar', 'mudo'].includes(acao)) throw new Error('ação de mídia inválida');
    await ctx.ps(sendKeys([KEYS[acao], 1]));
    return { feito: { tocar_pausar: 'tocar/pausar', proxima: 'próxima faixa', anterior: 'faixa anterior', parar: 'parei a mídia' }[acao] };
  },

  async print(_a, ctx) {
    const r = await ctx.ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$dir=Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Screenshots'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$f=Join-Path $dir ('Ohara-'+(Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')+'.png'); $bmp.Save($f,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
@{arquivo=$f}|ConvertTo-Json -Compress`);
    return { feito: 'print da tela salvo', arquivo: r.arquivo };
  },

  async copiar({ texto } = {}, ctx) {
    const t = String(texto ?? '');
    if (!t) throw new Error('faltou o texto');
    await ctx.ps(`Set-Clipboard -Value ${psLiteral(t.slice(0, 20_000))}; @{ok=$true}|ConvertTo-Json -Compress`);
    return { feito: 'copiei para a área de transferência', caracteres: t.length };
  },

  async lembrete({ texto, minutos } = {}, ctx) {
    const m = Number(minutos);
    if (!Number.isFinite(m) || m < 1 || m > 24 * 60) throw new Error('o lembrete vai de 1 minuto a 24 horas');
    const t = String(texto || 'Lembrete').slice(0, 200);
    if (!ctx.schedule) throw new Error('lembretes indisponíveis');
    const at = ctx.schedule(t, m * 60_000);
    return { feito: `lembrete marcado para daqui a ${m} min`, horario: new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), aviso: 'o lembrete se perde se a Ohara for fechada' };
  },

  async bloquear_tela(_a, ctx) {
    await ctx.exec('rundll32.exe', ['user32.dll,LockWorkStation']);
    return { feito: 'tela bloqueada' };
  },

  async abrir_configuracao({ tela } = {}, ctx) {
    const key = String(tela || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_');
    const uri = SETTINGS[key];
    if (!uri) throw new Error(`tela de configuração desconhecida; opções: ${Object.keys(SETTINGS).join(', ')}`);
    await ctx.open(uri);
    return { feito: `abri as configurações de ${key.replace(/_/g, ' ')}` };
  },

  async abrir({ caminho } = {}, ctx) {
    const p = resolvePlain(caminho, ctx.home);
    if (!fs.existsSync(p)) throw new Error(`não achei ${p}`);
    await ctx.ps(`Invoke-Item -LiteralPath ${psLiteral(p)}; @{ok=$true}|ConvertTo-Json -Compress`);
    return { feito: `abri ${path.basename(p) || p}`, caminho: p };
  },

  async buscar_arquivos({ nome, pasta } = {}, ctx) {
    const n = String(nome || '').replace(/[*?[\]`]/g, '').trim();
    if (n.length < 2) throw new Error('faltou o nome (ou parte dele)');
    const home = ctx.home;
    const roots = pasta ? [resolvePlain(pasta, home)] : ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'].map((d) => path.join(home, d));
    const list = await ctx.ps(
      `$roots=@(${roots.map(psLiteral).join(',')}); $n=${psLiteral(n)}
$r=foreach($root in $roots){ if(Test-Path -LiteralPath $root){ Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue -Filter ('*'+$n+'*') | Select-Object -First 40 } }
@($r | Select-Object -First 40 | ForEach-Object { @{caminho=$_.FullName; pasta=[bool]$_.PSIsContainer; tamanhoMB=[math]::Round(($_.Length)/1MB,2); modificado=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')} }) | ConvertTo-Json -Compress`,
      30_000,
    );
    const items = Array.isArray(list) ? list : list ? [list] : [];
    return { encontrados: items.length, itens: items, onde: roots };
  },

  async ler_arquivo({ caminho } = {}, ctx) {
    const p = resolvePlain(caminho, ctx.home);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`não achei o arquivo ${p}`);
    if (!SUPPORTED_EXT.has(path.extname(p).toLowerCase())) throw new Error('só leio PDF, Word (.docx) e arquivos de texto');
    const text = await extractText(p);
    return { caminho: p, texto: text.slice(0, MAX_READ_CHARS), cortado: text.length > MAX_READ_CHARS, caracteres: text.length };
  },

  async criar_pasta({ caminho } = {}, ctx) {
    const p = guardPath(caminho, { home: ctx.home });
    fs.mkdirSync(p, { recursive: true });
    return { feito: 'pasta criada', caminho: p };
  },

  // ---- pedem confirmação ----

  async mover({ origem, destino } = {}, ctx) {
    const a = guardPath(origem, { home: ctx.home });
    const b = guardPath(destino, { home: ctx.home });
    if (!fs.existsSync(a)) throw new Error(`não achei ${a}`);
    await ctx.ps(`Move-Item -LiteralPath ${psLiteral(a)} -Destination ${psLiteral(b)} -ErrorAction Stop; @{ok=$true}|ConvertTo-Json -Compress`, 120_000);
    return { feito: `movi ${path.basename(a)} para ${b}` };
  },

  async renomear({ caminho, novo_nome } = {}, ctx) {
    const a = guardPath(caminho, { home: ctx.home });
    const n = String(novo_nome || '').trim();
    if (!n || /[\\/:*?"<>|]/.test(n)) throw new Error('novo nome inválido');
    if (!fs.existsSync(a)) throw new Error(`não achei ${a}`);
    await ctx.ps(`Rename-Item -LiteralPath ${psLiteral(a)} -NewName ${psLiteral(n)} -ErrorAction Stop; @{ok=$true}|ConvertTo-Json -Compress`);
    return { feito: `renomeei ${path.basename(a)} para ${n}` };
  },

  async lixeira({ caminho } = {}, ctx) {
    const p = guardPath(caminho, { home: ctx.home });
    if (!fs.existsSync(p)) throw new Error(`não achei ${p}`);
    await ctx.ps(
      `Add-Type -AssemblyName Microsoft.VisualBasic; $p=${psLiteral(p)}
if(Test-Path -LiteralPath $p -PathType Container){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')}else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')}
@{ok=$true}|ConvertTo-Json -Compress`,
      60_000,
    );
    return { feito: `mandei ${path.basename(p)} para a Lixeira (dá para restaurar)` };
  },

  async fechar_programa({ nome, forcar = false } = {}, ctx) {
    const n = cleanProcName(nome);
    const r = await ctx.ps(
      `$n=${psLiteral(n)}; $ps=@(Get-Process -Name $n -ErrorAction SilentlyContinue)
if(-not $ps.Count){ @{encontrados=0; ainda_abertos=0}|ConvertTo-Json -Compress; return }
$ps | ForEach-Object { [void]$_.CloseMainWindow() }; Start-Sleep -Seconds 3
$left=@(Get-Process -Name $n -ErrorAction SilentlyContinue)
if($left.Count -and ${forcar ? '$true' : '$false'}){ $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
@{encontrados=$ps.Count; ainda_abertos=@(Get-Process -Name $n -ErrorAction SilentlyContinue).Count}|ConvertTo-Json -Compress`,
      30_000,
    );
    if (!r.encontrados) return { feito: `${n} não estava aberto` };
    if (r.ainda_abertos) return { feito: `pedi para ${n} fechar, mas ${r.ainda_abertos} janela(s)/processo(s) continuam abertos`, dica: 'para forçar, peça "força o fechamento"' };
    return { feito: `fechei ${n}` };
  },

  async limpar_temporarios(_a, ctx) {
    // Só o que tem mais de 1 dia; pula o que está em uso e as pastas de trabalho do Claude e da Ohara.
    const r = await ctx.ps(
      `$t=$env:TEMP; $cut=(Get-Date).AddDays(-1); $freed=0; $n=0; $skip=@('claude','ohara-orca')
Get-ChildItem -LiteralPath $t -Force -ErrorAction SilentlyContinue | Where-Object { $skip -notcontains $_.Name.ToLower() } | ForEach-Object {
  $items = if($_.PSIsContainer){ Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue } else { $_ }
  foreach($f in $items){ if($f.LastWriteTime -lt $cut){ try{ $s=$f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $freed+=$s; $n++ }catch{} } }
}
@{arquivos=$n; liberadoMB=[math]::Round($freed/1MB,1)}|ConvertTo-Json -Compress`,
      180_000,
    );
    return { feito: `apaguei ${r.arquivos} arquivo(s) temporário(s)`, liberadoMB: r.liberadoMB };
  },

  async esvaziar_lixeira(_a, ctx) {
    await ctx.ps(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue; @{ok=$true}|ConvertTo-Json -Compress`, 120_000);
    return { feito: 'esvaziei a Lixeira' };
  },

  async energia({ acao, minutos } = {}, ctx) {
    const secs = Math.max(30, Math.min(24 * 3600, Math.round((Number(minutos) || 1) * 60)));
    if (acao === 'cancelar') {
      await ctx.exec('shutdown.exe', ['/a']).catch(() => {});
      return { feito: 'cancelei o desligamento/reinício agendado' };
    }
    if (acao === 'desligar' || acao === 'reiniciar') {
      await ctx.exec('shutdown.exe', [acao === 'desligar' ? '/s' : '/r', '/t', String(secs), '/c', 'Ohara: peça "cancela o desligamento" para desistir.']);
      return { feito: `o PC vai ${acao} em ${Math.round(secs / 60)} min`, cancelar: 'peça "cancela o desligamento"' };
    }
    if (acao === 'suspender') {
      await ctx.exec('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
      return { feito: 'suspendi o PC' };
    }
    if (acao === 'hibernar') {
      await ctx.exec('shutdown.exe', ['/h']);
      return { feito: 'hibernei o PC' };
    }
    throw new Error('ação de energia inválida (desligar, reiniciar, suspender, hibernar ou cancelar)');
  },
};

// Caminho absoluto, com os apelidos ("downloads\\nota.pdf", "área de trabalho"). Relativo é sempre a partir
// da pasta do usuário (nunca da pasta onde o app está rodando).
function resolvePlain(input, home = os.homedir()) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('faltou o caminho');
  if (/^[a-z]:([\\/]|$)/i.test(raw) || raw.startsWith('\\\\')) return path.resolve(/^[a-z]:$/i.test(raw) ? `${raw}\\` : raw);
  if (raw === '~' || /^~[\\/]/.test(raw)) return path.join(home, raw.slice(1));
  const parts = raw.split(/[\\/]+/);
  const alias = resolveFolder(parts[0], home);
  if (alias !== path.resolve(parts[0]) && alias.toLowerCase().startsWith(path.resolve(home).toLowerCase())) return path.join(alias, ...parts.slice(1));
  return path.join(home, raw);
}

// ---------- Risco ----------

const CONFIRM = new Set(['mover', 'renomear', 'lixeira', 'fechar_programa', 'limpar_temporarios', 'esvaziar_lixeira', 'energia']);
/** "livre" (roda na hora) ou "confirmar" (vira pedido pendente). */
function riskOf(name, args = {}) {
  if (name === 'energia' && args?.acao === 'cancelar') return 'livre';
  if (name === 'abrir' && isExecutable(args?.caminho)) return 'confirmar';
  return CONFIRM.has(name) ? 'confirmar' : 'livre';
}

// Frase curta do que vai ser feito, para o botão e para ele confirmar.
function summarize(name, a = {}) {
  const f = (p) => String(p || '').trim();
  switch (name) {
    case 'mover': return `Mover ${f(a.origem)} para ${f(a.destino)}`;
    case 'renomear': return `Renomear ${f(a.caminho)} para ${f(a.novo_nome)}`;
    case 'lixeira': return `Mandar para a Lixeira: ${f(a.caminho)}`;
    case 'fechar_programa': return `${a.forcar ? 'Forçar o fechamento de' : 'Fechar'} ${f(a.nome)}`;
    case 'limpar_temporarios': return 'Apagar arquivos temporários com mais de 1 dia';
    case 'esvaziar_lixeira': return 'Esvaziar a Lixeira (não dá para desfazer)';
    case 'energia': return { desligar: 'Desligar', reiniciar: 'Reiniciar', suspender: 'Suspender', hibernar: 'Hibernar' }[a.acao] ? `${{ desligar: 'Desligar', reiniciar: 'Reiniciar', suspender: 'Suspender', hibernar: 'Hibernar' }[a.acao]} o PC${['desligar', 'reiniciar'].includes(a.acao) ? ` em ${Math.max(1, Math.round(Number(a.minutos) || 1))} min` : ''}` : `Energia: ${f(a.acao)}`;
    case 'abrir': return `Abrir o executável ${f(a.caminho)}`;
    default: return `${name} ${JSON.stringify(a)}`;
  }
}

// Valida antes de virar pedido pendente: erro bobo (caminho do sistema, programa protegido) já volta ao modelo.
function precheck(name, a = {}, home = os.homedir()) {
  if (name === 'mover') {
    guardPath(a.origem, { home });
    guardPath(a.destino, { home });
  }
  if (name === 'renomear' || name === 'lixeira') guardPath(a.caminho, { home });
  if (name === 'fechar_programa') cleanProcName(a.nome);
  if (name === 'energia' && !['desligar', 'reiniciar', 'suspender', 'hibernar'].includes(a.acao)) throw new Error('ação de energia inválida');
}

function defaultCtx(extra = {}) {
  return {
    home: os.homedir(),
    ps: psJson,
    exec: (file, args) => run(file, args),
    open: (uri) => new Promise((resolve, reject) => {
      // ms-settings: e afins abrem pelo explorer, sem shell.
      const c = spawn('explorer.exe', [uri], { windowsHide: true, detached: true, stdio: 'ignore' });
      c.on('error', reject);
      c.unref();
      resolve();
    }),
    ...extra,
  };
}

/** Executa uma ação de verdade (já confirmada, ou livre). Nunca lança: erro vira { erro }. */
async function executeAction(name, args = {}, ctx = defaultCtx()) {
  const fn = IMPLS[name];
  if (!fn) return { erro: `ação desconhecida: ${name}` };
  try {
    return await fn(args && typeof args === 'object' ? args : {}, ctx);
  } catch (e) {
    return { erro: e.message || String(e) };
  }
}

/**
 * Chamada do modelo: ação livre roda; ação arriscada vira pendente (pending.push) e o modelo é avisado
 * para pedir a confirmação, sem dizer que já fez.
 */
async function requestAction(name, args = {}, { ctx = defaultCtx(), pending = [] } = {}) {
  if (!IMPLS[name]) return { erro: `ação desconhecida: ${name}` };
  const a = args && typeof args === 'object' ? args : {};
  if (riskOf(name, a) === 'livre') return executeAction(name, a, ctx);
  try {
    precheck(name, a, ctx.home);
  } catch (e) {
    return { erro: e.message };
  }
  const resumo = summarize(name, a);
  pending.push({ name, args: a, resumo });
  return { status: 'aguardando_confirmacao', resumo, instrucao: 'NÃO foi feito ainda. Diga em uma frase o que vai ser feito e peça para ele confirmar no botão "Confirmar" ou respondendo "confirma".' };
}

// ---------- Ferramentas para o modelo ----------

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ACTION_DEFS = [
  { name: 'volume', description: 'Volume do PC: subir, baixar, ligar/desligar o mudo ou definir um nível de 0 a 100.', parameters: obj({ acao: str('subir, baixar, mudo ou definir', { enum: ['subir', 'baixar', 'mudo', 'definir'] }), nivel: { type: 'number', description: 'para "definir": 0 a 100' }, passos: { type: 'number', description: 'para subir/baixar: cada passo é 2% (padrão 5 = 10%)' } }, ['acao']) },
  { name: 'midia', description: 'Controla a música/vídeo tocando: tocar ou pausar, próxima, anterior, parar.', parameters: obj({ acao: str('tocar_pausar, proxima, anterior ou parar', { enum: ['tocar_pausar', 'proxima', 'anterior', 'parar'] }) }, ['acao']) },
  { name: 'print', description: 'Tira um print da tela inteira e salva em Imagens\\Screenshots.', parameters: obj() },
  { name: 'copiar', description: 'Copia um texto para a área de transferência (para ele colar com Ctrl+V).', parameters: obj({ texto: str('o texto a copiar') }, ['texto']) },
  { name: 'lembrete', description: 'Marca um lembrete/timer: daqui a N minutos aparece uma notificação com o texto.', parameters: obj({ texto: str('o que lembrar'), minutos: { type: 'number', description: 'daqui a quantos minutos (1 a 1440)' } }, ['texto', 'minutos']) },
  { name: 'bloquear_tela', description: 'Bloqueia a tela do PC (Win+L).', parameters: obj() },
  { name: 'abrir_configuracao', description: `Abre uma tela de configuração do Windows. Opções: ${Object.keys(SETTINGS).join(', ')}.`, parameters: obj({ tela: str('uma das opções', { enum: Object.keys(SETTINGS) }) }, ['tela']) },
  { name: 'abrir', description: 'Abre um arquivo ou pasta no programa padrão (aceita apelidos: downloads, documentos, desktop, imagens...). Use o caminho completo achado por buscar_arquivos.', parameters: obj({ caminho: str('caminho do arquivo ou pasta') }, ['caminho']) },
  { name: 'buscar_arquivos', description: 'Procura arquivos e pastas pelo nome (ou parte dele) na Área de Trabalho, Documentos, Downloads, Imagens, Vídeos, Música e OneDrive, ou numa pasta dada.', parameters: obj({ nome: str('nome ou parte do nome'), pasta: str('opcional: onde procurar') }, ['nome']) },
  { name: 'ler_arquivo', description: 'Lê o texto de um arquivo PDF, Word (.docx) ou de texto (até 6 mil caracteres).', parameters: obj({ caminho: str('caminho do arquivo') }, ['caminho']) },
  { name: 'criar_pasta', description: 'Cria uma pasta (ex.: "documentos\\\\Contratos 2026").', parameters: obj({ caminho: str('caminho da pasta nova') }, ['caminho']) },
  { name: 'mover', description: 'Move um arquivo ou pasta para outro lugar. Pede confirmação dele.', parameters: obj({ origem: str('caminho atual'), destino: str('pasta ou caminho de destino') }, ['origem', 'destino']) },
  { name: 'renomear', description: 'Renomeia um arquivo ou pasta. Pede confirmação dele.', parameters: obj({ caminho: str('caminho atual'), novo_nome: str('só o nome novo, sem pasta') }, ['caminho', 'novo_nome']) },
  { name: 'lixeira', description: 'Manda um arquivo ou pasta para a Lixeira (dá para restaurar). Pede confirmação dele.', parameters: obj({ caminho: str('caminho do arquivo ou pasta') }, ['caminho']) },
  { name: 'fechar_programa', description: 'Fecha um programa aberto pelo nome do processo (ex.: chrome, spotify, WINWORD). Pede confirmação dele.', parameters: obj({ nome: str('nome do processo, sem .exe'), forcar: { type: 'boolean', description: 'true para forçar se ele não fechar sozinho' } }, ['nome']) },
  { name: 'limpar_temporarios', description: 'Apaga arquivos temporários do Windows com mais de 1 dia, para liberar espaço. Pede confirmação dele.', parameters: obj() },
  { name: 'esvaziar_lixeira', description: 'Esvazia a Lixeira (não dá para desfazer). Pede confirmação dele.', parameters: obj() },
  { name: 'energia', description: 'Desligar ou reiniciar o PC (com contagem em minutos, padrão 1), suspender, hibernar, ou cancelar um desligamento agendado. Cancelar roda na hora; o resto pede confirmação dele.', parameters: obj({ acao: str('desligar, reiniciar, suspender, hibernar ou cancelar', { enum: ['desligar', 'reiniciar', 'suspender', 'hibernar', 'cancelar'] }), minutos: { type: 'number', description: 'para desligar/reiniciar: daqui a quantos minutos' } }, ['acao']) },
].map((f) => ({ type: 'function', function: f })); // formato de "tools" do Ollama, como as de leitura
const ACTION_NAMES = new Set(ACTION_DEFS.map((d) => d.function.name));

// ---------- Quando é um pedido de ação no PC ----------

const norm = (t) => ` ${String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')} `;
// Assunto de projeto/código: isso continua com o Claude no Orca.
const CODE_RE = /\b(codigo|projeto|repositorio|repo|branch|commit|deploy|servidor|banco de dados|api|bug|funcao|tela do app|site|pagina)\b/;
const FILE_NOUN = '(arquivo|arquivos|pasta|pastas|documento|documentos|planilha|planilhas|pdf|pdfs|foto|fotos|imagem|imagens|video|videos|print|prints|download|downloads|\\.[a-z0-9]{2,4})';
const PC_NOUN = '(pc|computador|maquina|notebook|windows)';
// Programas/janelas que dá para fechar ("fecha o chrome"); sem isso, "fechar o contrato" não é ação no PC.
const APP_NOUN = '(programa|programas|app|apps|aplicativo|aplicativos|janela|janelas|processo|processos|navegador|chrome|edge|firefox|opera|brave|spotify|word|excel|powerpoint|outlook|teams|discord|steam|whatsapp|telegram|zoom|slack|obs|photoshop|vscode|vs code|bloco de notas|notepad|explorer|jogo|o que (esta|estiver) travad\\w*)';
// Cada grupo exige o verbo e o objeto: "qual o volume de vendas?" não mexe no volume.
const GROUPS = [
  [/\b(aument\w*|abaix\w*|baix[ae]\w*|sob[ea]\w*|diminu\w*|coloc\w*|deix[ae]\w*|poe|bota\w*)\b.*\b(volume|som)\b/, ['volume']],
  [/\b(muta\w*|desmuta\w*|tira o som|silencia (o pc|o computador|o som))\b|\bvolume (em|no|pra|para|a) \d/, ['volume']],
  [/\b(pausa\w*|despausa\w*|toca|tocar|pula|passa|volta|para)\b.*\b(musica|midia|faixa|spotify|video)\b|\b(proxima|anterior) (musica|faixa)\b/, ['midia']],
  [/\b(tir[ae]\w*|faz|faca|da|dar|bate|captur\w*)\b.*\b(print|screenshot|captura de tela|foto da tela)\b|\bprinta\w*\b/, ['print']],
  [/\b(copi[ae]\w*)\b.*\b(texto|isso|isto|esse|essa|este|esta|area de transferencia|clipboard)\b|\barea de transferencia\b/, ['copiar']],
  [/\b(me lembr\w*|lembrete|timer|alarme|me avis[ae]\w*|me cham[ae])\b.*\b(em|daqui|as|minutos?|min|horas?)\b|\b(timer|alarme|lembrete)\b/, ['lembrete']],
  [new RegExp(`\\b(bloque\\w*)\\b.*\\b(tela|${PC_NOUN.slice(1, -1)})\\b`), ['bloquear_tela']],
  [/\b(abr[aei]\w*|mostr\w*|vai (para|pra|nas?))\b.*\b(configurac\w*|ajustes|bluetooth|nao perturbe|notificac\w*|papel de parede|plano de fundo|wi-?fi)\b|\b(ativ\w*|lig[ae]\w*|deslig\w*)\b.*\bnao perturbe\b/, ['abrir_configuracao']],
  [new RegExp(`\\b(acha|ache|achar|encontr\\w*|procur\\w*|busc\\w*|localiz\\w*|onde (esta|fica|ta))\\b.*\\b${FILE_NOUN}`), ['buscar_arquivos', 'abrir']],
  [new RegExp(`\\b(le|leia|ler|resum\\w*|o que (tem|diz|fala))\\b.*\\b${FILE_NOUN}`), ['buscar_arquivos', 'ler_arquivo']],
  [new RegExp(`\\b(abr[ae]|abrir)\\b.*\\b${FILE_NOUN}`), ['buscar_arquivos', 'abrir']],
  [/\b(cri[ae]|criar)\b.*\bpastas?\b/, ['criar_pasta']],
  [new RegExp(`\\b(mov[ae]\\w*|mover|transfer\\w*|organiz\\w*)\\b.*\\b${FILE_NOUN}`), ['buscar_arquivos', 'mover', 'criar_pasta']],
  [new RegExp(`\\b(renome\\w*|muda o nome)\\b.*\\b${FILE_NOUN}`), ['buscar_arquivos', 'renomear']],
  [new RegExp(`\\b(apag\\w*|delet\\w*|exclu\\w*|joga\\w* fora|lixeira)\\b.*\\b${FILE_NOUN}`), ['buscar_arquivos', 'lixeira']],
  [/\b(esvazi\w*)\b.*\blixeira\b/, ['esvaziar_lixeira']],
  [new RegExp(`\\b(fech[ae]\\w*|fechar|mata|matar|encerr\\w*|finaliz\\w*|forca\\w* o fechamento)\\b.*\\b${APP_NOUN}`), ['fechar_programa']],
  [/\b(limp[ae]\w*|limpar|liberar? espaco|libera espaco|temporari\w*)\b.*\b(temporari\w*|lixeira|espaco|disco|pc|computador|cache)\b/, ['limpar_temporarios', 'esvaziar_lixeira']],
  [/\b(liberar? espaco|libera espaco)\b/, ['limpar_temporarios', 'esvaziar_lixeira']],
  [new RegExp(`\\b(deslig\\w*|reinici\\w*|suspend\\w*|hibern\\w*|dormir)\\b.*\\b${PC_NOUN}`), ['energia']],
  [/\bcancel\w* (o )?(desligamento|reinicio)\b/, ['energia']],
];

/** Ferramentas de ação que este pedido pode usar ([] = não é ação no PC). */
function actionToolsFor(text) {
  const t = norm(text);
  if (CODE_RE.test(t)) return [];
  const out = new Set();
  for (const [re, names] of GROUPS) if (re.test(t)) names.forEach((n) => out.add(n));
  return [...out];
}
const asksPcAction = (text) => actionToolsFor(text).length > 0;

module.exports = {
  ACTION_DEFS,
  ACTION_NAMES,
  PENDING_TTL,
  actionToolsFor,
  asksPcAction,
  requestAction,
  executeAction,
  riskOf,
  summarize,
  guardPath,
  cleanProcName,
  defaultCtx,
  IMPLS,
  SETTINGS,
};
