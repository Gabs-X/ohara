// Provedor Gemini: usa o Gemini CLI (npm i -g @google/gemini-cli) em modo sem interface:
// gemini -p --output-format stream-json. Login com a conta Google (camada grátis) ou GEMINI_API_KEY.
const os = require('os');
const { runJsonl, shorten } = require('./common');

// Nomes de campo variam entre versões do CLI: o leitor aceita as variações conhecidas.
function eventText(ev) {
  if (typeof ev.content === 'string') return ev.content;
  if (typeof ev.text === 'string') return ev.text;
  if (Array.isArray(ev.content)) return ev.content.map((p) => p?.text || '').join('');
  return '';
}

function statsTokens(stats = {}) {
  const input = stats.input_tokens ?? stats.inputTokens ?? stats.prompt_tokens ?? 0;
  const output = stats.output_tokens ?? stats.outputTokens ?? stats.candidates_tokens ?? 0;
  const cached = stats.cached_tokens ?? stats.cachedTokens ?? 0;
  const total = stats.total_tokens ?? stats.totalTokens ?? 0;
  // Só veio o total: conta tudo como entrada (a cota do Gemini é por pedido, não por token).
  if (!input && !output && total) return { input: total, cached: 0, output: 0 };
  return { input: Math.max(0, input - cached), cached, output };
}

function describeTool(ev) {
  const name = ev.tool_name || ev.name || 'ferramenta';
  const p = ev.parameters || ev.args || {};
  const arg = p.command || p.file_path || p.absolute_path || p.path || p.pattern || p.url || p.query || '';
  return `${name}${arg ? `: ${shorten(arg, 140)}` : ''}`;
}

function buildGeminiArgs(o) {
  const args = ['--output-format', 'stream-json'];
  if (o.model && o.model !== 'auto') args.push('-m', o.model);
  // auto_edit: edita arquivos sem perguntar; comandos de terminal seguem a política do próprio CLI.
  args.push('--approval-mode', o.approvalMode || 'auto_edit');
  if (o.sessionId) args.push('--resume', o.sessionId);
  args.push('-p', ''); // o pedido vai pela entrada padrão ("-p" é somado a ela)
  return args;
}

/**
 * Parser do fluxo de eventos, separado para ser testado sem o CLI instalado.
 * @returns {{ onJson:(ev:object)=>void, state:object }}
 */
function geminiStream(onEvent, model) {
  const state = { sessionId: null, text: '', tokens: { input: 0, cached: 0, output: 0 }, error: null, model };
  const onJson = (ev) => {
    switch (ev.type) {
      case 'init':
        state.sessionId = ev.session_id || ev.sessionId || state.sessionId;
        if (ev.model) state.model = ev.model;
        break;
      case 'message': {
        if (ev.role && ev.role !== 'assistant' && ev.role !== 'model') break;
        const t = eventText(ev);
        if (!t) break;
        state.text += t;
        onEvent({ kind: 'delta', text: t });
        break;
      }
      case 'tool_use':
        onEvent({ kind: 'tool', text: describeTool(ev) });
        break;
      case 'error':
        if (ev.severity !== 'warning') state.error = ev.message || 'Erro no Gemini';
        break;
      case 'result': {
        state.tokens = statsTokens(ev.stats || ev.usage || {});
        if (ev.status === 'error' || ev.error) state.error = ev.error?.message || ev.error || state.error || 'Falha no Gemini';
        const final = typeof ev.response === 'string' ? ev.response : '';
        if (!state.text.trim() && final) {
          state.text = final;
          onEvent({ kind: 'delta', text: final });
        }
        break;
      }
      default:
        break;
    }
  };
  return { onJson, state };
}

function friendlyGeminiError(msg) {
  const m = String(msg || '');
  if (/auth|login|credential|GEMINI_API_KEY/i.test(m)) return 'O Gemini não está logado. Abra "Primeiros passos" e clique em "Fazer login" no Gemini.';
  if (/quota|429|RESOURCE_EXHAUSTED|rate limit/i.test(m)) return 'A cota grátis do Gemini acabou por hoje. A Ohara vai usar outra IA.';
  return m;
}

async function runGemini(o) {
  const { config } = o;
  let prompt = o.sessionId ? o.prompt : `${o.systemPrompt}\n\n---\n\n${o.prompt}`;
  if (o.images?.length) prompt += `\n\n[Imagens anexadas — leia os arquivos para ver]\n${o.images.map((p) => `@${p}`).join('\n')}`;
  const { onJson, state } = geminiStream(o.onEvent, o.model);
  const { code, stderr, aborted } = await runJsonl({
    cmd: config.gemini?.bin || 'gemini',
    args: buildGeminiArgs(o),
    cwd: o.cwd || os.homedir(),
    input: prompt,
    onJson,
    signal: o.signal,
  });
  if (aborted) state.error = 'Cancelado.';
  else if (code !== 0 && !state.text) state.error = state.error || shorten(stderr, 600) || `gemini saiu com código ${code}`;
  return {
    provider: 'gemini',
    model: state.model || o.model,
    text: state.text.trim(),
    sessionId: state.sessionId,
    error: state.text ? null : friendlyGeminiError(state.error),
    tokens: { ...state.tokens, costUsd: 0 },
  };
}

module.exports = { runGemini, buildGeminiArgs, geminiStream, statsTokens, friendlyGeminiError };
