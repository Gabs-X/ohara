// Chat da Ohara-AI, no modelo local (Ollama). O modelo não guarda nada entre chamadas:
// "memória" aqui é o histórico da conversa + o índice de memória do Gabriel, mandados a cada pedido.
// Como não gasta cota, cada resposta passa por mais de uma chamada: decidir quem atende, escrever e revisar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOOL_DEFS, runPcTool, guessTools } = require('./pc-tools');

const MAX_HISTORY_CHARS = 14_000; // ~4 mil tokens de histórico; cabe folgado nos 16 mil do contexto
const MAX_MSG_CHARS = 2500;
const MAX_TOOL_ROUNDS = 4; // rodadas de ferramenta por resposta, para não ficar em laço
const MAX_TOOL_CHARS = 6000; // resultado de cada ferramenta que volta ao modelo

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
    'Você é a Ohara-AI, a IA local da Ohara, assistente pessoal do Gabriel rodando no PC dele (Windows 11). Responda sempre em português do Brasil, de forma direta.',
    'Você tem bom humor: é leve e às vezes solta uma piada curta, como uma amiga que manja muito. No máximo uma brincadeira por resposta, nunca quando ele estiver com problema sério ou pressa. Não faça referências a One Piece nem a animes.',
    'Seja assertiva: responda primeiro o que ele perguntou, tome posição quando ele pedir opinião, sem rodeios e sem pedir desculpas à toa.',
    'Aqui no chat você conversa (responde, explica, escreve, resume, planeja) e CONSULTA o PC dele com ferramentas só de leitura: armazenamento, sistema (CPU, RAM, bateria), processos, navegadores, programas instalados, rede e pastas.',
    'Quando ele perguntar algo do PC (espaço em disco, memória, o que está aberto, que navegador tem, o que ocupa a pasta Downloads...), chame a ferramenta certa e responda com os números que ela devolveu, em GB e de forma curta. Nunca chute números do PC sem consultar.',
    'Você NÃO altera nada: não apaga, não instala, não fecha programas, não roda comandos, não mexe em código e não navega na internet. Pedidos assim a Ohara manda para o Claude no Orca antes de chegarem a você. Se mesmo assim chegar um, nunca diga que encaminhou, que vai fazer ou que fez: diga em uma frase que isso fica com o Claude e que basta ele pedir "manda pro Claude". Pode sugerir o que ele mesmo pode fazer (ex.: quais pastas limpar).',
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

// Conversa em texto corrido, para as chamadas de decisão e revisão.
const transcript = (history, n, max) =>
  buildHistory(history)
    .slice(-n)
    .map((m) => `${m.role === 'user' ? 'Gabriel' : 'Ohara-AI'}: ${clip(m.content, max)}`)
    .join('\n');

// Uma chamada ao Ollama. Com onDelta, vai mostrando o texto enquanto chega.
async function ollamaChat({ config, messages, signal, onDelta, format, temperature }) {
  const o = config.ollama || {};
  const url = `${o.url || 'http://127.0.0.1:11434'}/api/chat`;
  const timeout = AbortSignal.timeout((o.timeoutSec || 180) * 1000);
  const options = { num_ctx: o.contextTokens || 16384 };
  if (temperature != null) options.temperature = temperature;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages, stream: true, options, ...(format ? { format } : {}) }),
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
  return { text: full.trim(), input: last.prompt_eval_count || 0, output: last.eval_count || 0 };
}

// Uma chamada ao Ollama sem streaming, oferecendo as ferramentas do PC.
async function ollamaToolCall({ config, messages, signal, tools }) {
  const o = config.ollama || {};
  const url = `${o.url || 'http://127.0.0.1:11434'}/api/chat`;
  const timeout = AbortSignal.timeout((o.timeoutSec || 180) * 1000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages, stream: false, ...(tools ? { tools } : {}), options: { num_ctx: o.contextTokens || 16384 } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    const err = new Error(`O modelo local não respondeu (${e.cause?.code || e.name}). Confira se o Ollama está aberto.`);
    err.fatal = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const missing = /not found/i.test(body);
    const err = new Error(missing ? `O modelo ${o.model} não está instalado no Ollama (rode: ollama pull ${o.model}).` : `Ollama respondeu ${res.status}: ${body.slice(0, 200)}`);
    err.fatal = missing;
    throw err;
  }
  const j = await res.json();
  return { message: j.message || {}, input: j.prompt_eval_count || 0, output: j.eval_count || 0 };
}

/**
 * Rascunho com ferramentas: o modelo pode pedir leituras do PC; a Ohara executa e devolve o resultado,
 * até ele escrever a resposta. Devolve também o que as ferramentas leram (a revisão precisa saber).
 * @param {object} o
 * @param {Function} [o.call] troca a chamada ao Ollama (testes)
 * @param {Function} [o.run] troca a execução das ferramentas (testes)
 */
async function draftWithTools({ config, messages, signal, onStep, prefetch = [], call = ollamaToolCall, run = runPcTool }) {
  const msgs = [...messages];
  const used = [];
  let input = 0;
  let output = 0;
  const exec = async (calls) => {
    msgs.push({ role: 'assistant', content: '', tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
    for (const c of calls) {
      onStep?.(`Ohara-AI: consultando o PC (${c.name})`);
      const content = clip(JSON.stringify(await run(c.name, c.args)), MAX_TOOL_CHARS);
      used.push({ name: c.name, args: c.args, content });
      msgs.push({ role: 'tool', tool_name: c.name, content });
    }
  };
  // Consulta óbvia pelo assunto: já entra como se o modelo tivesse pedido.
  if (prefetch.length) await exec(prefetch);
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Última rodada sem ferramentas: obriga a responder com o que já leu.
    const r = await call({ config, messages: msgs, signal, tools: round < MAX_TOOL_ROUNDS ? TOOL_DEFS : undefined });
    input += r.input;
    output += r.output;
    const calls = r.message.tool_calls || [];
    if (!calls.length) return { text: String(r.message.content || '').trim(), input, output, used };
    await exec(
      calls.map((c) => {
        let args = c.function?.arguments || {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return { name: c.function?.name, args };
      }),
    );
  }
  return { text: '', input, output, used };
}

const DECIDE_PROMPT = [
  'Você é o roteador da Ohara-AI, a assistente local do Gabriel. Leia a conversa e a última mensagem dele e decida quem atende.',
  '"conversar": a Ohara-AI responde sozinha. Serve para conversa, dúvidas, explicações, opiniões, textos, resumos e planos que não exigem mexer em nada.',
  'Também é "conversar" CONSULTAR o PC: a Ohara-AI tem ferramentas de leitura para armazenamento/espaço em disco, CPU, memória RAM, bateria, processos abertos, navegadores instalados e abertos, programas instalados, rede/Wi-Fi e tamanho e conteúdo de pastas. Ex.: "quanto tenho de armazenamento?", "o que está pesando no PC?", "quais navegadores eu tenho?", "o que ocupa a pasta Downloads?".',
  '"claude": precisa do Claude no Orca, que tem ferramentas de escrita. Serve para alterar código ou arquivos, apagar/instalar/fechar coisas, rodar comandos ou rotinas, pesquisar na web, usar sites no navegador (LinkedIn, Gmail...) ou ler o conteúdo de arquivos de projetos.',
  'Também é "claude" quando ele confirma ou manda seguir uma tarefa dessas já combinada na conversa ("pode seguir", "faz", "sim", "manda bala"), pede para encaminhar ao Claude ou ao Orca, ou reclama que isso não foi feito.',
  'Quando ele claramente quer que algo seja FEITO, e não só explicado, escolha "claude".',
  'Responda só com JSON: {"acao":"conversar" ou "claude","tarefa":"se for claude: a tarefa completa e autossuficiente em 1 a 3 frases, com projeto, arquivos citados e o resultado que ele quer; senão vazio"}',
].join('\n');

/**
 * Decide, lendo a conversa, se a mensagem fica na Ohara-AI ou vai para o Claude no Orca.
 * Nunca lança (exceto cancelamento): em erro devolve null e quem chamou segue com a regra fixa.
 * @returns {Promise<{acao:'conversar'|'claude', tarefa:string}|null>}
 */
async function decideLocal({ config, history, text, signal }) {
  try {
    const convo = transcript(history, 8, 900);
    const r = await ollamaChat({
      config,
      signal,
      format: 'json',
      temperature: 0,
      messages: [
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: `${convo ? `Conversa até aqui:\n${convo}\n\n` : ''}Última mensagem do Gabriel: ${text}` },
      ],
    });
    const j = JSON.parse(r.text);
    return { acao: j.acao === 'claude' ? 'claude' : 'conversar', tarefa: String(j.tarefa || '').trim() };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

const REVIEW_PROMPT = [
  'Você revisa a resposta que a Ohara-AI (assistente local do Gabriel) escreveu, antes de ele ver. Ache os problemas e reescreva.',
  '1. Promessa de ação: a Ohara-AI conversa e só LÊ informações do PC pelas ferramentas (o que ela leu está em "Dados lidos do PC"); dizer que consultou ou verificou isso é correto. Ela não executa comandos, não altera nem apaga arquivos, não navega e não encaminha nada sozinha. Toda frase que diga ou dê a entender que ela fez, está fazendo ou vai fazer algo assim é problema, inclusive no plural ("vou ajustar", "vamos ajustar", "encaminhei", "já mudei"). Se o pedido exigir isso, a resposta é uma frase dizendo que fica com o Claude e que basta ele pedir "manda pro Claude".',
  '2. Invenção: fato pessoal do Gabriel (nomes, datas, preferências, projetos) que não está na conversa nem na memória é invenção; troque por "não sei" e peça para ele contar. O mesmo para números, caminhos, arquivos e links sem base, ou usados fora do sentido original. Números e nomes que aparecem em "Dados lidos do PC" têm base: confira se batem com a resposta e corrija se não baterem.',
  '3. Em cima do muro: se ele pediu opinião ou escolha, a resposta tem que escolher um lado logo na primeira frase e dar o motivo principal. "Depende" ou "escolha de acordo com suas necessidades" é problema.',
  '4. Enrolação: conselhos, avisos e frases genéricas que ele não pediu, e desculpas à toa.',
  'Mantenha o tom, o bom humor e o português do Brasil. Se não houver problema, devolva a resposta igual.',
  'Responda só com JSON: {"problemas":["cada problema achado, curto"],"resposta":"a resposta final, pronta para ele ler","melhoria":true se a oferta de melhoria proposta for mesmo sobre um recurso que falta na Ohara e a resposta oferecer isso, senão false}',
].join('\n');

const MARK_RE = /\n?\[\[[^\]]+\]\]\s*/g;
const IMPROVE_MARK_RE = /\[\[melhoria:[^\]]+\]\]/i;

/**
 * Resposta da Ohara-AI: escreve um rascunho e revisa antes de mostrar (o modelo local não gasta cota,
 * então vale a passada extra para não prometer o que não fez nem inventar).
 * @param {object} o
 * @param {object} o.config
 * @param {{role:string,text:string}[]} o.history mensagens anteriores (sem a atual)
 * @param {string} o.text pedido atual
 * @param {string} [o.project]
 * @param {AbortSignal} [o.signal]
 * @param {(chunk:string)=>void} [o.onDelta]
 * @param {(text:string)=>void} [o.onStep] etapa em andamento, para a tela
 */
async function chatLocal({ config, history, text, project, signal, onDelta, onStep }) {
  const o = config.ollama || {};
  const messages = [{ role: 'system', content: systemPrompt(config, { project }) }, ...buildHistory(history), { role: 'user', content: text }];
  // Blocos estruturados (WhatsApp, [[ignorar]]) não passam pela revisão: ela poderia estragar o formato.
  const review = o.review !== false;
  let draft = null;
  // Com ferramentas do PC (padrão): o modelo pode consultar o PC antes de escrever. Se a chamada com
  // ferramentas falhar por outro motivo (modelo sem suporte, resposta estranha), segue no chat comum.
  if (o.tools !== false) {
    try {
      draft = await draftWithTools({ config, messages, signal, onStep, prefetch: guessTools(text) });
      if (!draft.text) draft = null;
      else if (!review) onDelta?.(draft.text);
    } catch (e) {
      if (signal?.aborted || e.fatal) throw e;
      console.error('Ferramentas da Ohara-AI falharam:', e.message);
      draft = null;
    }
  }
  if (!draft) draft = await ollamaChat({ config, messages, signal, onDelta: review ? null : onDelta });
  const pcData = (draft.used || []).map((u) => `- ${u.name}(${JSON.stringify(u.args)}): ${clip(u.content, 2500)}`).join('\n');
  let final = draft;
  if (review && draft.text && !/\[\[(whatsapp|ignorar)/i.test(draft.text)) {
    onStep?.('Ohara-AI: revisando a resposta');
    const offer = draft.text.match(IMPROVE_MARK_RE)?.[0] || null; // [[melhoria: ...]] só volta se a revisão confirmar
    const body = draft.text.replace(MARK_RE, '\n').trim();
    const mem = readMemory(config);
    try {
      const r = await ollamaChat({
        config,
        signal,
        format: 'json',
        temperature: 0,
        messages: [
          { role: 'system', content: REVIEW_PROMPT },
          {
            role: 'user',
            content: [
              mem ? `Memória sobre o Gabriel (o que é sabido de fato):\n${mem}\n` : 'Memória sobre o Gabriel: (vazia)\n',
              `Conversa até aqui:\n${transcript(history, 6, 700) || '(início)'}\n`,
              `Pedido atual do Gabriel: ${text}\n`,
              pcData ? `Dados lidos do PC agora pelas ferramentas:\n${pcData}\n` : '',
              `Resposta a revisar:\n${body}`,
              offer ? `\nOferta de melhoria proposta: ${offer}` : '',
            ].join('\n'),
          },
        ],
      });
      const j = JSON.parse(r.text);
      const fixed = String(j.resposta || '').replace(MARK_RE, '\n').trim();
      if (fixed) final = { text: [fixed, offer && j.melhoria === true ? offer : ''].filter(Boolean).join('\n'), input: draft.input + r.input, output: draft.output + r.output };
      onDelta?.(fixed || draft.text);
    } catch (e) {
      if (signal?.aborted) throw e;
      onDelta?.(draft.text); // revisão falhou: fica o rascunho
    }
  } else if (review) {
    onDelta?.(draft.text);
  }
  return {
    provider: 'ollama',
    model: o.model,
    text: final.text,
    tokens: { input: final.input, cached: 0, output: final.output, costUsd: 0 },
  };
}

module.exports = { chatLocal, decideLocal, buildHistory, systemPrompt, readMemory, draftWithTools };
