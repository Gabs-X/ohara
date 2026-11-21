'use strict';
// Baixar a Ohara-AI (o modelo local) de dentro do app, com progresso, sem abrir o terminal.
// O modelo só decide qual ferramenta usar; as funções (ler o PC, ações com confirmação) são código do app.
const os = require('os');
const { ollamaUrl, ollamaModels } = require('./providers/ollama');
const { psJson } = require('./pc-tools');

// Do mais forte ao mais leve. "minVramGB": cabe inteiro na placa de vídeo (rápido); "minRamGB": roda na
// memória do PC (mais lento, mas funciona).
const MODELS = [
  { id: 'qwen2.5:14b', label: 'Ohara-AI completa (14B)', sizeGB: 9, minVramGB: 12, minRamGB: 24, note: 'melhor qualidade; precisa de placa de vídeo com 12 GB ou mais' },
  { id: 'qwen2.5:7b', label: 'Ohara-AI leve (7B)', sizeGB: 4.7, minVramGB: 6, minRamGB: 12, note: 'cabe na maioria dos PCs' },
  { id: 'qwen2.5:3b', label: 'Ohara-AI mínima (3B)', sizeGB: 1.9, minVramGB: 0, minRamGB: 6, note: 'para PCs com pouca memória; erra mais nas ferramentas' },
];

/** Memória do PC e da maior placa de vídeo, em GB (vram 0 se não der para ler). */
async function readHardware({ run = psJson } = {}) {
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  let vramGB = 0;
  try {
    // AdapterRAM do Windows para em 4 GB (32 bits): lê o valor de 64 bits do registro quando existe.
    const r = await run(
      `$v=@(Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { $_.'HardwareInformation.qwMemorySize' } | Where-Object { $_ })
$c=@(Get-CimInstance Win32_VideoController | ForEach-Object { $_.AdapterRAM })
@{reg=$v; cim=$c}|ConvertTo-Json -Compress`,
      15_000,
    );
    const all = [...[].concat(r?.reg || []), ...[].concat(r?.cim || [])].map(Number).filter((n) => n > 0);
    if (all.length) vramGB = Math.round(Math.max(...all) / 1024 ** 3);
  } catch {
    vramGB = 0;
  }
  return { ramGB, vramGB };
}

/** O modelo mais forte que roda bem neste PC. */
// Com placa de vídeo que comporte o modelo, o mais forte que couber nela. Sem placa (ou pequena), roda na
// memória do PC: 7B com 16 GB ou mais, senão o 3B.
function recommendModel({ ramGB, vramGB }) {
  const gpu = MODELS.find((m) => m.minVramGB > 0 && vramGB >= m.minVramGB && ramGB >= 8);
  if (gpu) return gpu;
  return ramGB >= 16 ? MODELS.find((m) => m.id === 'qwen2.5:7b') : MODELS[MODELS.length - 1];
}

/** Situação para a tela: Ollama aberto?, modelos instalados, recomendação e se a Ohara-AI já está pronta. */
async function oharaAiStatus(config, { hardware = readHardware, list = ollamaModels } = {}) {
  const [hw, models] = await Promise.all([hardware().catch(() => ({ ramGB: Math.round(os.totalmem() / 1024 ** 3), vramGB: 0 })), list(config).catch(() => null)]);
  const rec = recommendModel(hw);
  const names = (models || []).map((m) => (typeof m === 'string' ? m : m.name || m.model || '')).filter(Boolean);
  const has = (id) => names.some((n) => n === id || n === `${id}:latest` || n.split(':latest')[0] === id);
  const current = config.ollama?.model || '';
  return {
    ollama: models !== null,
    hardware: hw,
    recommended: rec,
    models: MODELS.map((m) => ({ ...m, installed: has(m.id), fits: hw.vramGB >= m.minVramGB || hw.ramGB >= m.minRamGB })),
    current,
    ready: models !== null && !!current && has(current),
  };
}

/**
 * Baixa um modelo pelo Ollama (POST /api/pull), avisando o progresso em %. Só aceita os modelos da lista.
 * @param {(p:{status:string, percent:number|null, completedGB:number, totalGB:number})=>void} [onProgress]
 */
async function pullModel(config, id, { onProgress, signal, fetchImpl = fetch } = {}) {
  if (!MODELS.some((m) => m.id === id)) throw new Error('Modelo fora da lista da Ohara-AI.');
  let res;
  try {
    res = await fetchImpl(`${ollamaUrl(config)}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: id, stream: true }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new Error('Download cancelado.');
    throw new Error('O Ollama não está aberto. Instale ou abra o Ollama e tente de novo.');
  }
  if (!res.ok) throw new Error(`O Ollama recusou o download (${res.status}).`);
  const decoder = new TextDecoder();
  let buf = '';
  let last = null;
  const gb = (n) => Math.round((Number(n) / 1024 ** 3) * 10) / 10;
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.error) throw new Error(`Ollama: ${ev.error}`);
        last = ev.status || last;
        const percent = ev.total ? Math.min(100, Math.round((ev.completed / ev.total) * 100)) : null;
        onProgress?.({ status: ev.status || '', percent, completedGB: gb(ev.completed || 0), totalGB: gb(ev.total || 0) });
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('Download cancelado.');
    throw e;
  }
  if (last !== 'success') throw new Error('O download não terminou. Tente de novo (ele continua de onde parou).');
  return { model: id };
}

module.exports = { MODELS, readHardware, recommendModel, oharaAiStatus, pullModel };
