// Roteador com várias IAs (edição Guia). Para cada pedido:
// 1. classifica o tipo (pergunta rápida, código, planejamento...) com a mesma heurística local do roteador
//    principal, sem gastar token;
// 2. traduz o tipo numa necessidade (nível do modelo, se precisa de ferramentas ou de ver imagem);
// 3. dá uma nota para cada IA disponível juntando custo, qualidade e quanto da cota ela já gastou;
// 4. fica com a melhor e guarda as outras como reserva, caso a escolhida falhe ou esteja sem cota.
const { classify, CATEGORIES } = require('./router');
const { allSpecs, providerSpec, routeLabel, TIER_ORDER, TIER_LABEL } = require('./providers/registry');

// O que cada tipo de pedido precisa.
const NEEDS = {
  rapida: { tier: 'rapido', tools: false },
  geral: { tier: 'equilibrado', tools: false },
  sistema: { tier: 'equilibrado', tools: true },
  codigo: { tier: 'equilibrado', tools: true },
  codigo_complexo: { tier: 'profundo', tools: true },
  pesquisa: { tier: 'equilibrado', tools: true },
  escrita: { tier: 'equilibrado', tools: false },
  raciocinio: { tier: 'profundo', tools: false },
  visao: { tier: 'equilibrado', tools: false, vision: true },
  planejamento: { tier: 'profundo', tools: false },
};
const EXTRA_LABELS = { planejamento: 'Planejamento' };

// Peso do custo contra a qualidade em cada modo (o resto é qualidade).
const MODES = { economia: 0.8, equilibrio: 0.5, qualidade: 0.15 };

const DEFAULTS = {
  mode: 'economia',
  downgradeAt: 0.7, // acima disso, o nível profundo dessa IA vira equilibrado
  avoidAt: 0.85, // acima disso, essa IA só é usada se nenhuma outra servir
  blockAt: 0.98, // a partir daqui, considera a cota esgotada
  localFor: ['rapida'], // tipos que podem ficar na IA local (sem ferramentas)
};

// daily: estimativa pelos pedidos do dia (IAs que não informam a cota, como o Gemini).
const util = (l) => (l ? Math.max(l.fiveHour ?? 0, l.weekly ?? 0, l.daily ?? 0) : 0);
const pct = (x) => `${Math.round(x * 100)}%`;

function settings(config) {
  return { ...DEFAULTS, ...(config.orchestration || {}) };
}

// Nível pedido ou o mais próximo que a IA tiver (primeiro para baixo, depois para cima).
function nearestTier(spec, want) {
  if (spec.tiers[want]) return want;
  const i = TIER_ORDER.indexOf(want);
  for (let d = 1; d < TIER_ORDER.length; d++) {
    if (spec.tiers[TIER_ORDER[i - d]]) return TIER_ORDER[i - d];
    if (spec.tiers[TIER_ORDER[i + d]]) return TIER_ORDER[i + d];
  }
  return null;
}

function target(spec, tier, config) {
  const t = spec.tiers[tier];
  const model = spec.id === 'codex' ? config.codex?.model || 'padrão' : t.model;
  const effort = t.effort || (tier === 'profundo' ? 'high' : tier === 'rapido' ? 'low' : 'medium');
  return { provider: spec.id, tier, model, effort, modelLabel: routeLabel(spec.id, tier, model) };
}

/**
 * Avalia cada IA para uma necessidade. Devolve as candidatas ordenadas (melhor primeiro) e,
 * para as descartadas, o motivo.
 */
function rank(need, { config, limits = {}, available, category, learned = {} }) {
  const s = settings(config);
  const alpha = MODES[s.mode] ?? MODES.economia;
  const prefer = s.prefer?.[category] || learned[category] || null;
  const out = [];
  const skipped = [];
  for (const spec of allSpecs(config)) {
    if (!spec.enabled) continue;
    if (available && !available.has(spec.id)) continue;
    if (need.tools && !spec.caps.tools) { skipped.push(`${spec.label}: não mexe em arquivos`); continue; }
    if (need.vision && !spec.caps.vision) { skipped.push(`${spec.label}: não vê imagens`); continue; }
    if (spec.id === 'ollama' && !(s.localFor || []).includes(category) && need.tier !== 'rapido') continue;
    let tier = nearestTier(spec, need.tier);
    if (!tier) continue;
    const u = util(limits[spec.id]);
    if (limits[spec.id]?.status === 'rejected' || u >= s.blockAt) { skipped.push(`${spec.label}: cota esgotada`); continue; }
    const notes = [];
    if (tier === 'profundo' && u >= s.downgradeAt && spec.tiers.equilibrado) {
      tier = 'equilibrado';
      notes.push(`${spec.label} em ${pct(u)} da cota: nível profundo trocado por equilibrado`);
    }
    const t = spec.tiers[tier];
    // Quem já gastou mais da cota fica mais "caro": a Ohara reparte o trabalho entre as assinaturas.
    let score = alpha * t.cost * (1 + u) - (1 - alpha) * t.q;
    if (u >= s.avoidAt) { score += 100; notes.push(`${spec.label} em ${pct(u)} da cota: só se não houver outra`); }
    if (prefer && prefer === spec.id) { score -= 2; notes.push(`você prefere ${spec.label} para isso`); }
    out.push({ ...target(spec, tier, config), score, util: u, notes });
  }
  out.sort((a, b) => a.score - b.score);
  return { candidates: out, skipped };
}

/**
 * Decide a rota de um pedido.
 * @param {string} prompt
 * @param {object} o
 * @param {object} o.config
 * @param {object} [o.limits] uso de cota por IA ({ claude: { fiveHour, weekly, status }, ... })
 * @param {Set<string>} [o.available] IAs instaladas e logadas (sem isso, considera todas)
 * @param {boolean} [o.hasImage]
 * @param {string} [o.override] 'auto' ou 'ia:nível' (ex.: 'claude:profundo')
 * @param {string} [o.category] força o tipo (ex.: 'planejamento')
 * @param {boolean} [o.needsTools] força precisar de ferramentas (ex.: conversa dentro de um projeto)
 */
function routeMulti(prompt, o = {}) {
  const { config, limits = {}, available, hasImage = false, override = 'auto' } = o;
  const reasons = [];

  if (override && override !== 'auto') {
    const [id, tierWanted] = override.split(':');
    const spec = providerSpec(id, config);
    if (spec && spec.enabled && (!available || available.has(id))) {
      const tier = nearestTier(spec, tierWanted || 'equilibrado');
      const t = target(spec, tier, config);
      return { ...t, category: 'manual', label: 'Escolha manual', reasons: ['escolhido por você'], fallbacks: [] };
    }
    reasons.push(`${spec?.label || id} não está disponível: escolha automática`);
  }

  const c = o.category ? { category: o.category } : classify(prompt, { hasImage, projects: o.projects, previous: o.previous });
  const category = c.category;
  const need = { ...(NEEDS[category] || NEEDS.geral) };
  if (o.needsTools && !need.tools && category !== 'rapida' && category !== 'planejamento') need.tools = true;
  const label = CATEGORIES[category]?.label || EXTRA_LABELS[category] || category;
  reasons.push(`tipo: ${label} (pede nível ${TIER_LABEL[need.tier]}${need.tools ? ', com ferramentas' : ''})`);
  if (c.continued) reasons.push('continua o assunto da conversa');

  let { candidates, skipped } = rank(need, { config, limits, available, category, learned: o.learned });
  // Nada serve com ferramentas: melhor responder sem ferramentas do que não responder.
  if (!candidates.length && need.tools) {
    ({ candidates } = rank({ ...need, tools: false }, { config, limits, available, category: 'rapida', learned: o.learned }));
    if (candidates.length) reasons.push('nenhuma IA com ferramentas disponível: responde só com texto');
  }
  if (!candidates.length) {
    return { provider: null, category, label, reasons: [...reasons, ...skipped, 'nenhuma IA disponível'], fallbacks: [], error: 'Nenhuma IA está pronta para uso. Abra "Primeiros passos" para instalar ou logar uma.' };
  }
  const [best, ...rest] = candidates;
  reasons.push(...best.notes);
  const runnerUp = rest[0];
  reasons.push(runnerUp
    ? `escolhida: ${best.modelLabel} (melhor custo-benefício agora; reserva: ${runnerUp.modelLabel})`
    : `escolhida: ${best.modelLabel} (única disponível)`);
  if (skipped.length) reasons.push(`fora: ${skipped.join('; ')}`);
  const strip = ({ score, notes, util: _u, ...t }) => t;
  return { ...strip(best), category, label, reasons, project: c.project, fallbacks: rest.map(strip) };
}

module.exports = { routeMulti, rank, NEEDS, MODES, nearestTier, settings };
