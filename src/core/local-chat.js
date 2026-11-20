// Chat da Ohara no modelo local (Ollama). O modelo não guarda nada entre chamadas:
// "memória" aqui é o histórico da conversa + o índice de memória do Gabriel, mandados a cada pedido.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_HISTORY_CHARS = 14_000; // ~4 mil tokens de histórico; cabe folgado nos 16 mil do contexto
const MAX_MSG_CHARS = 2500;

function memoryFile(config) {
  const custom = config.ollama?.memoryFile;
  if (custom) return custom.replace(/^~(?=$|[\\/])/, os.homedir());
  const base = (config.claude?.configDir || path.join(os.homedir(), '.claude-pessoal')).replace(/^~(?=$|[\\/])/, os.homedir());
  return path.join(base, 'projects', 'C--Users-gabri', 'memory', 'MEMORY.md');
}

// Índice de memória do Gabriel (uma linha por assunto). Opcional: sem o arquivo, segue sem.
function readMemory(config) {
  try {
    return fs.readFileSync(memoryFile(config), 'utf8').trim().slice(0, 4000);
  } catch {
    return '';
  }
}

function systemPrompt(config, { project } = {}) {
  const mem = readMemory(config);
  return [
    'Você é a Ohara, assistente pessoal do Gabriel rodando no PC dele (Windows 11). Responda sempre em português do Brasil, de forma direta.',
    'Você tem bom humor: é leve e às vezes solta uma piada curta, como uma amiga que manja muito. No máximo uma brincadeira por resposta, nunca quando ele estiver com problema sério ou pressa. Não faça referências a One Piece nem a animes.',
    'Aqui no chat você só conversa: responde, explica, escreve, resume, planeja e tira dúvidas. Você NÃO executa comandos, não mexe em arquivos e não navega na internet.',
    'Pedidos que exigem isso (alterar código, rodar comandos, pesquisar na web, usar o navegador) a Ohara encaminha sozinha para o Claude no Orca; você não precisa fazer nada nem prometer que fez.',
    'Se não souber algo ou não tiver certeza, diga isso em vez de inventar. Nunca invente fatos, links, números ou nomes de arquivos.',
    config.selfRepo ? `Você pode melhorar a si mesma: o seu código está em ${config.selfRepo}. Quando um pedido esbarrar em algo que você ainda não sabe fazer (uma integração ou recurso que falta), explique em uma frase o que falta, ofereça-se para se alterar e, no fim da resposta, inclua exatamente uma linha: [[melhoria: o que mudar em você, em uma frase objetiva]]. Essa linha não aparece para ele; se ele aceitar, o Claude implementa no Orca. Só ofereça quando não der para resolver de outro jeito.` : '',
    project ? `Projeto em foco nesta conversa: ${project}.` : '',
    mem ? `\nO que você já sabe sobre o Gabriel (memória):\n${mem}` : '',
  ].filter(Boolean).join('\n');
}

const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, n)}…` : String(t));

// Últimas mensagens que cabem no orçamento, da mais antiga para a mais nova.
function buildHistory(messages) {
  const out = [];
  let total = 0;
  for (const m of [...messages].reverse()) {
    if (!m.text) continue;
    const content = clip(m.text, MAX_MSG_CHARS);
    if (total + content.length > MAX_HISTORY_CHARS) break;
    out.unshift({ role: m.role === 'user' ? 'user' : 'assistant', content });
    total += content.length;
  }
  return out;
}

/**
 * @param {object} o
 * @param {object} o.config
 * @param {{role:string,text:string}[]} o.history mensagens anteriores (sem a atual)
 * @param {string} o.text pedido atual
 * @param {string} [o.project]
 * @param {AbortSignal} [o.signal]
 * @param {(chunk:string)=>void} [o.onDelta]
 */
async function chatLocal({ config, history, text, project, signal, onDelta }) {
  const o = config.ollama || {};
  const url = `${o.url || 'http://127.0.0.1:11434'}/api/chat`;
  const timeout = AbortSignal.timeout((o.timeoutSec || 180) * 1000);
  const messages = [{ role: 'system', content: systemPrompt(config, { project }) }, ...buildHistory(history), { role: 'user', content: text }];
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages, stream: true, options: { num_ctx: o.contextTokens || 16384 } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(`O modelo local não respondeu (${e.cause?.code || e.name}). Confira se o Ollama está aberto.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(/not found/i.test(body) ? `O modelo ${o.model} não está instalado no Ollama (rode: ollama pull ${o.model}).` : `Ollama respondeu ${res.status}: ${body.slice(0, 200)}`);
  }

  let full = '';
  let last = {};
  const decoder = new TextDecoder();
  let buf = '';
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
      const piece = ev.message?.content || '';
      if (piece) {
        full += piece;
        onDelta?.(piece);
      }
      if (ev.done) last = ev;
    }
  }
  return {
    provider: 'ollama',
    model: o.model,
    text: full.trim(),
    tokens: { input: last.prompt_eval_count || 0, cached: 0, output: last.eval_count || 0, costUsd: 0 },
  };
}

module.exports = { chatLocal, buildHistory, systemPrompt, readMemory };
