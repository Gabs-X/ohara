// Registro das IAs que a Ohara sabe usar. Cada uma descreve o que consegue fazer, quanto "custa"
// (quanto gasta da cota, numa escala relativa) e como instalar e logar. O roteador escolhe entre elas.
//
// cost: quanto gasta da cota (0 = grátis). q: qualidade esperada (0 a 10). Os dois são relativos e servem
// só para comparar as opções; dá para ajustar em config.providers.<id>.tiers.<nível>.
//
// Para acrescentar uma IA nova: crie o adaptador em providers/<id>.js (run(o) → { text, error, tokens, model })
// e acrescente uma entrada aqui. O resto da Ohara (roteador, cota, saúde) já passa a enxergar.

const PROVIDERS = {
  ollama: {
    id: 'ollama',
    label: 'IA local',
    vendor: 'Ollama (no seu PC)',
    caps: { tools: false, vision: false, web: false },
    // Custo zero: não tem cota. Fica só com o nível rápido (os modelos locais são menores).
    tiers: { rapido: { model: null, cost: 0, q: 3 } },
    quota: 'none',
    install: { kind: 'winget', command: 'winget install --id Ollama.Ollama -e', url: 'https://ollama.com/download' },
    login: null,
    help: 'Roda no seu PC, grátis e sem internet. Bom para conversa e perguntas rápidas; não mexe em arquivos.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    vendor: 'Google',
    bin: 'gemini',
    caps: { tools: true, vision: true, web: true },
    tiers: {
      rapido: { model: 'flash-lite', cost: 1, q: 4 },
      equilibrado: { model: 'flash', cost: 1.5, q: 6 },
      profundo: { model: 'pro', cost: 3, q: 8.5 },
    },
    // O CLI não informa a cota: a Ohara estima pelos pedidos feitos hoje.
    quota: 'estimated',
    install: { kind: 'npm', command: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
    login: { command: 'gemini', hint: 'Escolha "Login with Google" na primeira tela e feche a janela depois de logar.' },
    help: 'Tem camada grátis generosa com a conta Google. Bom para tarefas do dia a dia, pesquisa e código simples.',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI (ChatGPT)',
    bin: 'codex',
    caps: { tools: true, vision: true, web: true },
    tiers: {
      rapido: { model: null, effort: 'low', cost: 2, q: 6 },
      equilibrado: { model: null, effort: 'medium', cost: 3, q: 8 },
      profundo: { model: null, effort: 'high', cost: 4.5, q: 9.5 },
    },
    quota: 'real',
    install: { kind: 'npm', command: 'npm install -g @openai/codex', url: 'https://github.com/openai/codex' },
    login: { command: 'codex login', hint: 'Entre com a sua conta do ChatGPT no navegador que abrir.' },
    help: 'Usa a assinatura do ChatGPT. Muito bom em código.',
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    bin: 'claude',
    caps: { tools: true, vision: true, web: true },
    tiers: {
      rapido: { model: 'haiku', cost: 2, q: 6 },
      equilibrado: { model: 'sonnet', cost: 3.5, q: 8.5 },
      profundo: { model: 'opus', cost: 6, q: 10 },
    },
    quota: 'real',
    install: { kind: 'npm', command: 'npm install -g @anthropic-ai/claude-code', url: 'https://docs.claude.com/claude-code' },
    login: { command: 'claude', hint: 'Digite /login, entre com a sua conta e depois feche a janela.' },
    help: 'Usa a assinatura do Claude. O mais forte para planejar, escrever e projetos grandes.',
  },
};

const TIER_ORDER = ['rapido', 'equilibrado', 'profundo'];
const TIER_LABEL = { rapido: 'rápido', equilibrado: 'equilibrado', profundo: 'profundo' };

/** Configuração efetiva de uma IA: o padrão do registro com o que estiver em config.providers[id]. */
function providerSpec(id, config = {}) {
  const base = PROVIDERS[id];
  if (!base) return null;
  const user = config.providers?.[id] || {};
  const tiers = {};
  for (const [t, v] of Object.entries(base.tiers)) tiers[t] = { ...v, ...(user.tiers?.[t] || {}) };
  if (id === 'ollama') tiers.rapido.model = user.model || config.ollama?.model || 'qwen2.5:7b';
  return { ...base, tiers, enabled: user.enabled !== false, dailyRequests: user.dailyRequests ?? (id === 'gemini' ? 1000 : null) };
}

function allSpecs(config) {
  return Object.keys(PROVIDERS).map((id) => providerSpec(id, config));
}

/** Nome amigável do modelo de uma rota ("Claude Sonnet", "Gemini flash", "IA local"). */
function routeLabel(id, tier, model) {
  const p = PROVIDERS[id];
  if (!p) return id;
  if (id === 'ollama') return `IA local (${model || 'local'})`;
  if (id === 'codex') return `Codex (${TIER_LABEL[tier] || tier})`;
  const nice = String(model || '').replace(/^./, (c) => c.toUpperCase());
  return `${p.label} ${nice}`.trim();
}

/** Executa um pedido com ferramentas (ou conversa, no caso da IA local) na IA escolhida. */
async function runProvider(id, o) {
  switch (id) {
    case 'claude':
      return require('./claude').runClaude(o);
    case 'codex':
      return require('./codex').runCodex(o);
    case 'gemini':
      return require('./gemini').runGemini(o);
    case 'ollama':
      return require('./ollama').runOllama(o);
    default:
      throw new Error(`IA desconhecida: ${id}`);
  }
}

module.exports = { PROVIDERS, TIER_ORDER, TIER_LABEL, providerSpec, allSpecs, routeLabel, runProvider };
