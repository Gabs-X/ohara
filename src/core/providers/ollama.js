// Provedor local (Ollama): grátis, offline e sem cota, mas sem ferramentas (não mexe em arquivos).
// Serve para conversa, perguntas rápidas e textos.

const DEFAULT_URL = 'http://127.0.0.1:11434';

function ollamaUrl(config) {
  return (config.ollama?.url || DEFAULT_URL).replace(/\/+$/, '');
}

/** Modelos instalados no Ollama, ou null se ele não estiver rodando. */
async function ollamaModels(config, timeoutMs = 2500) {
  try {
    const res = await fetch(`${ollamaUrl(config)}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  } catch {
    return null;
  }
}

/**
 * Conversa com histórico, em fluxo. O histórico vai inteiro a cada pedido (o modelo não guarda nada).
 * @param {object} o { prompt, systemPrompt, history:[{role,text}], model, config, onEvent, signal }
 */
async function runOllama(o) {
  const { config } = o;
  const model = o.model || config.ollama?.model;
  const messages = [{ role: 'system', content: o.systemPrompt || '' }];
  for (const m of o.history || []) {
    if (!m.text) continue;
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text).slice(0, 4000) });
  }
  messages.push({ role: 'user', content: o.prompt });
  const timeout = AbortSignal.timeout((config.ollama?.timeoutSec || 180) * 1000);
  const body = { model, stream: true, messages };
  if (config.ollama?.contextTokens) body.options = { num_ctx: config.ollama.contextTokens };

  let res;
  try {
    res = await fetch(`${ollamaUrl(config)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
  } catch (e) {
    if (o.signal?.aborted) return { provider: 'ollama', model, text: '', error: 'Cancelado.', tokens: {} };
    return { provider: 'ollama', model, text: '', error: `A IA local (Ollama) não respondeu (${e.cause?.code || e.name}).`, tokens: {} };
  }
  if (!res.ok) return { provider: 'ollama', model, text: '', error: `A IA local respondeu ${res.status}.`, tokens: {} };

  let text = '';
  let tokens = { input: 0, cached: 0, output: 0, costUsd: 0 };
  let buf = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const t = j.message?.content || '';
        if (t) {
          text += t;
          o.onEvent?.({ kind: 'delta', text: t });
        }
        if (j.done) tokens = { input: j.prompt_eval_count || 0, cached: 0, output: j.eval_count || 0, costUsd: 0 };
      }
    }
  } catch (e) {
    if (o.signal?.aborted) return { provider: 'ollama', model, text: text.trim(), error: text ? null : 'Cancelado.', tokens };
    if (!text) return { provider: 'ollama', model, text: '', error: `A IA local parou no meio (${e.name}).`, tokens };
  }
  return { provider: 'ollama', model, text: text.trim(), error: text.trim() ? null : 'A IA local devolveu resposta vazia.', tokens };
}

module.exports = { runOllama, ollamaModels, ollamaUrl };
