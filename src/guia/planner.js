// Planejador (edição Guia): a ideia vira um plano com objetivo, etapas, riscos e perguntas em aberto.
// O plano é feito uma vez num modelo forte; cada etapa é executada depois, uma de cada vez, pelo modelo mais
// barato que resolve aquele tipo de etapa. É onde a orquestração mais economiza.
const crypto = require('crypto');

const STEP_TYPES = ['codigo', 'texto', 'pesquisa', 'decisao', 'tarefa'];
const SIZES = ['pequena', 'media', 'grande'];

// Tipo de etapa → tipo de pedido do roteador.
function stepCategory(step) {
  switch (step.type) {
    case 'codigo': return step.size === 'grande' ? 'codigo_complexo' : 'codigo';
    case 'texto': return 'escrita';
    case 'pesquisa': return 'pesquisa';
    case 'decisao': return 'raciocinio';
    default: return 'sistema';
  }
}

function planPrompt({ idea, feedback, previous, cwd }) {
  return [
    'Você é um planejador experiente ajudando uma pessoa que NÃO é programadora a tirar uma ideia do papel.',
    'Transforme a ideia num plano prático. NÃO execute nada, NÃO crie nem altere arquivos: só planeje.',
    cwd ? `A ideia é para a pasta ${cwd}. Se ajudar, você pode só LER os arquivos dela para entender o que já existe.` : '',
    '',
    'Regras do plano:',
    '- De 3 a 10 etapas, na ordem em que devem ser feitas. Cada etapa precisa ser pequena o bastante para uma IA fazer de uma vez e a pessoa conferir.',
    '- Títulos curtos. Descrições em linguagem simples, sem jargão (se precisar de um termo técnico, explique entre parênteses).',
    '- "tipo" de cada etapa: codigo (criar ou mudar programa, site, planilha com fórmulas), texto (escrever conteúdo), pesquisa (buscar informação na internet), decisao (algo que a pessoa precisa decidir ou comparar), tarefa (mexer em arquivos ou no computador).',
    '- "tamanho": pequena, media ou grande.',
    '- "criterio": como a pessoa confere que a etapa ficou pronta (algo que ela consegue ver ou testar).',
    '- "riscos": o que pode dar errado e como evitar. "perguntas": o que falta a pessoa decidir antes ou durante.',
    '- Prefira o caminho mais simples que resolve. Se a ideia não precisar de programação, o plano não deve ter programação.',
    '',
    'Responda APENAS com um JSON neste formato, sem nada antes ou depois:',
    '{"titulo":"…","objetivo":"uma frase","resumo":"2 ou 3 frases","etapas":[{"titulo":"…","descricao":"…","tipo":"codigo","tamanho":"media","criterio":"…"}],"riscos":["…"],"perguntas":["…"]}',
    '',
    previous ? `Plano atual (revise mantendo as etapas já feitas, marcadas com [feito]):\n${previous}\n` : '',
    feedback ? `Pedido de ajuste da pessoa: ${feedback}\n` : '',
    `Ideia: ${idea}`,
  ].filter((l) => l !== '').join('\n');
}

// Acha o JSON na resposta (com ou sem ```json, com texto em volta).
function extractJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* tenta o próximo */ }
  }
  return null;
}

const str = (v, max = 600) => String(v ?? '').trim().slice(0, max);

/** Valida e normaliza o plano devolvido pela IA. Lança erro se não der para aproveitar. */
function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('A IA não devolveu um plano no formato esperado.');
  const steps = (Array.isArray(raw.etapas) ? raw.etapas : []).slice(0, 15).map((e) => ({
    id: crypto.randomUUID(),
    title: str(e.titulo || e.title, 120) || 'Etapa',
    description: str(e.descricao || e.description, 1200),
    type: STEP_TYPES.includes(e.tipo) ? e.tipo : 'tarefa',
    size: SIZES.includes(e.tamanho) ? e.tamanho : 'media',
    criteria: str(e.criterio || e.criteria, 400),
    status: 'pendente',
  }));
  if (!steps.length) throw new Error('O plano veio sem etapas. Tente descrever a ideia com mais detalhes.');
  return {
    title: str(raw.titulo || raw.title, 120) || 'Plano',
    objective: str(raw.objetivo, 300),
    summary: str(raw.resumo, 800),
    steps,
    risks: (Array.isArray(raw.riscos) ? raw.riscos : []).map((r) => str(r, 300)).filter(Boolean).slice(0, 8),
    questions: (Array.isArray(raw.perguntas) ? raw.perguntas : []).map((r) => str(r, 300)).filter(Boolean).slice(0, 8),
  };
}

function planAsText(plan) {
  return plan.steps.map((s, i) => `${i + 1}. ${s.status === 'feito' ? '[feito] ' : ''}${s.title}: ${s.description}`).join('\n');
}

/** Pedido para executar uma etapa: leva o plano inteiro como contexto, mas pede só a etapa. */
function stepPrompt(plan, step) {
  const idx = plan.steps.indexOf(step);
  const done = plan.steps.filter((s) => s.status === 'feito').map((s) => `- ${s.title}`).join('\n');
  return [
    `Estamos seguindo o plano "${plan.title}"${plan.objective ? ` (objetivo: ${plan.objective})` : ''}.`,
    done ? `Etapas já feitas:\n${done}` : 'Esta é a primeira etapa feita.',
    '',
    `Faça AGORA só a etapa ${idx + 1} de ${plan.steps.length}: **${step.title}**`,
    step.description,
    step.criteria ? `Está pronta quando: ${step.criteria}` : '',
    '',
    'Não adiante as próximas etapas. Se faltar uma decisão para continuar, pergunte antes de fazer.',
    'No fim, diga como conferir que ficou pronto.',
  ].filter(Boolean).join('\n');
}

class Planner {
  /**
   * @param {object} o
   * @param {import('../core/store').JsonStore} o.store  { plans: [] }
   * @param {(o:{prompt:string, cwd:string, category:string, signal?:AbortSignal})=>Promise<{text:string, error?:string, provider:string, model:string}>} o.ask
   */
  constructor({ store, ask }) {
    this.store = store;
    this.ask = ask;
    if (!this.store.data.plans) this.store.data.plans = [];
  }

  list() {
    return this.store.data.plans
      .map((p) => ({ id: p.id, title: p.title, cwd: p.cwd, updatedAt: p.updatedAt, total: p.steps.length, done: p.steps.filter((s) => s.status === 'feito').length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.store.data.plans.find((p) => p.id === id) || null;
  }

  async #make({ idea, cwd, feedback, previous }) {
    const r = await this.ask({ prompt: planPrompt({ idea, cwd, feedback, previous }), cwd, category: 'planejamento' });
    if (r.error && !r.text) throw new Error(r.error);
    const json = extractJson(r.text);
    if (!json) throw new Error('A IA respondeu, mas não no formato de plano. Tente de novo.');
    return { ...normalizePlan(json), madeBy: r.model || r.provider };
  }

  async create({ idea, cwd = null }) {
    if (!String(idea || '').trim()) throw new Error('Descreva a ideia primeiro.');
    const made = await this.#make({ idea, cwd });
    const plan = { id: crypto.randomUUID(), idea: str(idea, 4000), cwd, createdAt: Date.now(), updatedAt: Date.now(), chatId: null, ...made };
    this.store.data.plans.push(plan);
    this.store.save();
    return plan;
  }

  /** Refaz o plano com um pedido de ajuste, mantendo as etapas já feitas. */
  async revise(id, feedback) {
    const plan = this.get(id);
    if (!plan) throw new Error('Plano não encontrado.');
    const made = await this.#make({ idea: plan.idea, cwd: plan.cwd, feedback, previous: planAsText(plan) });
    const done = plan.steps.filter((s) => s.status === 'feito');
    const doneTitles = new Set(done.map((s) => s.title.toLowerCase()));
    Object.assign(plan, made, { steps: [...done, ...made.steps.filter((s) => !doneTitles.has(s.title.toLowerCase()))], updatedAt: Date.now() });
    this.store.save();
    return plan;
  }

  setStep(id, stepId, patch) {
    const plan = this.get(id);
    const step = plan?.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('Etapa não encontrada.');
    if (patch.status && ['pendente', 'feito', 'pulado'].includes(patch.status)) step.status = patch.status;
    if (patch.chatId) plan.chatId = patch.chatId;
    if (patch.runAt) step.runAt = patch.runAt;
    plan.updatedAt = Date.now();
    this.store.save();
    return plan;
  }

  linkChat(id, chatId) {
    const plan = this.get(id);
    if (plan) { plan.chatId = chatId; this.store.save(); }
  }

  remove(id) {
    this.store.data.plans = this.store.data.plans.filter((p) => p.id !== id);
    this.store.save();
  }
}

module.exports = { Planner, normalizePlan, extractJson, stepPrompt, stepCategory, planPrompt };
