// Briefing da tarefa que vai ao Claude no Orca (prompt e validação). Sem dependências: serve ao modelo
// local e ao Claude (plano B), e os testes usam o de verdade. A Ohara analisa a conversa em vez de colar a frase dele.
const BRIEF_PROMPT = [
  'Você prepara a tarefa que a Ohara (assistente pessoal do Gabriel) vai entregar ao Claude Code, que abre num projeto com acesso ao código.',
  'Leia a conversa e a última mensagem dele e vá a fundo: qual é a intenção real, qual é o problema, o que já foi dito, combinado ou tentado, e o que deu errado.',
  'Não copie a frase dele: reescreva como um pedido claro, completo e autossuficiente para um engenheiro que não viu a conversa. Não invente fatos que não estão na conversa.',
  'Se a mensagem for vaga ou um desabafo ("abre o orca pra eu falar da sua burrice"), descubra pela conversa o que ele quer resolver e escreva isso.',
  'Responda só com JSON: {"titulo":"3 a 6 palavras sobre o assunto","branch":"tipo/slug — tipo é feat, fix, chore, docs ou refactor; slug sobre o ASSUNTO, minúsculas, sem acento, palavras separadas por hífen, até 40 caracteres","projeto":"nome exato de um dos projetos conhecidos quando o assunto é claramente dele (se o assunto é a própria Ohara — você, sua, ela — use o projeto da Ohara); senão vazio","objetivo":"1 a 2 frases com o resultado que ele quer","contexto":"2 a 5 frases: o que aconteceu na conversa, o que deu errado e o que já foi tentado","criterios":["o que precisa estar verdade quando terminar"],"duvidas":["o que o Claude deve confirmar com ele antes de mexer, se houver"]}',
].join('\n');

const BRANCH_TYPES = new Set(['feat', 'fix', 'chore', 'docs', 'refactor']);
const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

/**
 * Valida o briefing (JSON do modelo) e acerta branch e projeto. null se não servir.
 * @param {string} raw texto com o JSON (pode vir com texto em volta, quando é o Claude)
 * @param {{name:string,path:string}[]} projects
 */
function parseBrief(raw, projects = []) {
  let j;
  try {
    const s = String(raw || '');
    j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const titulo = String(j.titulo || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const objetivo = String(j.objetivo || '').trim();
  if (!titulo || !objetivo) return null;
  let [type, ...rest] = String(j.branch || '').trim().toLowerCase().split('/');
  let slug = slugify(rest.join('-'));
  if (!BRANCH_TYPES.has(type) || slug.length < 3) {
    type = BRANCH_TYPES.has(type) ? type : 'feat';
    slug = slugify(titulo);
  }
  const want = slugify(j.projeto);
  const project = want ? projects.find((p) => slugify(p.name) === want) || null : null;
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : []);
  return {
    titulo,
    branch: slug.length >= 3 ? `${type}/${slug}` : null,
    projeto: project ? project.name : '',
    projectPath: project ? project.path : null,
    objetivo,
    contexto: String(j.contexto || '').trim(),
    criterios: list(j.criterios),
    duvidas: list(j.duvidas),
  };
}

// Entrada do briefing: projetos conhecidos, conversa e a última mensagem.
function briefInput({ convo = '', text, projects = [], hint = '' }) {
  const names = projects.map((p) => `${p.name}${p.self ? ' (projeto da Ohara)' : ''}`).join(', ');
  return [
    names ? `Projetos conhecidos: ${names}` : '',
    convo ? `Conversa até aqui:\n${convo}` : '',
    hint ? `Resumo da Ohara-AI: ${hint}` : '',
    `Última mensagem do Gabriel: ${text}`,
  ].filter(Boolean).join('\n\n');
}

module.exports = { BRIEF_PROMPT, parseBrief, briefInput, slugify };
