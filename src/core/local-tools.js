// Ferramentas que rodam no modelo local (Ollama), sem gastar cota e sem o dado sair do PC:
// extração de dados de documentos, triagem de mensagens, leitura de documento por foto,
// anonimização antes de mandar para a nuvem, mensagem de commit/PR, diagnóstico de log
// e resumo prévio de reunião longa.
const { execFile } = require('child_process');
const llm = require('./local-llm');

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const tail = (s, n) => (s.length > n ? s.slice(-n) : s);
const str = { type: 'string' };
const arr = (items) => ({ type: 'array', items });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });

// ---------- 2. Extração de dados de documento ----------
const EXTRACT_SCHEMA = obj({
  tipo_documento: str,
  resumo: str,
  numero_processo: str,
  partes: arr(obj({ nome: str, papel: str, documento: str })),
  valores: arr(obj({ descricao: str, valor: str })),
  prazos: arr(obj({ descricao: str, data: str })),
  datas_importantes: arr(obj({ descricao: str, data: str })),
  obrigacoes: arr(str),
  observacoes: str,
});

const EXTRACT_SYSTEM = [
  'Você extrai dados de documentos jurídicos brasileiros (contratos, acordos, petições, sentenças, procurações, notificações).',
  'Copie nomes, números, valores e datas exatamente como aparecem no texto. Datas no formato DD/MM/AAAA. Valores com "R$".',
  'Campo que não existir no documento fica como texto vazio ou lista vazia. Nunca invente nem complete dado que não está escrito.',
  'Em "partes", "papel" é o papel no documento (autor, réu, contratante, contratado, devedor, credor, testemunha...) e "documento" é CPF/CNPJ/OAB se houver.',
].join('\n');

async function extractFields({ config, text, signal, ai = llm }) {
  if (!text?.trim()) throw new Error('Sem texto para extrair.');
  const max = Math.max(4000, (config.ollama?.contextTokens || 16384) * 2.5);
  const cut = text.length > max;
  const r = await ai.generate({ config, system: EXTRACT_SYSTEM, prompt: `Documento:\n${clip(text, max)}`, schema: EXTRACT_SCHEMA, temperature: 0, signal });
  return { ...r.data, _cortado: cut };
}

// ---------- 3. Triagem de mensagens ----------
const TRIAGE_SCHEMA = obj({
  itens: arr(obj({
    resumo: str,
    urgencia: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    area: str,
    cliente: str,
    prazo: str,
    acao_sugerida: str,
  })),
});

const TRIAGE_SYSTEM = [
  'Você faz a triagem do que chega a um escritório de advocacia: e-mails, mensagens, publicações e intimações.',
  'As mensagens vêm separadas por linhas com "---". Sem separador, é uma mensagem só. Devolva um item por mensagem, na mesma ordem.',
  'resumo: uma linha do que é. urgencia: alta (prazo processual, intimação, audiência ou prazo em até 5 dias), media (precisa de resposta nesta semana), baixa (informativo).',
  'area: trabalhista, cível, previdenciário, tributário, família, empresarial, consumidor, criminal, administrativo ou outro. cliente: nome do cliente ou da parte, se aparecer (senão vazio).',
  'prazo: data ou prazo citado (senão vazio). acao_sugerida: o próximo passo em poucas palavras. Não invente dados que não estão no texto.',
].join('\n');

const URG = { alta: 0, media: 1, baixa: 2 };

async function triage({ config, text, signal, ai = llm }) {
  if (!text?.trim()) throw new Error('Cole as mensagens para a triagem.');
  const r = await ai.generate({ config, system: TRIAGE_SYSTEM, prompt: clip(text, 40000), schema: TRIAGE_SCHEMA, temperature: 0, signal });
  const itens = (r.data.itens || []).map((it, i) => ({ ...it, ordem: i + 1 }));
  return { itens: itens.sort((a, b) => (URG[a.urgencia] ?? 3) - (URG[b.urgencia] ?? 3) || a.ordem - b.ordem) };
}

// ---------- 4. Documento por foto (modelo de visão) ----------
const PHOTO_SCHEMA = obj({
  tipo_documento: str,
  nome: str,
  cpf: str,
  rg: str,
  orgao_emissor: str,
  data_nascimento: str,
  filiacao: str,
  endereco: str,
  cep: str,
  outros: arr(obj({ campo: str, valor: str })),
  legivel: { type: 'boolean' },
});

const PHOTO_PROMPT = [
  'Esta é a foto ou digitalização de um documento brasileiro (RG, CNH, CPF, comprovante de residência, certidão, carteira de trabalho, contrato...).',
  'Leia e preencha os campos copiando exatamente o que está escrito. Datas em DD/MM/AAAA. Campo que não aparece fica vazio.',
  'Outros dados úteis vão em "outros". "legivel" é false se a imagem estiver ruim demais para ler com segurança. Não adivinhe dígitos que não dá para ler.',
].join('\n');

async function readPhoto({ config, image, signal, ai = llm }) {
  if (!image) throw new Error('Escolha a imagem do documento.');
  if (!llm.imageExt(image)) throw new Error('Use uma imagem PNG, JPG ou WEBP.');
  const r = await ai.generate({ config, prompt: PHOTO_PROMPT, images: [image], schema: PHOTO_SCHEMA, temperature: 0, signal, timeoutSec: 300 });
  return { ...r.data, _modelo: r.model };
}

// ---------- 5. Anonimização antes da nuvem ----------
// Ordem importa: processo e CNPJ antes do CPF, telefone por último.
const PATTERNS = [
  ['PROCESSO', /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g],
  ['CNPJ', /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g],
  ['CPF', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g],
  ['EMAIL', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
  ['CEP', /\b\d{5}-\d{3}\b/g],
  ['OAB', /\bOAB\s*\/?\s*[A-Z]{2}\s*(?:n[ºo°.]?\s*)?\d[\d.]*\b/gi],
  ['TELEFONE', /(?:\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g],
];

const NAMES_SCHEMA = obj({ pessoas: arr(str), enderecos: arr(str) });
const NAMES_SYSTEM = [
  'Liste os nomes de pessoas físicas e os endereços (rua, número, bairro) que aparecem no texto, copiados exatamente como estão escritos.',
  'Não liste nomes de empresas públicas conhecidas, tribunais, leis, cidades sozinhas nem cargos. Se não houver, devolva listas vazias.',
].join('\n');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Troca dados pessoais por marcadores ([PESSOA_1], [CPF_1]...). Devolve o texto e o mapa para desfazer.
 * Padrões fixos (CPF, CNPJ, e-mail...) sempre; nomes e endereços pelo modelo local, se `names` for true.
 */
async function anonymize({ config, text, names = true, keep = [], signal, ai = llm }) {
  const map = {};
  const reverse = new Map();
  const counters = {};
  const tag = (kind, value) => {
    const key = `${kind}:${value}`;
    if (reverse.has(key)) return reverse.get(key);
    counters[kind] = (counters[kind] || 0) + 1;
    const t = `[${kind}_${counters[kind]}]`;
    reverse.set(key, t);
    map[t] = value;
    return t;
  };
  let out = String(text || '');
  for (const [kind, re] of PATTERNS) out = out.replace(re, (m) => tag(kind, m));

  if (names && out.trim()) {
    const keepSet = new Set(keep.filter(Boolean).map((k) => k.toLowerCase()));
    const found = { PESSOA: new Set(), ENDERECO: new Set() };
    for (let i = 0; i < out.length; i += 8000) {
      try {
        const r = await ai.generate({ config, system: NAMES_SYSTEM, prompt: out.slice(i, i + 8000), schema: NAMES_SCHEMA, temperature: 0, signal });
        for (const n of r.data.pessoas || []) found.PESSOA.add(String(n).trim());
        for (const e of r.data.enderecos || []) found.ENDERECO.add(String(e).trim());
      } catch (e) {
        if (signal?.aborted) throw e;
        break; // sem modelo local: fica só com os padrões fixos
      }
    }
    for (const kind of ['ENDERECO', 'PESSOA']) {
      // Mais longo primeiro: "Maria da Silva" antes de "Maria". Só o que está mesmo no texto (o modelo pode inventar).
      const list = [...found[kind]].filter((v) => v.length >= 3 && !/^\[/.test(v) && !keepSet.has(v.toLowerCase()) && out.includes(v)).sort((a, b) => b.length - a.length);
      for (const v of list) out = out.replace(new RegExp(`(?<![\\w\\[])${escapeRe(v)}(?![\\w\\]])`, 'g'), () => tag(kind, v));
    }
  }
  return { text: out, map, count: Object.keys(map).length };
}

/** Desfaz a anonimização em texto ou em qualquer objeto (respostas JSON). */
function deanonymize(value, map) {
  if (!map || !Object.keys(map).length) return value;
  const re = new RegExp(Object.keys(map).map(escapeRe).join('|'), 'g');
  const fix = (v) => {
    if (typeof v === 'string') return v.replace(re, (t) => map[t]);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return fix(value);
}

// ---------- 7. Mensagem de commit e descrição de PR ----------
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

const COMMIT_SCHEMA = obj({ commit_titulo: str, commit_corpo: str, pr_titulo: str, pr_descricao: str });

function commitPrompt({ diff, status, log, branch, staged }) {
  return [
    `Branch: ${branch}. Mudanças ${staged ? 'preparadas (staged)' : 'ainda não preparadas'}.`,
    `Últimos commits do repositório (siga o mesmo estilo e idioma):\n${log || '(sem histórico)'}`,
    `Arquivos alterados:\n${status}`,
    `Diff:\n${diff}`,
  ].join('\n\n');
}

const COMMIT_SYSTEM = [
  'Você escreve a mensagem de commit e a descrição do pull request a partir de um diff git.',
  'commit_titulo: uma linha curta (até 72 caracteres) no estilo dos commits anteriores, dizendo o que muda para quem usa. commit_corpo: o porquê e os pontos principais, em poucas linhas (pode ficar vazio se o título bastar).',
  'pr_titulo: curto. pr_descricao: em Markdown, com "## O que muda", "## Como testar" (passos) e riscos se houver.',
  'Escreva em português do Brasil, a não ser que o histórico seja em outro idioma. Não invente mudanças que não estão no diff. Não inclua linhas de coautoria nem assinaturas.',
].join('\n');

async function commitMessage({ config, repo, signal, ai = llm, run = git }) {
  if (!repo) throw new Error('Escolha o repositório.');
  let staged = true;
  let diff = await run(repo, ['diff', '--staged', '--no-color', '-U2']);
  if (!diff.trim()) {
    staged = false;
    diff = await run(repo, ['diff', '--no-color', '-U2']);
  }
  if (!diff.trim()) throw new Error('Não há mudanças neste repositório (nem preparadas nem pendentes).');
  const [status, log, branch] = await Promise.all([
    run(repo, ['status', '--short']),
    run(repo, ['log', '--format=%s', '-12']).catch(() => ''),
    run(repo, ['branch', '--show-current']).catch(() => ''),
  ]);
  const max = Math.max(6000, (config.ollama?.contextTokens || 16384) * 2);
  const r = await ai.generate({
    config,
    system: COMMIT_SYSTEM,
    prompt: commitPrompt({ diff: clip(diff, max), status: clip(status, 3000), log: log.trim(), branch: branch.trim() || '(destacada)', staged }),
    schema: COMMIT_SCHEMA,
    temperature: 0.2,
    signal,
  });
  return { ...r.data, staged, cortado: diff.length > max };
}

// ---------- 8. Diagnóstico de log / erro ----------
const LOG_SCHEMA = obj({
  resumo: str,
  causa_provavel: str,
  solucao: arr(str),
  gravidade: { type: 'string', enum: ['baixa', 'media', 'alta'] },
  precisa_claude: { type: 'boolean' },
  motivo: str,
});

const LOG_SYSTEM = [
  'Você faz a primeira análise de um log ou mensagem de erro de software (Node, Python, Electron, React, Git, Windows, banco de dados).',
  'resumo: o que deu errado, em uma frase. causa_provavel: a causa mais provável, com base no que está no log. solucao: passos curtos e concretos.',
  'precisa_claude: true se resolver exige ler ou alterar o código do projeto, investigar várias partes ou se o log não basta para concluir; false se é algo simples (dependência faltando, porta em uso, permissão, variável de ambiente, comando errado).',
  'motivo: por que precisa ou não do Claude. Português do Brasil. Não invente nomes de arquivo nem comandos que não fazem sentido para o log.',
].join('\n');

async function diagnoseLog({ config, text, signal, ai = llm }) {
  if (!text?.trim()) throw new Error('Cole o log ou a mensagem de erro.');
  // O fim do log costuma ter o erro: guarda o começo (contexto) e, principalmente, o final.
  const t = text.length > 14000 ? `${text.slice(0, 2000)}\n[... trecho do meio omitido ...]\n${tail(text, 12000)}` : text;
  const r = await ai.generate({ config, system: LOG_SYSTEM, prompt: t, schema: LOG_SCHEMA, temperature: 0, signal });
  return r.data;
}

// ---------- 6. Resumo prévio de reunião longa ----------
const PRE_SYSTEM = [
  'Você condensa um trecho da transcrição de uma reunião de trabalho, sem perder informação útil.',
  'Mantenha quem falou cada coisa (o nome antes de dois pontos), todo pedido, tarefa, combinado, prazo, data, decisão, número, nome de cliente, sistema ou projeto.',
  'Corte cumprimentos, repetições, hesitações e conversa sem conteúdo. Escreva em linhas no formato "Nome: o que disse/pediu". Português do Brasil.',
].join('\n');

function splitLines(text, size) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) {
      parts.push(cur);
      cur = '';
    }
    cur += `${line}\n`;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Encolhe a transcrição no modelo local antes de mandar para o Claude. Se o Ollama falhar, devolve null
 * e quem chamou segue com o texto original (a análise nunca deixa de acontecer por causa disso).
 */
async function preSummarize({ config, text, chunkChars = 12000, signal, ai = llm }) {
  try {
    const parts = splitLines(text, chunkChars);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const r = await ai.generate({ config, system: PRE_SYSTEM, prompt: parts[i], temperature: 0, signal });
      out.push(`[Trecho ${i + 1} de ${parts.length}, condensado]\n${r.data}`);
    }
    const summary = out.join('\n\n');
    return summary.length < text.length ? summary : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

module.exports = {
  extractFields,
  triage,
  readPhoto,
  anonymize,
  deanonymize,
  commitMessage,
  commitPrompt,
  diagnoseLog,
  preSummarize,
  splitLines,
  PATTERNS,
};
