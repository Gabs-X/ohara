// Chamadas diretas ao Ollama para as ferramentas locais (documentos, extração, triagem, foto, privacidade,
// commit e diagnóstico). Diferente do askOnce, aqui NUNCA há reserva no Claude: são dados do escritório
// e de clientes, então se o Ollama estiver fora do ar a função para com um erro claro.
const fs = require('fs');
const path = require('path');

const baseUrl = (config) => (config.ollama?.url || 'http://127.0.0.1:11434').replace(/\/+$/, '');

function tryJson(s) {
  try {
    return JSON.parse(String(s || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
}

async function post(config, route, body, { signal, timeoutSec } = {}) {
  const timeout = AbortSignal.timeout((timeoutSec || config.ollama?.timeoutSec || 180) * 1000);
  let res;
  try {
    res = await fetch(`${baseUrl(config)}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e.name === 'TimeoutError') throw new Error('O modelo local demorou demais para responder. Tente um texto menor.');
    throw new Error(`O Ollama não respondeu (${e.cause?.code || e.name}). Confira se ele está aberto.`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/not found/i.test(text)) throw new Error(`O modelo ${body.model} não está instalado no Ollama (rode: ollama pull ${body.model}).`);
    throw new Error(`Ollama respondeu ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Uma resposta do modelo local. Com `schema`, devolve o objeto já validado como JSON.
 * @param {object} o
 * @param {object} o.config
 * @param {string} [o.system]
 * @param {string} o.prompt
 * @param {object} [o.schema] JSON Schema (o Ollama força o formato)
 * @param {string[]} [o.images] caminhos de imagem (usa o modelo de visão)
 * @param {string} [o.model] força um modelo
 * @param {number} [o.temperature]
 * @param {AbortSignal} [o.signal]
 */
async function generate({ config, system, prompt, schema, images, model, temperature = 0.2, signal, timeoutSec }) {
  const o = config.ollama || {};
  const useModel = model || (images?.length ? o.visionModel || 'qwen2.5vl:7b' : o.model);
  const user = { role: 'user', content: prompt };
  if (images?.length) user.images = images.map((f) => fs.readFileSync(f).toString('base64'));
  const body = {
    model: useModel,
    stream: false,
    messages: [...(system ? [{ role: 'system', content: system }] : []), user],
    options: { num_ctx: o.contextTokens || 16384, temperature },
  };
  if (schema) body.format = schema;
  const j = await post(config, '/api/chat', body, { signal, timeoutSec });
  const raw = j.message?.content || '';
  const data = schema ? tryJson(raw) : raw.trim();
  if (!data) throw new Error('O modelo local devolveu uma resposta vazia ou fora do formato. Tente de novo.');
  return { data, model: useModel, tokens: { input: j.prompt_eval_count || 0, output: j.eval_count || 0 } };
}

/** Vetores (embeddings) de vários textos, no modelo de embeddings configurado. */
async function embed({ config, texts, signal }) {
  if (!texts.length) return [];
  const model = config.ollama?.embedModel || 'bge-m3';
  const j = await post(config, '/api/embed', { model, input: texts, truncate: true }, { signal, timeoutSec: 600 });
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error('O modelo de embeddings devolveu uma resposta inesperada.');
  return j.embeddings;
}

/** Quais modelos estão instalados (para a tela mostrar o que falta baixar). */
async function installedModels(config) {
  try {
    const res = await fetch(`${baseUrl(config)}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  } catch {
    return null;
  }
}

const hasModel = (list, name) => !!list?.some((m) => m === name || m === `${name}:latest` || m.split(':')[0] === name);

module.exports = { generate, embed, installedModels, hasModel, tryJson, imageExt: (f) => /\.(png|jpe?g|webp)$/i.test(path.extname(f)) };
