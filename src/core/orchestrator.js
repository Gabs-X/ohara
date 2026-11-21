// Orquestrador: recebe um pedido, escolhe a rota, chama o provedor e
// mantém o contexto quando a conversa alterna entre Claude e Codex.
const crypto = require('crypto');
const fs = require('fs');
const { route, classify, findProject, learnPreferences, normalize } = require('./router');
const os = require('os');
const { chatLocal, decideLocal, briefLocal } = require('./local-chat');
const { BRIEF_PROMPT, parseBrief, briefInput } = require('./brief');
const { runClaude, buildChatArgs } = require('./providers/claude');
const { anonymize, deanonymize } = require('./local-tools');
const { sendToOrca } = require('../integrations/orca');
const path = require('path');
const { listRepos } = require('./system');
const { asksPcInfo } = require('./pc-tools');
const { wantsWhatsApp, extractDrafts, parseSendReply } = require('../integrations/whatsapp');
const { parseQuickAction, runQuickAction } = require('./quick-actions');
const { wantsBrowser, needsBrowser, chromeNote, chromeIssueNote, findChrome, CODEX_BROWSER_NOTE } = require('../integrations/chrome');

const WHATSAPP_NOTE = [
  'O pedido envolve WhatsApp. Não tente enviar nada você mesmo: a Ohara cuida do envio.',
  '- Se o destino é o próprio Gabriel ("me manda", "pra mim", "me avisa"): faça o que foi pedido e escreva a resposta final já como a mensagem (curta, sem tabelas); a Ohara envia para o WhatsApp dele.',
  '- Se o destino é outra pessoa: escreva a mensagem como se fosse o Gabriel escrevendo (primeira pessoa, no tom dele) e coloque no fim da resposta exatamente:',
  '[[whatsapp para="Nome do contato como ele falou, ou número com DDI"]]',
  'texto da mensagem',
  '[[/whatsapp]]',
  'Fora do bloco, diga em uma frase curta o que vai mandar. A Ohara procura o contato e envia, e acrescenta à sua resposta se deu certo; não diga que já enviou.',
].join('\n');

// Sempre que o envio para contatos está disponível: ela precisa saber que pode, mesmo quando o pedido não cita "WhatsApp".
const CONTACTS_NOTE = (confirm) => [
  'Você consegue mandar mensagens de WhatsApp para os contatos do Gabriel, pelo WhatsApp Web dele.',
  'Quando ele pedir para mandar, enviar, avisar ou falar algo para alguém (mesmo sem dizer "WhatsApp", ex.: "manda pra vó que eu chego tarde", "envia a mensagem"),',
  'escreva a mensagem como se fosse o Gabriel (primeira pessoa, no tom dele; se ele pedir que você se apresente, fale como a Ohara, assistente dele) e coloque no fim da resposta exatamente:',
  '[[whatsapp para="nome do contato do jeito que ele falou"]]',
  'texto da mensagem',
  '[[/whatsapp]]',
  'Não peça o nome completo: a Ohara procura o contato pelo nome mesmo parcial, apelido ou mal transcrito, e só pergunta se houver mais de um parecido.',
  confirm
    ? 'A Ohara procura o contato, mostra a ele o nome exato que achou e só envia quando ele confirmar ("confirmado", "sim" ou o botão Enviar). Não diga que já enviou. Se ele corrigir o contato, repita o bloco com o nome novo.'
    : 'A Ohara ENVIA NA HORA: não peça confirmação, não diga que precisa de botão e não pergunte "tem certeza". Ele já pediu.',
  'Se ele disser "envia a mensagem" sobre uma mensagem que você já preparou nesta conversa, repita o bloco com o mesmo texto.',
].join('\n');

const VOICE_NOTE = [
  'Este pedido veio por voz e a sua resposta será lida em voz alta. Responda como numa conversa falada: curto (1 a 3 frases), direto, sem markdown, listas, tabelas, links ou emojis. Se fizer uma ação, diga em uma frase o que fez.',
  'O microfone fica aberto e a transcrição pode pegar conversa de outras pessoas ou TV. Se esta fala claramente não for um pedido para você',
  '(gente conversando entre si, frase solta sem sentido, comentário que não é com você), responda só [[ignorar]] e nada mais. Na dúvida, se parecer um pedido, atenda.',
].join('\n');
const IGNORE_RE = /\[\[ignorar\]\]/i;

// Na conversa por voz, o que não exige raciocínio vai para o modelo rápido (resposta em menos tempo).
const VOICE_FAST = new Set(['rapida', 'geral', 'escrita', 'sistema']);

// O Claude chamado pela Ohara-AI dentro do chat: responde aqui, só com acesso à internet.
const CLAUDE_CHAT_NOTE = [
  'Você é a Ohara, assistente pessoal do Gabriel. A Ohara-AI (o modelo local dela) chamou você para responder este pedido aqui no chat porque ele precisa de mais do que o modelo local dá conta.',
  'Responda sempre em português do Brasil, de forma direta e assertiva, com bom humor leve quando couber (no máximo uma brincadeira, nunca quando ele estiver com problema sério). Não faça referências a One Piece nem a animes.',
  'Você só tem pesquisa e leitura de páginas na internet: use quando precisar de informação atual e cite de onde veio. Não tem acesso a arquivos, comandos nem ao PC dele.',
  'Se o pedido for sobre um projeto, código ou arquivos, não tente fazer: diga em uma frase que isso fica com o Claude no Orca e que basta ele pedir "manda pro Claude".',
  'Se não souber ou não tiver certeza, diga isso em vez de inventar.',
].join('\n');

// Uso do Claude (0 a 1) na janela mais cheia.
const claudeUtil = (l) => (l ? Math.max(l.fiveHour ?? 0, l.weekly ?? 0) : 0);

const PARALLEL_NOTE =
  'Outra tarefa desta mesma conversa ainda está rodando em paralelo. Faça só o que este pedido pede e evite mexer nos mesmos arquivos que a outra tarefa sem necessidade.';

// Categorias que exigem ferramentas: só vão para o Claude (no Orca) quando o pedido é uma ação.
const AGENT_CATEGORIES = new Set(['codigo', 'codigo_complexo', 'sistema', 'pesquisa']);
const ACTION_RE = /\b(corrig\w*|conserta\w*|implement\w*|cri[ae]\w*|alter\w*|mud[ae]\w*|adicion\w*|remov\w*|apag\w*|refator\w*|ajust\w*|atualiz\w*|instal\w*|rod[ae]\w*|execut\w*|faz\w*|faca\w*|resolv\w*|publi\w*|deploy\w*|commit\w*|push\w*|merge\w*|migr\w*|otimiz\w*|escrev\w*|gera\w*|gere\w*|abr[aei]\w*|abert\w*|encaminh\w*|feche\w*|mov[ae]\w*|copi[ae]\w*|renome\w*|pesquis\w*|procur\w*|busca\w*|investig\w*|analis\w*|audit\w*|revis\w*|teste\w*|testar|debug\w*|desenvolv\w*|constru\w*|monte|montar)\b/;
const QUESTION_RE = /\b(tem como|da pra|da para|consegue|conseguiria|voce sabe|vc sabe|sabe fazer|sabe como|e possivel|seria possivel|como (eu )?(faco|posso)|como funciona)\b/;
// Pedido explícito para o Claude/Orca ("encaminhe ao Claude", "abre o Orca", "era pra ter aberto o Orca"):
// vai sem depender do modelo local acertar.
const HANDOFF_TARGET_RE = /\b(claude|orca)\b/;
const HANDOFF_VERB_RE = /\b(encaminh\w*|mand\w*|pass\w*|envi\w*|cham\w*|abr\w*|abert\w*|usa\w*|use|usar|segu\w*|faz\w*|fac\w*|leva\w*|joga\w*|deleg\w*|pede|pedir|resolv\w*|continu\w*)\b/;
const isHandoff = (plain) => HANDOFF_TARGET_RE.test(plain) && HANDOFF_VERB_RE.test(plain);
const MAX_CONTEXT_CHARS = 9000;
const DRAFT_STATUS = { pending: 'aguardando confirmação', sending: 'enviando', sent: 'enviada', error: 'falhou', cancelled: 'cancelada' };
const DRAFT_TTL = 30 * 60_000; // "confirmado" vale para rascunhos de até 30 min atrás
const MAX_MSG_CHARS = 1800;

function systemPrompt(config, cwd) {
  return [
    'Você é a Ohara, assistente pessoal do Gabriel rodando no PC dele (Windows 11).',
    'Responda sempre em português do Brasil, de forma direta.',
    `Diretório de trabalho atual: ${cwd}. Os repositórios ficam em ${config.workspaceRoot}.`,
    'Para ações no sistema use PowerShell (Start-Process para abrir programas e sites, Get-ChildItem, etc.).',
    'Antes de qualquer ação destrutiva ou difícil de desfazer (apagar arquivos, desinstalar, git push, force, formatar), pare e peça confirmação explícita na resposta em vez de executar.',
    'Fazer o que ele pediu diretamente (mandar uma mensagem, abrir algo, pesquisar) não precisa de confirmação: faça.',
    'Ao terminar uma tarefa, diga em uma ou duas frases o que foi feito.',
    '',
    'Seu jeito: você é resolutiva. Seu objetivo é resolver o problema do Gabriel, não só responder. Tente de verdade antes de dizer que não dá:',
    'procure outro caminho (PowerShell, um app, um site, um script), e se faltar uma informação pergunte só o essencial. Nunca termine só com "não consigo".',
    'Você tem bom humor: é leve, espirituosa e às vezes solta uma piada curta ou um comentário divertido, como uma amiga que manja muito.',
    'Não faça referências a One Piece nem a animes. O humor nunca atrapalha a tarefa: primeiro resolve, depois a graça;',
    'nada de piada quando ele estiver com problema sério, irritado ou com pressa, e nunca às custas dele. Sem exagero: no máximo uma brincadeira por resposta.',
    `Você pode melhorar a si mesma: o seu código-fonte está em ${config.selfRepo} (app Electron; integrações em src/integrations, lógica em src/core, telas em src/renderer, testes em test/).`,
    'Quando um pedido esbarrar em algo que você ainda não sabe ou não consegue fazer (uma integração que não existe, um recurso que falta, um erro seu),',
    'explique em uma frase o que falta, ofereça-se para se alterar e, no fim da resposta, inclua exatamente uma linha:',
    '[[melhoria: o que mudar em você, em uma frase objetiva]]',
    'Essa linha não aparece para ele; se ele aceitar, você recebe o pedido para implementar a mudança. Não ofereça melhoria quando der para resolver agora de outro jeito.',
  ].join('\n');
}

// A Ohara se oferece para se alterar: "[[melhoria: ...]]" no fim da resposta.
const IMPROVE_RE = /\n?\[\[melhoria:\s*([^\]]+?)\s*\]\]\s*/i;
// "sim", "pode fazer", "manda ver"... aceitando a oferta.
const YES_RE = /^(sim|s|pode|pode sim|pode fazer|faz|faca|faca isso|faz isso|manda ver|bora|vai|quero|claro|ok|beleza|blz|isso|por favor|com certeza|aceito|implementa|se altera)\b/;

function selfImprovePrompt(desc, request) {
  return [
    `O Gabriel aceitou que você se altere para conseguir: ${desc}.`,
    request ? `Pedido original dele: "${request}".` : '',
    'Implemente a mudança no seu próprio código (você está no repositório da Ohara), seguindo o padrão do projeto:',
    'leia os arquivos relacionados antes, faça a mudança completa, escreva ou ajuste testes em test/ e rode `npm test` até passar.',
    'Faça commit local com uma mensagem em português descrevendo a mudança (sem linha de coautoria). Não dê push, não gere instalador e não publique nada.',
    'No fim, diga em poucas frases o que mudou e pergunte se ele quer que você publique a versão nova (ela só passa a valer depois de instalada).',
  ].filter(Boolean).join('\n');
}

// Qual conta do Claude: "imlaw" (escritório) ou "pessoal". No pedido só vale se citar o Claude/conta;
// na resposta à pergunta da Ohara (loose) basta citar a conta.
function parseAccount(text, { loose = false } = {}) {
  const t = normalize(text);
  if (loose && t.split(/\s+/).length > 12) return null;
  const im = loose ? /\b(imlaw|im law|escritorio|trabalho)\b/ : /\b(claude|conta|login)\s+(?:d[oa]s?\s+)?(imlaw|im law|escritorio|trabalho)\b/;
  const pe = loose ? /\b(pessoal|minha conta|minha)\b/ : /\b(claude|conta|login)\s+(?:d[oa]s?\s+)?(pessoal|minha)\b/;
  const a = im.test(t);
  const b = pe.test(t);
  return a === b ? null : a ? 'imlaw' : 'pessoal';
}

const ACCOUNT_QUESTION = (cfg) =>
  `Antes de abrir o Orca: esse pedido é para o **${cfg?.imlaw?.label || 'Claude do escritório (ImLaw)'}** ou para o **${cfg?.pessoal?.label || 'Claude pessoal'}**? Responda "imlaw" ou "pessoal" que eu abro já com o pedido.`;

// Briefing em texto para o prompt do Claude no Orca.
function briefText(b) {
  if (!b) return '';
  const items = (title, list) => (list.length ? `\n${title}:\n${list.map((x) => `- ${x}`).join('\n')}` : '');
  return [
    `\nTarefa (preparada pela Ohara a partir da conversa): ${b.titulo}`,
    `Objetivo: ${b.objetivo}`,
    b.contexto ? `Contexto: ${b.contexto}` : '',
    items('Pronto quando', b.criterios),
    items('Confirme com ele antes de mexer, se precisar', b.duvidas),
  ].filter(Boolean).join('\n');
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class Orchestrator {
  constructor({ chatsStore, prefsStore, usage, getConfig, emit, whatsapp = null, whatsappWeb = null, openExternal = null, ensureChrome = null }) {
    this.openExternal = openExternal; // abre URLs/URIs (shell.openExternal); habilita as ações locais
    this.ensureChrome = ensureChrome; // abre o Chrome antes de pedidos de navegador, para a extensão Claude conectar

    this.whatsapp = getConfig().integrations.whatsapp?.enabled === false ? null : whatsapp; // CallMeBot: mensagens para o próprio Gabriel (opcional)
    this.whatsappWeb = getConfig().integrations.whatsapp?.enabled === false ? null : whatsappWeb; // WhatsApp Web: mensagens para contatos, sempre com confirmação (opcional)
    this.chats = chatsStore; // JsonStore { chats: [] }
    this.prefs = prefsStore; // JsonStore { overrides: [] }
    this.usage = usage;
    this.getConfig = getConfig;
    this.emit = emit; // (channel, payload) => void
    this.running = new Map(); // runId -> { chatId, ac }: vários agentes por conversa
  }

  list() {
    return this.chats.data.chats
      .map(({ id, title, cwd, updatedAt }) => ({ id, title, cwd, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.chats.data.chats.find((c) => c.id === id) || null;
  }

  create(cwd, title) {
    const config = this.getConfig();
    const chat = {
      id: crypto.randomUUID(),
      title: title || 'Nova conversa',
      cwd: cwd || config.defaultCwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      sessions: {},
    };
    this.chats.data.chats.push(chat);
    this.chats.save();
    return chat;
  }

  remove(id) {
    this.cancel(id);
    this.chats.data.chats = this.chats.data.chats.filter((c) => c.id !== id);
    this.chats.save();
  }

  setCwd(id, cwd) {
    const chat = this.get(id);
    if (!chat) return;
    chat.cwd = cwd;
    chat.sessions = {}; // sessões dos CLIs ficam presas ao diretório: recomeça com contexto transferido
    this.chats.save();
  }

  isRunning(chatId) {
    for (const r of this.running.values()) if (r.chatId === chatId) return true;
    return false;
  }

  // Sem runId, para todos os agentes da conversa.
  cancel(chatId, runId) {
    for (const [id, r] of this.running) if (r.chatId === chatId && (!runId || id === runId)) r.ac.abort();
  }

  // Preferências aprendidas com as suas trocas manuais de modelo.
  learned() {
    const config = this.getConfig();
    if (!config.learning?.enabled || !this.prefs) return {};
    return learnPreferences(this.prefs.data.overrides || [], config.learning.minVotes);
  }

  #remember(text, hasImage, override) {
    if (!this.prefs || !override || override === 'auto') return;
    const { category } = classify(text, { hasImage });
    const list = (this.prefs.data.overrides ||= []);
    list.push({ category, choice: override, at: Date.now() });
    if (list.length > 300) list.splice(0, list.length - 300);
    this.prefs.save();
  }

  forgetLearning() {
    if (!this.prefs) return;
    this.prefs.data.overrides = [];
    this.prefs.save();
  }

  // Repositórios conhecidos (para reconhecer "na ohara", "no taverna-bot"...). Cache de 5 min.
  #projects() {
    const root = this.getConfig().workspaceRoot;
    if (!this.projCache || this.projCache.root !== root || Date.now() - this.projCache.at > 5 * 60_000) {
      let list = [];
      try {
        const self = this.getConfig().selfRepo ? path.resolve(this.getConfig().selfRepo).toLowerCase() : null;
        list = listRepos(root).map((p) => ({ name: path.basename(p), path: p, self: path.resolve(p).toLowerCase() === self || path.basename(p).toLowerCase() === 'ohara' }));
      } catch {}
      this.projCache = { root, at: Date.now(), list };
    }
    return this.projCache.list;
  }

  // Pedido que vai ao Orca sem citar o projeto ("pode seguir", "encaminhe ao Claude"): procura o projeto
  // na tarefa resumida pela Ohara-AI, depois nas mensagens recentes dele, depois no último projeto aberto
  // no Orca nesta conversa. Assim o Claude abre dentro do projeto, e não na pasta geral.
  #projectFromChat(chat, handoff) {
    const projects = this.#projects();
    const inText = (t) => (t ? findProject(normalize(t), projects)?.path || null : null);
    const fromTask = inText(handoff?.task);
    if (fromTask) return fromTask;
    const users = chat.messages.filter((m) => m.role === 'user' && m.text).slice(-6).reverse();
    for (const m of users) {
      const p = inText(m.text);
      if (p) return p;
    }
    return chat.lastProject && fs.existsSync(chat.lastProject) ? chat.lastProject : null;
  }

  // Categoria do último pedido roteado automaticamente nesta conversa.
  #previousCategory(chat) {
    for (let i = (chat?.messages.length || 0) - 1; i >= 0; i--) {
      const r = chat.messages[i].route;
      if (r && r.category !== 'manual') return r.category;
    }
    return null;
  }

  // O chat roda no modelo local. Só o que exige ferramentas (código, comandos, pesquisa, navegador)
  // vai para o Claude, aberto no Orca. O roteador decide a categoria; aqui ela vira o destino.
  #route(chat, text, { hasImage }) {
    const config = this.getConfig();
    const base = route(text, {
      browser: config.claude?.chrome !== false && needsBrowser(text),
      hasImage,
      override: 'auto',
      usage: this.usage.limits(),
      config,
      learned: {},
      projects: this.#projects(),
      previous: this.#previousCategory(chat),
    });
    const continued = (base.reasons || []).some((r) => /continua o assunto/.test(r)) && !!chat?.messages.some((m) => m.route?.provider === 'orca');
    // Só consulta o PC (espaço, memória, navegadores instalados...): a Ohara-AI lê sozinha, sem o Claude.
    const pcInfo = config.ollama?.tools !== false && asksPcInfo(text);
    // Pergunta ("tem como...?", "dá pra...?") não é ordem: quem decide é a Ohara-AI, não o verbo solto.
    const question = QUESTION_RE.test(normalize(text));
    const toAgent = !pcInfo && ((AGENT_CATEGORIES.has(base.category) && ((ACTION_RE.test(normalize(text)) && !question) || continued)) || (config.claude?.chrome !== false && needsBrowser(text)));
    const reasons = [...(base.reasons || []), toAgent ? 'exige ferramentas: o Claude assume no Orca' : pcInfo ? 'consulta do PC: a Ohara-AI lê sozinha' : 'conversa: modelo local'];
    return toAgent
      ? { ...base, provider: 'orca', model: 'Claude no Orca', tier: undefined, effort: undefined, reasons }
      : { ...base, provider: 'ollama', model: config.ollama?.model || 'local', tier: undefined, effort: undefined, reasons };
  }

  preview(prompt, { hasImage, override, chatId }) {
    const action = !hasImage && (!override || override === 'auto') ? parseQuickAction(prompt) : null;
    if (action) {
      return { provider: 'local', model: 'ação local', category: 'local', label: action.type === 'google' ? 'Pesquisa no Google' : 'Abrir app/site', reasons: ['resolvido na hora, sem IA (se não achar o app, vai para a IA)'] };
    }
    return this.#route(chatId ? this.get(chatId) : null, prompt, { hasImage, override });
  }

  // Monta o contexto que o provedor ainda não viu.
  // upTo: índice da mensagem atual (fica de fora). fresh: sessão nova, manda todo o histórico.
  #handoff(chat, provider, { upTo = chat.messages.length, fresh = false } = {}) {
    const sess = fresh ? null : chat.sessions[provider];
    const history = chat.messages.slice(0, upTo);
    // syncedUpTo marca até onde este provedor já viu; o resto veio da outra IA ou de agentes paralelos.
    const unseen = history.slice(sess ? sess.syncedUpTo : 0).filter((m) => m.text);
    if (!unseen.length) return '';

    const out = [];
    let total = 0;
    for (const m of [...unseen].reverse()) {
      // O rascunho sai do texto; entra aqui para a IA saber o que está pronto (e não refazer à toa).
      const drafts = (m.whatsappDrafts || []).map((d) => `\n[Mensagem de WhatsApp para "${d.to}" (${DRAFT_STATUS[d.status] || d.status}): ${clip(d.text, 600)}]`).join('');
      const line = `${m.role === 'user' ? 'Gabriel' : `Assistente (${m.provider})`}: ${clip(m.text, MAX_MSG_CHARS)}${drafts}`;
      if (total + line.length > MAX_CONTEXT_CHARS) break;
      out.unshift(line);
      total += line.length;
    }
    return `[Contexto anterior desta conversa, respondido por outra IA da Ohara]\n${out.join('\n\n')}\n[Fim do contexto]\n\n`;
  }

  // Vários agentes por conversa: cada pedido roda por conta própria. Se já houver um rodando,
  // o novo vai em paralelo, numa sessão separada que recebe o histórico como contexto.
  async send(chatId, { text, images = [], override = 'auto', permissionMode, source = 'chat', runId: clientRunId, onDelta }) {
    const config = this.getConfig();
    if (source === 'voice' && config.voice.commandsEnabled === false) throw new Error('Comandos de voz desativados.');
    const chat = this.get(chatId);
    if (!chat) throw new Error('Conversa não encontrada');

    // Mensagem de WhatsApp pronta e ele respondeu "confirmado"/"envia"/"cancela": resolve na hora, sem IA.
    if (!images.length && (!override || override === 'auto')) {
      const reply = await this.#tryDraftReply(chat, text, clientRunId, source);
      if (reply) return reply;
    }

    // Ela se ofereceu para se alterar e ele aceitou: o Claude implementa no repositório da Ohara, pelo Orca.
    const improvement = this.#acceptedImprovement(chat, text);
    // Ela perguntou qual conta do Claude usar e ele respondeu: segue com o pedido guardado.
    const answered = this.#answeredAccount(chat, text);

    // "abre o Spotify", "pesquisa no Google X": resolve na hora, sem IA e sem gastar cota.
    if (this.openExternal && !images.length && !answered && (!override || override === 'auto')) {
      const local = await this.#tryQuickAction(chat, text, clientRunId, source);
      if (local) return local;
    }

    const parallel = this.isRunning(chatId);

    const decision = this.#route(chat, text, { hasImage: images.length > 0, override });
    if (improvement || answered) Object.assign(decision, { provider: 'orca', model: 'Claude no Orca', tier: undefined, effort: undefined });
    // Ficaria no chat local: antes, a Ohara-AI relê a conversa e decide se é tarefa para o Claude
    // ("pode seguir" depois de combinar uma alteração, "encaminhe ao Claude"). Não gasta cota, então sempre vale.
    let handoff = null;
    if (decision.provider === 'ollama' && !improvement && !answered && !images.length && (!override || override === 'auto')) {
      const explicit = isHandoff(normalize(text));
      // Mensagem de WhatsApp tem fluxo próprio (rascunho + confirmação) no chat local.
      const skip = config.ollama?.decide === false || (!!this.whatsappWeb && wantsWhatsApp(text)) || (config.ollama?.tools !== false && asksPcInfo(text));
      // Limite curto: com o Ollama lento ou travado, o pedido ficava até 3 min invisível e sem como cancelar.
      const verdict = skip ? null : await decideLocal({ config, history: chat.messages, text, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (explicit || verdict?.acao === 'claude') {
        handoff = { task: verdict?.tarefa || '' };
        Object.assign(decision, { provider: 'orca', model: 'Claude no Orca', tier: undefined, effort: undefined });
        decision.reasons = [...(decision.reasons || []), explicit ? 'pediu para mandar ao Claude' : 'a Ohara-AI leu a conversa: é tarefa para o Claude'];
      } else if (verdict?.acao === 'claude_chat') {
        // Não é projeto, mas o modelo local não dá conta: o Claude responde aqui mesmo, se houver cota.
        const why = this.#claudeChatBlocked(config);
        const motivo = verdict.motivo || 'o modelo local não basta';
        if (!why) {
          Object.assign(decision, { provider: 'claude', model: config.claude.models.equilibrado, tier: 'equilibrado', effort: 'medium' });
          decision.reasons = [...(decision.reasons || []), `a Ohara-AI chamou o Claude no chat: ${motivo}`];
        } else {
          decision.reasons = [...(decision.reasons || []), `pedia o Claude (${motivo}), mas ${why}: ficou no modelo local`];
        }
      }
    }
    if (source === 'voice' && decision.provider === 'claude' && VOICE_FAST.has(decision.category) && (!override || override === 'auto')) {
      Object.assign(decision, { tier: 'rapido', model: config.claude.models.rapido, effort: 'low' });
      decision.reasons = [...(decision.reasons || []), 'conversa por voz: modelo rápido'];
    }
    if (improvement) decision.reasons = [...(decision.reasons || []), 'melhoria aceita: a Ohara vai se alterar'];
    if (answered) decision.reasons = [...(decision.reasons || []), `conta escolhida: ${answered.account}`];
    if (source === 'chat' && !improvement && !answered) this.#remember(text, images.length > 0, override);

    // Conversa nova na pasta padrão citando um projeto: já trabalha dentro dele.
    if (decision.project && !chat.messages.length && chat.cwd === config.defaultCwd) {
      chat.cwd = decision.project.path;
      this.emit('chats:changed', {});
    }

    const userIndex = chat.messages.length;
    chat.messages.push({ role: 'user', text, images, at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip(text.replace(/\s+/g, ' '), 48);
    const runId = clientRunId || crypto.randomUUID();
    const assistant = {
      id: runId,
      role: 'assistant',
      text: '',
      provider: decision.provider,
      model: decision.model,
      route: decision,
      tools: [],
      parallel,
      at: Date.now(),
    };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId, runId, route: decision });

    const ac = new AbortController();
    this.running.set(runId, { chatId, ac });

    // Pasta da conversa apagada ou renomeada: o Windows recusaria abrir o agente nela
    // (e o erro aparece como "spawn claude ENOENT"). Volta para a pasta padrão.
    if (!improvement && !answered && chat.cwd && !fs.existsSync(chat.cwd) && config.defaultCwd && fs.existsSync(config.defaultCwd)) {
      decision.reasons = [...(decision.reasons || []), `a pasta ${chat.cwd} não existe mais: usando ${config.defaultCwd}`];
      chat.cwd = config.defaultCwd;
      chat.sessions = {};
      this.emit('chats:changed', {});
    }

    const cwd = answered
      ? answered.pending.dir
      : improvement
        ? config.selfRepo
        : decision.project?.path || (decision.provider === 'orca' ? this.#projectFromChat(chat, handoff) : null) || (chat.cwd !== config.defaultCwd ? chat.cwd : null);
    const onEvent = (ev) => {
      if (ev.kind === 'tool') assistant.tools.push(ev.text);
      if (ev.kind === 'delta' && onDelta) onDelta(ev.text);
      this.emit('chat:event', { chatId, runId, ...ev });
    };

    let result;
    try {
      if (decision.provider === 'orca') {
        const request = answered
          ? answered.pending.request
          : improvement
            ? `${selfImprovePrompt(improvement.desc, improvement.request)}\n\nResposta do Gabriel: ${text}`
            : handoff
              ? [handoff.task ? `Tarefa (resumida pela Ohara a partir da conversa): ${handoff.task}` : 'Faça a tarefa combinada na conversa recente.', `Última mensagem dele: ${text}`].join('\n')
              : text;
        const account = answered?.account || parseAccount(text);
        // O nome do console e da branch saem da tarefa, não de "pode seguir".
        // Melhoria aceita: o nome sai do que vai mudar, não do "sim".
        const label = answered ? answered.pending.text : improvement ? improvement.desc : handoff?.task || text;
        result = await this.#toOrca({
          chat, config, text: label, request, cwd, userIndex, onEvent, assistant, account,
          withContext: !!handoff, brief: answered?.pending.brief || null, hint: handoff?.task || '', signal: ac.signal,
        });
      } else if (decision.provider === 'claude') {
        try {
          result = await this.#claudeInChat({ chat, config, text, userIndex, decision, signal: ac.signal, onEvent, source });
        } catch (err) {
          if (ac.signal.aborted) throw err;
          // Claude fora (cota, login, privacidade sem o modelo local...): a Ohara-AI responde, sem deixar o pedido sem resposta.
          decision.reasons = [...(decision.reasons || []), `o Claude não respondeu (${clip(err.message, 160)}): a Ohara-AI respondeu`];
          onEvent({ kind: 'tool', text: 'Claude indisponível: respondendo no modelo local' });
          Object.assign(decision, { provider: 'ollama', model: config.ollama?.model || 'local', tier: undefined, effort: undefined });
          result = await chatLocal({
            config,
            history: chat.messages.slice(0, userIndex),
            text,
            project: cwd ? path.basename(cwd) : null,
            signal: ac.signal,
            onDelta: (t) => onEvent({ kind: 'delta', text: t }),
            onStep: (t) => onEvent({ kind: 'tool', text: t }),
          });
        }
      } else {
        result = await chatLocal({
          config,
          history: chat.messages.slice(0, userIndex),
          text,
          project: cwd ? path.basename(cwd) : null,
          signal: ac.signal,
          onDelta: (t) => onEvent({ kind: 'delta', text: t }),
          onStep: (t) => onEvent({ kind: 'tool', text: t }),
        });
        // A Ohara-AI não sabia: em vez de chutar ou devolver "não sei", pergunta ao Claude sozinha.
        if (result?.consult) result = await this.#consultClaude({ chat, config, text, userIndex, decision, signal: ac.signal, onEvent, source, local: result });
      }
    } catch (err) {
      result = { provider: decision.provider, model: decision.model, text: '', error: ac.signal.aborted ? 'Cancelado.' : err.message, tokens: {} };
    } finally {
      this.running.delete(runId);
    }

    assistant.text = result.text || '';
    assistant.error = result.error || null;
    assistant.model = result.model || decision.model;
    assistant.provider = result.provider || assistant.provider; // o Claude no chat pode ter caído para a Ohara-AI
    assistant.tokens = result.tokens;
    // Rascunho para contato vale mesmo quando o pedido não citou o WhatsApp ("envie a mensagem").
    const hasDraft = !!this.whatsappWeb && /\[\[whatsapp\s+para/i.test(assistant.text);
    // Por voz, conversa que não era com ela ("[[ignorar]]"): não responde nada.
    if (source === 'voice' && IGNORE_RE.test(assistant.text) && !hasDraft) {
      assistant.ignored = true;
      assistant.text = '(ignorado: não parecia um pedido para a Ohara)';
    }
    // Envio desligado, mas a IA ainda montou um bloco (ex.: por causa do histórico): mostra o texto para copiar.
    if (!this.whatsappWeb && /\[\[whatsapp\s+para/i.test(assistant.text)) {
      const { text: rest, drafts } = extractDrafts(assistant.text);
      assistant.text = [rest, ...drafts.map((d) => `**Mensagem para ${d.to}** (o envio pelo WhatsApp está desligado; copie e envie):\n\n${d.text}`)].filter(Boolean).join('\n\n');
    }

    // Oferta de automelhoria: guarda para o próximo "sim" e tira a marcação do texto.
    const offer = assistant.text.match(IMPROVE_RE);
    if (offer) {
      assistant.text = assistant.text.replace(IMPROVE_RE, '').trim();
      assistant.improvementOffer = offer[1];
      chat.pendingImprovement = { desc: offer[1], request: text, at: Date.now() };
    }

    chat.updatedAt = Date.now();
    this.chats.save();

    // Contabilidade de uso é secundária: uma falha aqui não pode impedir o "chat:done" (a tela ficaria presa em "rodando").
    try {
      // O modelo local e o Orca não consomem a cota do Claude/Codex.
      this.emit('usage:update', this.usage.summary());
    } catch (err) {
      console.error('Falha ao registrar o uso:', err);
    }
    this.emit('chat:done', { chatId, runId, message: assistant, source, running: this.isRunning(chatId) });
    return assistant;
  }

  // Por que a Ohara-AI não pode chamar o Claude no chat agora (null = pode).
  #claudeChatBlocked(config) {
    if (config.ollama?.claudeChat === false) return 'isso está desligado nos Ajustes';
    let limits = null;
    try {
      limits = this.usage.limits()?.claude || null;
    } catch {}
    if (limits?.status === 'rejected') return 'a cota do Claude acabou';
    const max = config.quota?.claudeAvoidAt ?? 0.9;
    if (claudeUtil(limits) >= max) return `a cota do Claude está em ${Math.round(claudeUtil(limits) * 100)}%`;
    return null;
  }

  // A Ohara-AI respondeu "[[consultar_claude]]": o Claude responde no chat. Sem cota ou com erro,
  // fica a resposta honesta do modelo local (nunca a marcação).
  async #consultClaude({ chat, config, text, userIndex, decision, signal, onEvent, source, local }) {
    const fallback = () => {
      const t = local.text || 'Não sei responder isso com segurança agora, e não consegui consultar o Claude.';
      onEvent({ kind: 'delta', text: t });
      return { ...local, text: t, consult: undefined };
    };
    const why = this.#claudeChatBlocked(config);
    if (why) {
      decision.reasons = [...(decision.reasons || []), `a Ohara-AI não sabia (${local.consult}), mas ${why}: ficou no modelo local`];
      return fallback();
    }
    onEvent({ kind: 'tool', text: `Ohara-AI não sabia (${clip(local.consult, 80)}): consultando o Claude` });
    Object.assign(decision, { provider: 'claude', model: config.claude.models.equilibrado, tier: 'equilibrado', effort: 'medium' });
    decision.reasons = [...(decision.reasons || []), `a Ohara-AI não sabia e consultou o Claude: ${local.consult}`];
    try {
      return await this.#claudeInChat({ chat, config, text, userIndex, decision, signal, onEvent, source });
    } catch (err) {
      if (signal?.aborted) throw err;
      decision.reasons = [...(decision.reasons || []), `o Claude não respondeu (${clip(err.message, 160)})`];
      Object.assign(decision, { provider: 'ollama', model: config.ollama?.model || 'local', tier: undefined, effort: undefined });
      return fallback();
    }
  }

  // O Claude responde no próprio chat: recebe a conversa como contexto, só tem internet e não salva sessão.
  async #claudeInChat({ chat, config, text, userIndex, decision, signal, onEvent, source }) {
    let prompt = `${this.#handoff(chat, 'claude', { upTo: userIndex, fresh: true })}${text}`;
    // Privacidade ligada: CPF, nomes etc. viram marcadores antes de sair do PC. A resposta só aparece
    // no fim, já com os nomes de volta (em pedaços ela mostraria os marcadores).
    const priv = config.privacy || {};
    let map = null;
    if (priv.anonymizeCloud) {
      const keep = [...(priv.keep || []), config.meetings?.selfName].filter(Boolean);
      let a;
      try {
        a = await anonymize({ config, text: prompt, names: priv.names !== false, keep, signal, strict: true });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new Error(`a privacidade está ligada, mas ${e.message}; nada foi enviado para a nuvem`);
      }
      prompt = a.text;
      map = Object.keys(a.map || {}).length ? a.map : null;
    }
    const systemPrompt = [CLAUDE_CHAT_NOTE, source === 'voice' ? VOICE_NOTE : ''].filter(Boolean).join('\n\n');
    onEvent({ kind: 'tool', text: `Ohara-AI chamou o Claude (${decision.model})` });
    const r = await runClaude({
      config,
      args: buildChatArgs({ model: decision.model, effort: decision.effort || 'medium', systemPrompt }),
      cwd: os.tmpdir(),
      prompt,
      signal,
      onEvent: (ev) => {
        if (ev.kind === 'limits') {
          try {
            this.usage.updateClaudeLimits(ev.info);
          } catch {}
          return;
        }
        if (map && ev.kind === 'delta') return;
        onEvent(ev);
      },
    });
    if (r.error) throw new Error(r.error);
    if (!r.text) throw new Error('resposta vazia');
    try {
      this.usage.record('claude', r.model, r.tokens, 'chat');
    } catch {}
    if (map) {
      r.text = deanonymize(r.text, map);
      onEvent({ kind: 'delta', text: r.text });
    }
    return r;
  }

  // Abre o Orca no projeto, na branch da tarefa, com o Claude já recebendo o pedido e o contexto.
  async #toOrca({ chat, config, text, request, cwd, userIndex, onEvent, assistant, account = null, withContext = false, brief = null, hint = '', signal = null }) {
    const general = config.orca?.generalDir || config.defaultCwd;
    let dir = cwd && fs.existsSync(cwd) ? cwd : general;
    const keyOf = (d) => path.resolve(d).toLowerCase();
    // Console novo: antes de abrir, a Ohara analisa a conversa e monta a tarefa (título, branch, objetivo,
    // contexto, critérios). Sem projeto definido, o assunto do briefing escolhe o projeto.
    if (!brief && !chat.orca?.[keyOf(dir)]?.terminal) {
      brief = await this.#brief({ chat, config, text, userIndex, hint, onEvent, signal });
    }
    if (brief?.projectPath && dir === general && fs.existsSync(brief.projectPath)) dir = brief.projectPath;
    const key = keyOf(dir);
    const state = chat.orca?.[key] || null;
    // Console novo: usa a conta que ele já escolheu para este projeto (ou nesta conversa); só pergunta
    // qual Claude (escritório ou pessoal) quando não há escolha anterior. Continuar no console aberto não pergunta.
    if (!account && !state?.terminal && !state?.account) account = this.#knownAccount(chat, key, dir);
    if (!account && !state?.terminal && !state?.account) {
      chat.pendingOrca = { text, request, dir, brief, at: Date.now() };
      return { provider: 'orca', model: 'Claude no Orca', text: ACCOUNT_QUESTION(config.orca?.accounts), tokens: {} };
    }
    const recent = chat.messages
      .slice(0, userIndex)
      .filter((m) => m.text)
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Gabriel' : 'Ohara'}: ${clip(m.text, 700)}`)
      .join('\n');
    // Pedido de navegador: abre o Chrome antes (a extensão Claude in Chrome precisa dele aberto) e orienta o Claude.
    let browserNote = '';
    if (config.claude?.chrome !== false && wantsBrowser(text)) {
      let issue = null;
      if (this.ensureChrome) {
        const chrome = await this.ensureChrome().catch((err) => ({ running: false, error: err.message }));
        if (chrome?.started && chrome.running) onEvent({ kind: 'tool', text: 'Chrome: aberto para a extensão Claude conectar' });
        if (!chrome?.running) issue = `não consegui abrir (${chrome?.error || 'erro desconhecido'})`;
        else if (chrome.bridge === false) issue = chrome.error || 'a extensão Claude in Chrome não está registrada';
        if (issue) onEvent({ kind: 'tool', text: `Chrome: ${issue}` });
      }
      browserNote = [chromeNote(findChrome()), issue ? chromeIssueNote(issue) : ''].filter(Boolean).join('\n');
    }
    // Console já aberto: manda só o pedido; se o pedido vem da conversa ("pode seguir"), leva a conversa junto.
    const parts = state && state.terminal
      ? [withContext && recent ? `Conversa recente com a Ohara:\n${recent}\n` : '', request]
      : [
          'Você foi aberto pela Ohara, assistente pessoal do Gabriel, para fazer esta tarefa. Responda em português do Brasil.',
          `Pasta do projeto: ${dir}${dir === general ? ` (nenhum projeto definido; os repositórios ficam em ${config.workspaceRoot})` : ''}.`,
          'Regras: commits sem linha de coautoria; não dê push, não publique e não faça nada destrutivo sem pedir confirmação a ele; no fim, resuma em poucas frases o que foi feito.',
          'Vá a fundo antes de mexer: leia o código relacionado, reproduza o problema e confirme a causa. Se o pedido for vago, investigue e proponha um plano curto antes de alterar.',
          briefText(brief),
          recent ? `\nConversa recente com a Ohara:\n${recent}` : '',
          browserNote ? `\n${browserNote}` : '',
          `\n${brief ? 'Mensagem original do Gabriel' : 'Pedido do Gabriel'}:\n${request}`,
        ];
    // Aspas duplas viram "^" no caminho até o Orca: troca por aspas tipográficas.
    const prompt = parts.filter(Boolean).join('\n').replace(/"/g, '”');
    onEvent({ kind: 'tool', text: 'Orca: abrindo o projeto e o Claude' });
    const r = await sendToOrca({ config, cwd: dir, request: text, prompt, state, account, branch: brief?.branch || null, title: brief?.titulo || null });
    (chat.orca ||= {})[key] = r.state;
    if (dir !== general) chat.lastProject = dir;
    this.#rememberAccount(chat, key, r.state?.account || account);
    const where = r.branch ? `no projeto **${path.basename(r.root)}**, na branch \`${r.branch}\`` : `na pasta **${path.basename(r.root)}**`;
    const msg = r.reused
      ? `Mandei o pedido para o Claude que já está trabalhando ${where}, no Orca.`
      : `Abri o Orca ${where}, com o Claude já recebendo o pedido e o contexto da nossa conversa. Acompanhe e responda por lá.`;
    assistant.orca = { branch: r.branch, root: r.root, reused: r.reused };
    return { provider: 'orca', model: 'Claude no Orca', text: msg, tokens: {} };
  }

  // Briefing da tarefa: primeiro no modelo local (sem cota); se não servir, pede ao Claude no chat
  // (só com cota e sem a privacidade ligada, que exigiria anonimizar). Falhou tudo → null (pedido como veio).
  async #brief({ chat, config, text, userIndex, hint, onEvent, signal }) {
    if (config.orca?.brief === false) return null;
    const history = chat.messages.slice(0, userIndex);
    const projects = this.#projects();
    onEvent({ kind: 'tool', text: 'Ohara-AI: analisando a conversa para montar a tarefa' });
    let b = await briefLocal({ config, history, text, projects, hint, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) }).catch((e) => {
      if (signal?.aborted) throw e;
      return null;
    });
    if (b || this.#claudeChatBlocked(config) || config.privacy?.anonymizeCloud) return b;
    onEvent({ kind: 'tool', text: 'Briefing: o modelo local não conseguiu, pedindo ao Claude' });
    const convo = history
      .filter((m) => m.text)
      .slice(-10)
      .map((m) => `${m.role === 'user' ? 'Gabriel' : 'Ohara'}: ${clip(m.text, 900)}`)
      .join('\n');
    try {
      const r = await runClaude({
        config,
        args: buildChatArgs({ model: config.claude.models.rapido, effort: 'low', systemPrompt: BRIEF_PROMPT }),
        cwd: os.tmpdir(),
        prompt: briefInput({ convo, text, projects, hint }),
        signal,
        onEvent: () => {},
      });
      b = r.error ? null : parseBrief(r.text, projects);
      if (b) {
        try {
          this.usage.record('claude', r.model, r.tokens, 'chat');
        } catch {}
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      b = null;
    }
    return b;
  }

  // Conta já escolhida: a deste projeto (lembrada entre conversas), a da conversa, ou ImLaw pelo caminho.
  #knownAccount(chat, key, dir) {
    const saved = this.prefs?.data?.accounts?.[key];
    if (saved === 'imlaw' || saved === 'pessoal') return saved;
    if (chat.lastAccount === 'imlaw' || chat.lastAccount === 'pessoal') return chat.lastAccount;
    return /imlaw/i.test(String(dir || '')) ? 'imlaw' : null;
  }

  #rememberAccount(chat, key, account) {
    if (account !== 'imlaw' && account !== 'pessoal') return;
    chat.lastAccount = account;
    if (!this.prefs?.data) return;
    (this.prefs.data.accounts ||= {})[key] = account;
    try {
      this.prefs.save();
    } catch {}
  }

  // Resposta ("imlaw"/"pessoal") à pergunta de qual Claude abrir, até 30 min depois.
  #answeredAccount(chat, text) {
    const pending = chat.pendingOrca;
    if (!pending) return null;
    delete chat.pendingOrca; // vale só para a resposta seguinte
    const account = parseAccount(text, { loose: true });
    return account && Date.now() - pending.at < 30 * 60_000 ? { pending, account } : null;
  }

  // "sim"/"pode fazer" logo depois de ela oferecer uma melhoria (até 30 min depois).
  #acceptedImprovement(chat, text) {
    const pending = chat.pendingImprovement;
    if (!pending) return null;
    const plain = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^[^a-z]+/, '').trim();
    const fresh = Date.now() - pending.at < 30 * 60_000;
    delete chat.pendingImprovement; // vale só para a resposta seguinte
    if (!fresh || !YES_RE.test(plain) || plain.split(/\s+/).length > 12) return null;
    return pending;
  }

  async #tryQuickAction(chat, text, clientRunId, source) {
    const action = parseQuickAction(text);
    if (!action) return null;
    let done;
    try {
      done = await runQuickAction(action, { openExternal: this.openExternal });
    } catch {
      done = null;
    }
    if (!done) return null; // não achou o app: a IA tenta

    const runId = clientRunId || crypto.randomUUID();
    const route = { provider: 'local', model: 'ação local', category: 'local', label: action.type === 'google' ? 'Pesquisa no Google' : 'Abrir app/site', reasons: ['resolvido na hora, sem IA'] };
    chat.messages.push({ role: 'user', text, images: [], at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip(text.replace(/\s+/g, ' '), 48);
    const assistant = { id: runId, role: 'assistant', text: done.text, provider: 'local', model: 'ação local', route, tools: [], at: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId: chat.id, runId, route });
    this.emit('chat:done', { chatId: chat.id, runId, message: assistant, source, running: this.isRunning(chat.id) });
    return assistant;
  }

  // Contato → mostra o contato achado e espera a confirmação (ou envia na hora, se ele desligou a confirmação); sem contato → vai para o próprio Gabriel.
  async #handleWhatsApp(assistant, { toSelf = true, chat = null, autoSend = true } = {}) {
    const { text, drafts } = extractDrafts(assistant.text);
    if (drafts.length) {
      assistant.text = text || 'Mensagem pronta para enviar:';
      assistant.whatsappDrafts = drafts.map((d) => ({ ...d, status: 'pending' }));
      if (!this.whatsappWeb) {
        for (const d of assistant.whatsappDrafts) Object.assign(d, { status: 'error', error: 'Envio para contatos indisponível.' });
        return;
      }
      if (!chat) return;
      if (!autoSend) {
        // Acha o contato de verdade e mostra o nome para ele confirmar; o envio vai exatamente para esse contato.
        const lines = [];
        for (const d of assistant.whatsappDrafts) {
          if (!this.whatsappWeb.resolve) continue;
          try {
            const { to } = await this.whatsappWeb.resolve(d.to);
            d.contact = to;
            lines.push(`Achei o contato "${to}" no seu WhatsApp. É esse? Diga "confirmado" para enviar ou "cancela".`);
          } catch (err) {
            Object.assign(d, { status: 'error', error: err.message });
            lines.push(`Ainda não enviei para ${d.to}: ${err.message}`);
          }
        }
        if (lines.length) assistant.text = `${assistant.text}\n\n${lines.join('\n')}`.trim();
        return;
      }
      const lines = [];
      for (let i = 0; i < assistant.whatsappDrafts.length; i++) {
        const d = assistant.whatsappDrafts[i];
        try {
          const sent = await this.confirmWhatsApp(chat.id, assistant.id, i);
          lines.push(`Enviei para ${sent.sentTo || d.to} no WhatsApp.`);
        } catch (err) {
          lines.push(`Não consegui enviar para ${d.to}: ${err.message}`);
        }
      }
      // A resposta já dizia o que ia mandar; acrescenta o resultado de verdade (é o que ela fala por voz).
      assistant.text = `${assistant.text}\n\n${lines.join('\n')}`.trim();
      return;
    }
    if (!toSelf) return;
    if (!this.whatsapp?.configured) {
      assistant.whatsapp = { sent: false, error: 'WhatsApp não configurado: informe o número e a chave do CallMeBot em Ajustes.' };
      return;
    }
    try {
      const parts = await this.whatsapp.send(assistant.text);
      assistant.whatsapp = { sent: true, parts, at: Date.now() };
    } catch (err) {
      assistant.whatsapp = { sent: false, error: err.message };
    }
  }

  #findDraft(chatId, messageId, index = 0) {
    const chat = this.get(chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    const draft = msg?.whatsappDrafts?.[index];
    if (!draft) throw new Error('Rascunho não encontrado.');
    return { chat, msg, draft };
  }

  // Rascunhos ainda não enviados na última resposta dela (e de até DRAFT_TTL atrás).
  #openDrafts(chat) {
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant');
    if (!last?.whatsappDrafts?.length || Date.now() - (last.at || 0) > DRAFT_TTL) return null;
    const open = last.whatsappDrafts.map((d, i) => ({ d, i })).filter(({ d }) => d.status === 'pending' || d.status === 'error');
    return open.length ? { msg: last, open } : null;
  }

  // "confirmado", "pode enviar", "envia pra Tata" → envia o rascunho pendente; "cancela" → descarta.
  // A confirmação por texto ou voz vale como o clique em "Enviar".
  async #tryDraftReply(chat, text, clientRunId, source) {
    if (!this.whatsappWeb) return null;
    const found = this.#openDrafts(chat);
    if (!found) return null;
    const intent = parseSendReply(text, found.open.flatMap(({ d }) => [d.to, d.contact].filter(Boolean)));
    if (!intent) return null;
    // "sim" sozinho com uma oferta de melhoria aberta: a pergunta era a melhoria, não o envio.
    if (intent === 'yes' && chat.pendingImprovement && Date.now() - chat.pendingImprovement.at < 30 * 60_000) return null;
    delete chat.pendingImprovement;

    const lines = [];
    if (intent === 'cancel') {
      for (const { i } of found.open) this.cancelWhatsApp(chat.id, found.msg.id, i);
      lines.push(found.open.length > 1 ? 'Beleza, cancelei as mensagens.' : `Beleza, cancelei a mensagem para ${found.open[0].d.to}.`);
    } else {
      for (const { d, i } of found.open) {
        try {
          const sent = await this.confirmWhatsApp(chat.id, found.msg.id, i);
          lines.push(`Pronto, enviei a mensagem para ${sent.sentTo || d.to} no WhatsApp.`);
        } catch (err) {
          lines.push(`Não consegui enviar para ${d.to}: ${err.message}`);
        }
      }
    }

    const runId = clientRunId || crypto.randomUUID();
    const route = { provider: 'local', model: 'ação local', category: 'local', label: 'WhatsApp', reasons: ['confirmação do envio, sem IA'] };
    chat.messages.push({ role: 'user', text, images: [], at: Date.now() });
    const assistant = { id: runId, role: 'assistant', text: lines.join('\n'), provider: 'local', model: 'ação local', route, tools: [], at: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId: chat.id, runId, route });
    this.emit('chat:done', { chatId: chat.id, runId, message: assistant, source, running: this.isRunning(chat.id) });
    return assistant;
  }

  /** Envia um rascunho para o contato. Chamado pelo botão "Enviar" ou quando ele responde "confirmado"/"envia". */
  async confirmWhatsApp(chatId, messageId, index = 0) {
    const { chat, msg, draft } = this.#findDraft(chatId, messageId, index);
    if (draft.status === 'sent') return draft;
    if (draft.status === 'sending') throw new Error('Já está enviando.');
    if (!this.whatsappWeb) throw new Error('Envio para contatos indisponível.');
    draft.status = 'sending';
    draft.error = null;
    this.emit('chat:message', { chatId, message: msg });
    try {
      const { to } = await this.whatsappWeb.send(draft.contact || draft.to, draft.text);
      Object.assign(draft, { status: 'sent', sentTo: to, sentAt: Date.now() });
    } catch (err) {
      Object.assign(draft, { status: 'error', error: err.message });
    }
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    if (draft.status === 'error') throw new Error(draft.error);
    return draft;
  }

  cancelWhatsApp(chatId, messageId, index = 0) {
    const { msg, draft } = this.#findDraft(chatId, messageId, index);
    if (draft.status === 'sent' || draft.status === 'sending') return draft;
    draft.status = 'cancelled';
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    return draft;
  }
}

module.exports = { Orchestrator };
