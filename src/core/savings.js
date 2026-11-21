// Economia do roteamento: quanto os pedidos teriam "custado" se tudo fosse para um modelo forte de referência,
// comparado com o que custou de fato nas IAs escolhidas. As assinaturas não cobram por token, então o valor é
// uma estimativa pelo preço de API de cada modelo: serve para comparar, não é o que sai do bolso.

// US$ por milhão de tokens (entrada, saída). Valores aproximados; ajuste em config.orchestration.prices.
const PRICES = {
  haiku: [1, 5],
  sonnet: [3, 15],
  opus: [5, 25],
  codex: [1.25, 10],
  'flash-lite': [0.1, 0.4],
  flash: [0.3, 2.5],
  pro: [1.25, 10],
  local: [0, 0],
};
const REFERENCE = 'sonnet';

// Acha o preço pelo nome do modelo ("claude-sonnet-4-5", "gemini-2.5-flash", "qwen2.5:7b"...).
function priceKey(provider, model) {
  if (provider === 'ollama' || provider === 'local') return 'local';
  if (provider === 'codex') return 'codex';
  const m = String(model || '').toLowerCase();
  if (provider === 'gemini') return m.includes('lite') ? 'flash-lite' : m.includes('flash') ? 'flash' : 'pro';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
}

function cost([pin, pout], input, output) {
  return (input * pin + output * pout) / 1e6;
}

/**
 * @param {object[]} days dias do UsageTracker.summary().days
 * @param {object} [o] { prices, reference }
 * @returns {{ actual:number, reference:number, saved:number, ratio:number, calls:number, byProvider:object }}
 */
function computeSavings(days, o = {}) {
  const prices = { ...PRICES, ...(o.prices || {}) };
  const ref = prices[o.reference] || prices[REFERENCE]; // referência desconhecida: usa a padrão
  let actual = 0;
  let reference = 0;
  let calls = 0;
  const byProvider = {};
  for (const day of days || []) {
    for (const [provider, p] of Object.entries(day)) {
      if (!p || typeof p !== 'object' || !p.byModel) continue;
      // Sem detalhe de entrada/saída por modelo: reparte os tokens do modelo na proporção do dia.
      const totalTok = (p.input || 0) + (p.cached || 0) + (p.output || 0);
      const outShare = totalTok ? (p.output || 0) / totalTok : 0.2;
      for (const [model, m] of Object.entries(p.byModel)) {
        const out = m.tokens * outShare;
        const inp = m.tokens - out;
        const a = cost(prices[priceKey(provider, model)] || prices.sonnet, inp, out);
        const r = cost(ref, inp, out);
        actual += a;
        reference += r;
        calls += m.calls || 0;
        const b = (byProvider[provider] ||= { calls: 0, tokens: 0, actual: 0 });
        b.calls += m.calls || 0;
        b.tokens += m.tokens || 0;
        b.actual += a;
      }
    }
  }
  const saved = Math.max(0, reference - actual);
  return { actual, reference, saved, ratio: reference ? saved / reference : 0, calls, byProvider };
}

module.exports = { computeSavings, priceKey, PRICES, REFERENCE };
