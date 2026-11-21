// Ferramentas de LEITURA do PC para a Ohara-AI (modelo local com "tools" do Ollama).
// Nada aqui altera o sistema: só consulta discos, memória, processos, navegadores, programas, rede e pastas.
// Assim, perguntas como "quanto tenho de armazenamento?" são respondidas no PC, sem chamar o Claude.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { psLiteral } = require('./ps');

const GB = 1024 ** 3;
const gb = (n) => Math.round((Number(n) / GB) * 10) / 10;
const mb = (n) => Math.round(Number(n) / 1024 ** 2);
const size = (n) => (Number(n) >= GB ? `${gb(n)} GB` : `${mb(n)} MB`);

// Roda um script do PowerShell e devolve o JSON que ele escreve (ConvertTo-Json).
function psJson(script, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    // -EncodedCommand: pelo stdin o PowerShell lê linha a linha e quebra comandos de várias linhas.
    const full = `$ErrorActionPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${script}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('o Windows demorou demais para responder'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (!text) return reject(new Error(err.trim().split('\n')[0] || `PowerShell saiu com código ${code}`));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('resposta do Windows fora do formato'));
      }
    });
  });
}

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

async function armazenamento({ run = psJson } = {}) {
  const disks = arr(await run(`@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3 OR DriveType=2" | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType) | ConvertTo-Json -Compress`));
  const unidades = disks
    .filter((d) => Number(d.Size) > 0)
    .map((d) => {
      const total = gb(d.Size);
      const livre = gb(d.FreeSpace);
      return {
        unidade: d.DeviceID,
        nome: d.VolumeName || '',
        tipo: d.DriveType === 2 ? 'removível' : 'interno',
        totalGB: total,
        livreGB: livre,
        usadoGB: Math.round((total - livre) * 10) / 10,
        usoPct: total ? Math.round(((total - livre) / total) * 100) : 0,
      };
    });
  return { unidades };
}

async function sistema({ run = psJson } = {}) {
  const r = await run(`$os = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor)[0]
$bat = @(Get-CimInstance Win32_Battery)[0]
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name)
[pscustomobject]@{
  so = $os.Caption; versao = $os.Version; build = $os.BuildNumber
  ligadoDesde = $os.LastBootUpTime.ToString('o')
  cpu = $cpu.Name; nucleos = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; cpuUsoPct = $cpu.LoadPercentage
  gpu = $gpu
  bateriaPct = if ($bat) { $bat.EstimatedChargeRemaining } else { $null }
  carregando = if ($bat) { $bat.BatteryStatus -eq 2 } else { $null }
} | ConvertTo-Json -Compress`);
  const total = os.totalmem();
  const free = os.freemem();
  const boot = r.ligadoDesde ? new Date(r.ligadoDesde) : null;
  const horas = boot ? Math.round(((Date.now() - boot.getTime()) / 3_600_000) * 10) / 10 : null;
  return {
    computador: os.hostname(),
    usuario: os.userInfo().username,
    sistema: [r.so, r.build ? `build ${r.build}` : ''].filter(Boolean).join(' '),
    processador: String(r.cpu || '').trim(),
    nucleos: r.nucleos,
    threads: r.threads,
    cpuUsoPct: r.cpuUsoPct,
    placaDeVideo: arr(r.gpu),
    memoriaTotalGB: gb(total),
    memoriaLivreGB: gb(free),
    memoriaUsoPct: Math.round(((total - free) / total) * 100),
    ligadoHaHoras: horas,
    bateria: r.bateriaPct == null ? 'sem bateria (desktop) ou não detectada' : `${r.bateriaPct}%${r.carregando ? ' (carregando)' : ''}`,
  };
}

async function processos({ ordenar = 'memoria', limite = 10, run = psJson } = {}) {
  const n = Math.max(1, Math.min(30, Number(limite) || 10));
  const list = arr(await run(`@(Get-Process | Group-Object ProcessName | ForEach-Object {
  [pscustomobject]@{ nome = $_.Name; instancias = $_.Count; memoria = ($_.Group | Measure-Object WorkingSet64 -Sum).Sum; cpu = [math]::Round(($_.Group | Measure-Object CPU -Sum).Sum, 1) }
}) | ConvertTo-Json -Compress`));
  const key = ordenar === 'cpu' ? 'cpu' : 'memoria';
  return {
    ordenadoPor: key === 'cpu' ? 'tempo de CPU acumulado (segundos)' : 'memória em uso',
    processos: list
      .sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0))
      .slice(0, n)
      .map((p) => ({ nome: p.nome, instancias: p.instancias, memoria: size(p.memoria || 0), cpuSegundos: p.cpu || 0 })),
  };
}

// Navegadores conhecidos: onde fica o executável e o nome do processo.
const BROWSERS = [
  { nome: 'Google Chrome', proc: 'chrome', rel: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
  { nome: 'Microsoft Edge', proc: 'msedge', rel: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
  { nome: 'Mozilla Firefox', proc: 'firefox', rel: ['Mozilla Firefox', 'firefox.exe'] },
  { nome: 'Brave', proc: 'brave', rel: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'] },
  { nome: 'Opera', proc: 'opera', rel: ['Programs', 'Opera', 'opera.exe'] },
  { nome: 'Opera GX', proc: 'opera', rel: ['Programs', 'Opera GX', 'opera.exe'] },
  { nome: 'Vivaldi', proc: 'vivaldi', rel: ['Vivaldi', 'Application', 'vivaldi.exe'] },
];

function findBrowsers(env = process.env, exists = fs.existsSync) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const out = [];
  for (const b of BROWSERS) {
    const exe = roots.map((r) => path.join(r, ...b.rel)).find((p) => exists(p));
    if (exe) out.push({ ...b, exe });
  }
  return out;
}

async function navegadores({ run = psJson, find = findBrowsers } = {}) {
  const found = find();
  const names = [...new Set(BROWSERS.map((b) => b.proc))].map((p) => `'${p}'`).join(',');
  const exes = found.map((b) => psLiteral(b.exe)).join(',');
  const r = await run(`$v = @{}
foreach ($e in @(${exes})) { $v[$e] = (Get-Item $e).VersionInfo.ProductVersion }
$p = @(Get-Process -Name ${names} | Group-Object ProcessName | ForEach-Object {
  [pscustomobject]@{ proc = $_.Name; instancias = $_.Count; memoria = ($_.Group | Measure-Object WorkingSet64 -Sum).Sum; janelas = @($_.Group | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }) }
})
[pscustomobject]@{ versoes = $v; abertos = $p } | ConvertTo-Json -Compress -Depth 4`);
  const open = arr(r.abertos);
  return {
    observacao: 'Do lado de fora do navegador só dá para ver o título da aba ativa de cada janela, não a lista de todas as abas.',
    instalados: found.map((b) => {
      const p = open.find((x) => x.proc === b.proc);
      return {
        nome: b.nome,
        versao: r.versoes?.[b.exe] || null,
        aberto: !!p,
        ...(p ? { memoria: size(p.memoria || 0), processos: p.instancias, janelas: arr(p.janelas) } : {}),
      };
    }),
  };
}

async function programas({ busca = '', limite = 40, run = psJson } = {}) {
  const n = Math.max(1, Math.min(100, Number(limite) || 40));
  const list = arr(await run(`@(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object @{n='nome';e={$_.DisplayName}},@{n='versao';e={$_.DisplayVersion}},@{n='editor';e={$_.Publisher}},@{n='tamanhoMB';e={[math]::Round($_.EstimatedSize/1024)}}) | ConvertTo-Json -Compress`, 20_000));
  const q = normalize(busca).trim();
  const seen = new Set();
  const all = list.filter((p) => {
    const k = `${p.nome}|${p.versao}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return !q || normalize(`${p.nome} ${p.editor || ''}`).includes(q);
  });
  return { total: all.length, programas: all.sort((a, b) => String(a.nome).localeCompare(String(b.nome))).slice(0, n), ...(all.length > n ? { aviso: `mostrando ${n} de ${all.length}; refine a busca` } : {}) };
}

async function rede({ run = psJson } = {}) {
  const r = await run(`$ad = @(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
  [pscustomobject]@{ adaptador = $_.InterfaceAlias; ipv4 = @($_.IPv4Address.IPAddress); gateway = @($_.IPv4DefaultGateway.NextHop) }
})
$ssid = (netsh wlan show interfaces) | Select-String '^\\s*SSID\\s*:' | Select-Object -First 1 | ForEach-Object { ($_ -split ':',2)[1].Trim() }
$net = Test-Connection 1.1.1.1 -Count 1 -Quiet
[pscustomobject]@{ adaptadores = $ad; wifi = "$ssid"; internet = [bool]$net } | ConvertTo-Json -Compress -Depth 4`, 20_000);
  return { adaptadores: arr(r.adaptadores), wifi: typeof r.wifi === 'string' && r.wifi ? r.wifi : 'sem Wi-Fi (cabo ou desligado)', internet: !!r.internet };
}

// Pastas conhecidas pelo nome ("Downloads", "área de trabalho") ou caminho completo.
const KNOWN = {
  downloads: 'Downloads',
  download: 'Downloads',
  documentos: 'Documents',
  documents: 'Documents',
  desktop: 'Desktop',
  'area de trabalho': 'Desktop',
  imagens: 'Pictures',
  fotos: 'Pictures',
  pictures: 'Pictures',
  videos: 'Videos',
  musicas: 'Music',
  music: 'Music',
  usuario: '',
  home: '',
};

function resolveFolder(input, home = os.homedir()) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw || raw === '~') return home;
  const key = normalize(raw).trim();
  if (key in KNOWN) return path.join(home, KNOWN[key]);
  if (/^~[\\/]/.test(raw)) return path.join(home, raw.slice(2));
  if (/^[a-z]:$/i.test(raw)) return `${raw}\\`;
  return path.resolve(raw);
}

// Tamanho de uma pasta, com limite de tempo e de arquivos para não travar em pastas enormes.
function folderSize(dir, budget) {
  let size = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > budget.until || budget.files > budget.maxFiles) {
      budget.partial = true;
      break;
    }
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        budget.files++;
        try {
          size += fs.statSync(p).size;
        } catch {}
      }
    }
  }
  return size;
}

async function pasta({ caminho = '', limite = 25, calcularTamanho = true, home = os.homedir(), timeMs = 8000 } = {}) {
  const dir = resolveFolder(caminho, home);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { erro: e.code === 'ENOENT' ? `a pasta ${dir} não existe` : `não consegui abrir ${dir} (${e.code || e.message})` };
  }
  const budget = { until: Date.now() + timeMs, files: 0, maxFiles: 300_000, partial: false };
  const items = entries
    .filter((e) => !e.isSymbolicLink())
    .map((e) => {
      const p = path.join(dir, e.name);
      let st = null;
      try {
        st = fs.statSync(p);
      } catch {}
      const isDir = e.isDirectory();
      const bytes = isDir ? (calcularTamanho ? folderSize(p, budget) : null) : st?.size || 0;
      return { nome: e.name, tipo: isDir ? 'pasta' : 'arquivo', bytes, modificado: st ? st.mtime.toISOString().slice(0, 10) : null };
    });
  const total = items.reduce((s, i) => s + (i.bytes || 0), 0);
  const n = Math.max(1, Math.min(100, Number(limite) || 25));
  return {
    pasta: dir,
    totalItens: items.length,
    pastas: items.filter((i) => i.tipo === 'pasta').length,
    arquivos: items.filter((i) => i.tipo === 'arquivo').length,
    tamanhoTotalGB: gb(total),
    ...(budget.partial ? { aviso: 'pasta grande: os tamanhos são parciais (parei por tempo)' } : {}),
    maiores: items
      .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
      .slice(0, n)
      .map((i) => ({ nome: i.nome, tipo: i.tipo, tamanho: i.bytes == null ? '?' : size(i.bytes), modificado: i.modificado })),
  };
}

const IMPLS = { armazenamento, sistema, processos, navegadores, programas, rede, pasta };

// Definições no formato de "tools" do Ollama.
const TOOL_DEFS = [
  { name: 'armazenamento', description: 'Espaço em disco do PC: cada unidade (C:, D:...) com total, livre, usado e % de uso.', parameters: { type: 'object', properties: {} } },
  { name: 'sistema', description: 'Informações do PC: Windows, processador, uso de CPU, memória RAM total/livre, placa de vídeo, há quanto tempo está ligado e bateria.', parameters: { type: 'object', properties: {} } },
  {
    name: 'processos',
    description: 'Programas rodando agora, os que mais usam memória ou CPU.',
    parameters: { type: 'object', properties: { ordenar: { type: 'string', enum: ['memoria', 'cpu'] }, limite: { type: 'integer', description: 'quantos mostrar (padrão 10)' } } },
  },
  { name: 'navegadores', description: 'Navegadores instalados (Chrome, Edge, Firefox, Brave, Opera, Vivaldi), versão, se estão abertos, memória e o título da aba ativa de cada janela.', parameters: { type: 'object', properties: {} } },
  {
    name: 'programas',
    description: 'Programas instalados no Windows, com versão. Use "busca" para filtrar pelo nome.',
    parameters: { type: 'object', properties: { busca: { type: 'string', description: 'parte do nome, ex.: "office", "node"' }, limite: { type: 'integer' } } },
  },
  { name: 'rede', description: 'Rede do PC: adaptadores conectados, IP local, gateway, nome do Wi-Fi e se há internet.', parameters: { type: 'object', properties: {} } },
  {
    name: 'pasta',
    description: 'Lista uma pasta com os itens que mais ocupam espaço e o tamanho total. Aceita nomes como "Downloads", "Documentos", "área de trabalho" ou um caminho completo (ex.: "C:\\\\Users").',
    parameters: { type: 'object', properties: { caminho: { type: 'string' }, limite: { type: 'integer' } }, required: ['caminho'] },
  },
].map((f) => ({ type: 'function', function: f }));

/**
 * Executa uma ferramenta pelo nome. Nunca lança: erro vira { erro } para o modelo explicar.
 * @returns {Promise<object>}
 */
async function runPcTool(name, args = {}, impls = IMPLS) {
  const fn = impls[name];
  if (!fn) return { erro: `ferramenta desconhecida: ${name}` };
  try {
    const a = args && typeof args === 'object' ? args : {};
    const clean = Object.fromEntries(Object.entries(a).filter(([k]) => ['ordenar', 'limite', 'busca', 'caminho'].includes(k)));
    return await fn(clean);
  } catch (e) {
    return { erro: e.message || String(e) };
  }
}

function normalize(text) {
  return ` ${String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')} `;
}

// Pergunta sobre o próprio PC, que as ferramentas acima respondem sem o Claude.
const PC_TOPIC_RE = /\b(armazenamento|espaco|disco|discos|hd|ssd|memoria|ram|cpu|processador|processos?|programas?|aplicativos?|apps?|navegador(es)?|browsers?|chrome|edge|firefox|brave|opera|vivaldi|wi-?fi|rede|internet|ip|bateria|placa de video|gpu|downloads|pasta|pastas|pc|computador|maquina|notebook|windows|ligado|instalad\w*|pesando|lento|travando)\b/;
// Pedido para mudar algo ou usar um site: aí não é só consulta.
const PC_CHANGE_RE = /\b(apag\w*|delet\w*|remov\w*|exclu\w*|limp[ae]\w*|limpar|desinstal\w*|instal(a|e|ar|ando|ou|em)|fech[ae]\w*|fechar|mat[ae]|matar|encerr\w*|mov[ae]\w*|mover|renome\w*|alter\w*|mud[ae]\w*|mudar|configur(a|e|ar|ando)|atualiz(a|e|ar|ando)|baix[ae]\w*|baixar|abr[aei]\w*|abrir|entr[ae]\w*|acess[ae]\w*|acessar|navegu\w*|pesquis\w*|preench\w*|candidat\w*|cri[ae]\w*|criar|corrig\w*|conserta\w*|implement\w*|codigo|commit\w*|faz|faca|fazer|faze\w*|rod[ae]\w*|execut\w*|escrev\w*|ger[ae]\w*|organiz\w*|backup|compact\w*|otimiz\w*|formata\w*|reinici\w*|deslig\w*|envi[ae]\w*|mand[ae]\w*)\b/;
const PC_SITES_RE = /\b(linkedin|gmail|instagram|whatsapp|vagas?|site|pagina|login|logad\w*|http\w*|www)\b/;

// Consultas óbvias pelo assunto da pergunta: a Ohara já faz antes de chamar o modelo, para ele não
// responder sem olhar (o modelo local às vezes não chama a ferramenta sozinho).
const GUESSES = [
  [/\b(armazenamento|espaco|disco|discos|hd|ssd)\b/, 'armazenamento'],
  [/\b(memoria|ram|cpu|processador|bateria|placa de video|gpu|windows|ligado|configurac\w*|meu pc|meu computador|minha maquina)\b/, 'sistema'],
  [/\b(pesando|pesad\w*|lento|lerdo|travando|processos?|consumindo|gastando)\b/, 'processos'],
  [/\b(navegador(es)?|browsers?|chrome|edge|firefox|brave|opera|vivaldi|abas?)\b/, 'navegadores'],
  [/\b(rede|wi-?fi|internet|ip|conectad\w*)\b/, 'rede'],
];
const FOLDER_RE = /\b(downloads?|documentos|area de trabalho|desktop|imagens|fotos|videos|musicas)\b/;

/** @returns {{name:string,args:object}[]} */
function guessTools(text) {
  const t = normalize(text);
  if (!asksPcInfo(text)) return [];
  const out = GUESSES.filter(([re]) => re.test(t)).map(([, name]) => ({ name, args: {} }));
  const folder = FOLDER_RE.exec(t);
  if (folder) out.push({ name: 'pasta', args: { caminho: folder[1] } });
  const prog = /\b(?:tenho|tem|esta) (?:o |a )?([a-z0-9.+-]{2,30}) instalad/.exec(t);
  if (prog && !GUESSES.some(([re]) => re.test(` ${prog[1]} `))) out.push({ name: 'programas', args: { busca: prog[1] } });
  else if (/\b(programas?|aplicativos?|apps?) instalad/.test(t)) out.push({ name: 'programas', args: {} });
  return out.slice(0, 3);
}

function asksPcInfo(text) {
  const t = normalize(text);
  return PC_TOPIC_RE.test(t) && !PC_CHANGE_RE.test(t) && !PC_SITES_RE.test(t);
}

module.exports = { psJson, TOOL_DEFS, runPcTool, asksPcInfo, guessTools, resolveFolder, findBrowsers, armazenamento, sistema, processos, navegadores, programas, rede, pasta };
