// Chamada de IA "de uma vez" (sem ferramentas), usada pelas funções automáticas:
// reuniões, briefing, busca, cobranças, Slack. Respeita o orçamento de cota de cada função.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, shorten } = require('./providers/common');
const { resolveCodex } = require('./providers/codex');
const { claudeEnv, friendlyError } = require('./providers/claude');
const { anonymize, deanonymize } = require('./local-tools');

class DeferError extends Error {
  constructor(retryAt, reason) {
    super(reason);
    this.retryAt = retryAt;
    this.deferred = true;
  }
}

const util = (l) => (l ? Math.max(l.fiveHour ?? 0, l.weekly ?? 0) : 0);

/**
 * Decide o provedor de uma função conforme o orçamento.
 * Funções de segundo plano têm teto menor, para sobrar cota para você usar no chat.
 * @returns {{provider:'claude'|'codex'} | {defer:number, reason:string}}
 */
function pickProvider(feature, limits, config) {
  const f = config.features?.[feature] || {};
  if (f.provider === 'ollama' && config.ollama?.enabled !== false) return { provider: 'ollama' };
  // Codex desligado nos Ajustes: nem "Sempre Codex" nem a reserva por cota usam ele.
  const codexOn = config.codex?.enabled === true;
  if (f.provider === 'claude' || (f.provider === 'codex' && codexOn)) return { provider: f.provider };
  if (f.provider === 'codex' || f.provider === 'ollama') return { provider: 'claude' };

  const background = !!f.background;
  const b = config.budgets;
  const claudeMax = background ? b.backgroundClaude : config.quota.claudeAvoidAt;
  const codexMax = background ? b.backgroundCodex : config.quota.codexAvoidAt;
  const c = limits.claude;
  const x = codexOn ? limits.codex : { status: 'rejected' };

  if (c?.status !== 'rejected' && util(c) < claudeMax) return { provider: 'claude' };
  if (x?.status !== 'rejected' && util(x) < codexMax) return { provider: 'codex' };
  if (!background) return { provider: 'claude' }; // pedido seu: tenta mesmo assim

  // Adia até a primeira janela que renovar.
  const resets = [c?.fiveHourResetsAt, x?.fiveHourResetsAt].filter(Boolean).map((s) => s * 1000).filter((t) => t > Date.now());
  const retryAt = resets.length ? Math.min(...resets) + 60_000 : Date.now() + 30 * 60_000;
  const codexPart = codexOn ? `, Codex ${Math.round(util(x) * 100)}%` : '';
  return { defer: retryAt, reason: `cota acima do orçamento de segundo plano (Claude ${Math.round(util(c) * 100)}%${codexPart})` };
}

function tryJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(String(s).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
}

async function claudeOnce({ prompt, schema, model, effort, config, usage, signal }) {
  let out = null;
  let text = '';
  let u = {};
  let resolvedModel = model;
  let error = null;
  let cost = 0;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort,
    '--tools', '', '--no-session-persistence', '--disable-slash-commands'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const { code, stderr } = await runJsonl({
    cmd: config.claude.bin,
    args,
    env: claudeEnv(config),
    cwd: os.tmpdir(),
    input: prompt,
    signal,
    onJson: (ev) => {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) resolvedModel = ev.model;
      if (ev.type === 'rate_limit_event') usage.updateClaudeLimits(ev.rate_limit_info);
      if (ev.type === 'result') {
        u = ev.usage || {};
        cost = ev.total_cost_usd || 0;
        if (ev.is_error) error = ev.result || ev.subtype;
        text = ev.result || '';
        out = schema ? ev.structured_output || tryJson(ev.result) : text;
      }
    },
  });
  if (!out) throw new Error(friendlyError(error) || shorten(stderr, 300) || `claude saiu com código ${code}`);
  return {
    provider: 'claude',
    model: resolvedModel,
    data: out,
    tokens: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, costUsd: cost },
  };
}

async function codexOnce({ prompt, schema, effort, config, usage, signal }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-'));
  const outFile = path.join(tmp, 'saida.txt');
  const { cmd, pre } = resolveCodex(config);
  let u = {};
  try {
    const args = [...pre, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', tmp, '-o', outFile,
      '-c', `model_reasoning_effort="${effort === 'high' ? 'high' : effort === 'low' ? 'low' : 'medium'}"`];
    if (schema) {
      const schemaFile = path.join(tmp, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(schema));
      args.push('--output-schema', schemaFile);
    }
    if (config.codex.model) args.push('-m', config.codex.model);
    args.push('-');
    const { code, stderr } = await runJsonl({
      cmd, args, cwd: tmp, input: prompt, signal,
      onJson: (ev) => { if (ev.type === 'turn.completed') u = ev.usage || {}; },
    });
    const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    const data = schema ? tryJson(raw) : raw.trim();
    if (!data) throw new Error(shorten(stderr, 300) || `codex saiu com código ${code}`);
    usage.refreshCodexLimits();
    const cached = u.cached_input_tokens || 0;
    return {
      provider: 'codex',
      model: config.codex.model || 'padrão do Codex',
      data,
      tokens: { input: Math.max(0, (u.input_tokens || 0) - cached), cached, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// IA local (Ollama). Sem custo e sem cota: não entra na contagem de uso.
async function ollamaOnce({ prompt, schema, config, signal }) {
  const o = config.ollama || {};
  const timeout = AbortSignal.timeout((o.timeoutSec || 120) * 1000);
  const body = { model: o.model, stream: false, messages: [{ role: 'user', content: prompt }] };
  if (schema) body.format = schema;
  if (o.contextTokens) body.options = { num_ctx: o.contextTokens };
  let res;
  try {
    res = await fetch(`${o.url || 'http://127.0.0.1:11434'}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    throw new Error(`Ollama indisponível (${e.cause?.code || e.name})`);
  }
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${shorten(await res.text(), 200)}`);
  const j = await res.json();
  const raw = j.message?.content || '';
  const data = schema ? tryJson(raw) : raw.trim();
  if (!data) throw new Error('Ollama devolveu resposta vazia ou fora do formato');
  return { provider: 'ollama', model: o.model, data, tokens: { input: j.prompt_eval_count || 0, cached: 0, output: j.eval_count || 0, costUsd: 0 } };
}

/**
 * @param {object} o
 * @param {string} o.feature  chave em config.features (meetings, briefing, busca, cobranca, slack...)
 * @param {string} o.prompt
 * @param {object} [o.schema]  JSON Schema estrito; sem schema devolve texto
 * @param {object} o.config
 * @param {import('./usage').UsageTracker} o.usage
 */
async function askOnce(o) {
  const f = o.config.features?.[o.feature] || {};
  const choice = pickProvider(o.feature, o.usage.limits(), o.config);
  if (choice.defer) throw new DeferError(choice.defer, choice.reason);
  const model = o.config.claude.models[f.model] || f.model || o.config.claude.models.equilibrado;
  const effort = f.effort || 'medium';
  if (choice.provider === 'ollama') {
    try {
      return await ollamaOnce({ ...o, model, effort });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      // Ollama fora do ar ou resposta ruim: cai para o Claude, sem travar a função.
      const fallback = { ...f, provider: 'claude' };
      return askOnce({ ...o, config: { ...o.config, features: { ...o.config.features, [o.feature]: fallback } } });
    }
  }
  const run = choice.provider === 'codex' ? codexOnce : claudeOnce;
  // Privacidade: com a opção ligada, CPF, nomes, e-mails etc. viram marcadores antes de sair do PC
  // e voltam ao normal na resposta. Quem detecta os nomes é o modelo local.
  const priv = o.config.privacy || {};
  let prompt = o.prompt;
  let map = null;
  if (priv.anonymizeCloud) {
    const keep = [...(priv.keep || []), o.config.meetings?.selfName].filter(Boolean);
    const a = await anonymize({ config: o.config, text: o.prompt, names: priv.names !== false, keep, signal: o.signal });
    prompt = a.text;
    map = a.map;
  }
  const result = await run({ ...o, prompt, model, effort });
  if (map) {
    result.data = deanonymize(result.data, map);
    result.anonymized = Object.keys(map).length;
  }
  o.usage.record(result.provider, result.model, result.tokens, o.feature);
  return result;
}

module.exports = { askOnce, pickProvider, DeferError, tryJson };
