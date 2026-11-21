// Agente da edição Guia: recebe o pedido, escolhe a IA pelo roteador de várias IAs, tira uma foto da pasta,
// executa, troca de IA se a escolhida falhar (cota, login, fora do ar) e registra o uso para a economia.
// O contexto vai junto quando a conversa passa de uma IA para outra.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { routeMulti } = require('../core/multi-router');
const { allSpecs, routeLabel } = require('../core/providers/registry');
const { asksPcInfo } = require('../core/pc-tools');
const { asksPcAction, defaultCtx, runPending, replyToPending, toPending, askLine } = require('../core/pc-actions');

const MAX_CONTEXT_CHARS = 9000;
const MAX_MSG_CHARS = 1800;
const MAX_ATTEMPTS = 3;

// Falhas em que vale tentar outra IA (e não mostrar o erro de cara).
// Palavras inteiras: "rate" não pode casar com "generate", nem "500" com um número qualquer.
const RETRYABLE = /\b(cota\w*|quota\w*|limit\w*|rate.?limit\w*|esgot\w*|exhaust\w*|not logged|login|logad\w*|auth(?:entic\w*|ori[sz]ation\w*)?|unauthori[sz]ed|credential\w*|enoent|indisponível|unavailable|overloaded|timeout|timed out|econnrefused)\b|não encontrei o programa|não respondeu|\b(429|500|502|503|529)\b/i;

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function systemPrompt(config, cwd, { explain = true } = {}) {
  const name = config.userName || 'a pessoa';
  return [
    `Você é a Ohara, assistente de IA de ${name}, rodando no PC dele (Windows).`,
    'Responda sempre em português do Brasil, de forma direta e amigável.',
    `${config.userName || 'Ele'} NÃO é programador: gosta de criar coisas com IA, mas não conhece os termos técnicos.`,
    '- Evite jargão. Quando um termo técnico for inevitável (API, deploy, terminal, npm…), explique em poucas palavras entre parênteses na primeira vez.',
    '- Prefira o caminho mais simples que resolve. Não complique nem crie o que não foi pedido.',
    '- Se o pedido for grande (um sistema inteiro, várias telas), sugira dividir em etapas com o Planejador da Ohara antes de sair fazendo.',
    cwd ? `Pasta do projeto: ${cwd}. Trabalhe SÓ dentro dela.` : 'Nenhuma pasta de projeto escolhida: não crie nem altere arquivos sem perguntar onde.',
    'Segurança:',
    '- Nunca apague, mova ou altere nada fora da pasta do projeto.',
    '- Antes de qualquer ação difícil de desfazer (apagar muitos arquivos, desinstalar programas, publicar na internet, git push, mexer em configurações do Windows, gastar dinheiro), PARE e peça confirmação explícita.',
    '- Nunca peça nem grave senhas no código. Chaves de API ficam num arquivo .env, e diga isso a ele.',
    '- A Ohara tira uma foto da pasta do projeto antes de cada pedido: ele pode clicar em "Desfazer" se não gostar. Isso vale só para a pasta do projeto.',
    explain ? 'Ao terminar uma tarefa que mexeu em arquivos ou rodou comandos, termine com uma seção "**O que eu fiz:**" com 2 a 4 itens curtos em linguagem simples e, se fizer sentido, "**Como conferir:**" com o que ele deve abrir ou testar.' : 'Ao terminar, diga em uma ou duas frases o que foi feito.',
  ].join('\n');
}

class GuideAgent {
  /**
   * @param {object} o
   * @param {import('../core/store').JsonStore} o.chatsStore  { chats: [] }
   * @param {import('../core/usage').UsageTracker} o.usage
   * @param {() => object} o.getConfig
   * @param {() => Set<string>} o.getAvailable  IAs prontas (da checagem de saúde)
   * @param {(channel:string, payload:object) => void} o.emit
   * @param {import('../core/checkpoints').Checkpoints} [o.checkpoints]
   * @param {(id:string, opts:object) => Promise<object>} [o.runProvider]
   */
  constructor({ chatsStore, usage, getConfig, getAvailable, emit, checkpoints = null, runProvider = null, privacy = null, notify = null, actionCtx = null, localChat = null }) {
    this.notify = notify; // notificação do Windows (lembretes da Ohara-AI)
    this.actionCtxOverride = actionCtx; // testes: troca PowerShell e programas das ações no PC
    this.localChat = localChat || ((o) => require('../core/local-chat').chatLocal(o)); // a Ohara-AI (modelo local com ferramentas)
    this.chats = chatsStore;
    this.usage = usage;
    this.getConfig = getConfig;
    this.getAvailable = getAvailable;
    this.emit = emit;
    this.checkpoints = checkpoints;
    this.runProvider = runProvider || require('../core/providers/registry').runProvider;
    this.privacy = privacy || require('../core/local-tools'); // { anonymize, deanonymize }
    this.running = new Map(); // runId -> { chatId, ac }
    if (!this.chats.data.chats) this.chats.data.chats = [];
    // Respostas que estavam rodando quando o app fechou.
    for (const c of this.chats.data.chats) for (const m of c.messages || []) if (m.pending) { delete m.pending; m.error ||= 'Interrompido (o app foi fechado).'; }
  }

  // ---------- Conversas ----------
  list() {
    return this.chats.data.chats
      .map(({ id, title, cwd, updatedAt, planId }) => ({ id, title, cwd, updatedAt, planId: planId || null }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.chats.data.chats.find((c) => c.id === id) || null;
  }

  create(cwd, title, extra = {}) {
    const chat = { id: crypto.randomUUID(), title: title || 'Nova conversa', cwd: cwd || null, createdAt: Date.now(), updatedAt: Date.now(), messages: [], sessions: {}, ...extra };
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
    chat.cwd = cwd || null;
    chat.sessions = {}; // as sessões das IAs ficam presas à pasta: recomeça levando o contexto
    this.chats.save();
  }

  isRunning(chatId) {
    for (const r of this.running.values()) if (r.chatId === chatId) return true;
    return false;
  }

  cancel(chatId, runId) {
    for (const [id, r] of this.running) if (r.chatId === chatId && (!runId || id === runId)) r.ac.abort();
  }

  // ---------- Cota ----------
  /** Uso de cota de todas as IAs: o informado pelos CLIs e, no Gemini, a estimativa pelos pedidos do dia. */
  limits() {
    const config = this.getConfig();
    const l = { ...this.usage.limits() };
    for (const spec of allSpecs(config)) {
      if (spec.quota === 'estimated' && spec.dailyRequests) {
        l[spec.id] = { daily: Math.min(1, this.usage.callsToday(spec.id) / spec.dailyRequests), estimated: true, calls: this.usage.callsToday(spec.id), dailyRequests: spec.dailyRequests };
      }
    }
    return l;
  }

  #route(chat, text, { hasImage = false, override = 'auto', category } = {}) {
    const config = this.getConfig();
    const previous = [...(chat?.messages || [])].reverse().find((m) => m.route && m.route.category !== 'manual')?.route.category;
    return routeMulti(text, {
      config,
      limits: this.limits(),
      available: this.getAvailable(),
      hasImage,
      override,
      category,
      previous,
      needsTools: !!chat?.cwd,
    });
  }

  preview(text, { chatId, hasImage, override, category } = {}) {
    return this.#route(chatId ? this.get(chatId) : null, text, { hasImage, override, category });
  }

  // Contexto que a IA ainda não viu (veio de outra IA ou de antes de trocar de pasta).
  #handoff(chat, provider, upTo, fresh = false) {
    const sess = fresh ? null : chat.sessions[provider];
    const unseen = chat.messages.slice(sess ? sess.syncedUpTo : 0, upTo).filter((m) => m.text && !m.error);
    if (!unseen.length) return '';
    const out = [];
    let total = 0;
    for (const m of [...unseen].reverse()) {
      const who = m.role === 'user' ? 'Usuário' : `Assistente (${m.provider})`;
      const line = `${who}: ${clip(m.text, MAX_MSG_CHARS)}`;
      if (total + line.length > MAX_CONTEXT_CHARS) break;
      out.unshift(line);
      total += line.length;
    }
    return `[Contexto anterior desta conversa, respondido por outra IA da Ohara]\n${out.join('\n\n')}\n[Fim do contexto]\n\n`;
  }

  async #snapshot(cwd, label) {
    const config = this.getConfig();
    if (!this.checkpoints || config.safety?.checkpoints === false || !cwd) return null;
    if (!this.checkpoints.supported(cwd).ok) return null;
    try {
      return await this.checkpoints.snapshot(cwd, label);
    } catch {
      return null; // sem Git ou pasta presa: segue sem ponto de restauração
    }
  }

  /**
   * @param {string} chatId
   * @param {object} p { text, images?, override?, fullAccess?, category?, runId?, label? }
   */
  async send(chatId, { text, images = [], override = 'auto', fullAccess = false, category, runId: clientRunId, label }) {
    const config = this.getConfig();
    const chat = this.get(chatId);
    if (!chat) throw new Error('Conversa não encontrada.');
    if (chat.cwd && !fs.existsSync(chat.cwd)) {
      chat.cwd = null;
      chat.sessions = {};
    }

    // Pedido sobre o PC (ler ou fazer: volume, arquivos, fechar programa, desligar...): a Ohara-AI resolve no
    // modelo local, com confirmação para o arriscado. "confirma"/"cancela" responde a uma ação pendente.
    if (!images.length && (!override || override === 'auto') && !category && !label) {
      const acted = await this.#tryActionReply(chat, text, clientRunId);
      if (acted) return acted;
      if (this.#forOharaAi(text)) {
        const local = await this.#oharaAi(chat, text, clientRunId);
        if (local) return local;
      }
    }

    const decision = this.#route(chat, text, { hasImage: images.length > 0, override, category });
    // Dois pedidos ao mesmo tempo na mesma pasta misturam as fotos de antes/depois: o "Desfazer"
    // de um reverteria também o outro. Planejar e a IA local não mexem em arquivos.
    const touchesFiles = decision.provider && decision.provider !== 'ollama' && decision.category !== 'planejamento';
    if (touchesFiles && chat.cwd && this.isRunning(chatId)) {
      throw new Error('Esta conversa já está executando um pedido na pasta do projeto. Espere terminar ou clique em Parar.');
    }
    const userIndex = chat.messages.length;
    chat.messages.push({ role: 'user', text: label || text, images, at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip((label || text).replace(/\s+/g, ' '), 48);
    const runId = clientRunId || crypto.randomUUID();
    const assistant = { id: runId, role: 'assistant', text: '', provider: decision.provider, model: decision.modelLabel || decision.model, route: decision, tools: [], pending: true, at: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId, runId, route: decision });

    if (!decision.provider) {
      delete assistant.pending;
      assistant.error = decision.error;
      this.chats.save();
      this.emit('chat:done', { chatId, runId, message: assistant, running: this.isRunning(chatId) });
      return assistant;
    }

    const ac = new AbortController();
    this.running.set(runId, { chatId, ac });
    const onEvent = (ev) => {
      if (ev.kind === 'tool') assistant.tools.push(ev.text);
      if (ev.kind === 'limits' && ev.provider === 'claude') this.usage.updateClaudeLimits(ev.info);
      this.emit('chat:event', { chatId, runId, ...ev });
    };

    // Planejar não mexe em arquivos: sem foto. A IA local também não mexe.
    const before = touchesFiles ? await this.#snapshot(chat.cwd, `antes: ${clip(label || text, 80)}`) : null;
    const attempts = [decision, ...(decision.fallbacks || [])].slice(0, MAX_ATTEMPTS);
    const failures = [];
    let result = null;
    let used = decision;
    try {
      for (const t of attempts) {
        if (ac.signal.aborted) break;
        used = t;
        if (t !== decision) {
          onEvent({ kind: 'tool', text: `${failures.at(-1)}: tentando ${t.modelLabel || routeLabel(t.provider, t.tier, t.model)}` });
          this.emit('chat:route', { chatId, runId, route: { ...decision, ...t, reasons: [...decision.reasons, `trocou de IA: ${failures.join('; ')}`] } });
        }
        // Privacidade: o que vai para a nuvem sai com marcadores. Cada pedido abre uma sessão nova com o
        // contexto inteiro, porque os marcadores ([PESSOA_1]...) são numerados de novo a cada pedido.
        const protect = config.privacy?.anonymizeCloud && t.provider !== 'ollama';
        const sess = protect ? null : chat.sessions[t.provider];
        const context = this.#handoff(chat, t.provider, userIndex, protect);
        let prompt = `${context}${text}`;
        let map = null;
        if (protect) {
          try {
            const a = await this.privacy.anonymize({ config, text: prompt, names: config.privacy.names !== false, keep: [...(config.privacy.keep || []), config.userName].filter(Boolean), signal: ac.signal });
            prompt = a.text;
            map = a.map;
            if (a.count) onEvent({ kind: 'tool', text: `Privacidade: ${a.count} dado(s) pessoais trocados por marcadores antes de enviar` });
          } catch (err) {
            result = { provider: t.provider, model: t.model, text: '', error: `A privacidade está ligada, mas não consegui proteger o texto (${clip(err.message, 120)}). Nada foi enviado.`, tokens: {} };
            break;
          }
        }
        const unmask = (v) => (map ? this.privacy.deanonymize(v, map) : v);
        let partial = '';
        const toolsBefore = assistant.tools.length;
        result = await this.runProvider(t.provider, {
          prompt,
          systemPrompt: systemPrompt(config, chat.cwd, { explain: config.safety?.explain !== false })
            + (map && Object.keys(map).length ? '\nO texto tem marcadores como [PESSOA_1] e [CPF_1] no lugar de dados pessoais: use-os exatamente assim, sem tentar adivinhar o que são.' : ''),
          history: chat.messages.slice(0, userIndex), // a IA local não tem sessão: recebe o histórico
          cwd: chat.cwd || config.defaultCwd,
          model: t.model === 'padrão' ? '' : t.model,
          effort: t.effort,
          sessionId: sess?.id || null,
          images,
          permissionMode: fullAccess ? 'bypassPermissions' : undefined,
          sandbox: fullAccess ? 'danger-full-access' : undefined,
          approvalMode: fullAccess ? 'yolo' : config.gemini?.approvalMode,
          config,
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.kind === 'delta') partial += ev.text;
            onEvent(map && ev.text ? { ...ev, text: unmask(ev.text) } : ev);
          },
        }).catch((err) => ({ provider: t.provider, model: t.model, text: '', error: err.message, tokens: {} }));
        if (map) {
          result.text = unmask(result.text || '');
          result.anonymized = Object.keys(map).length;
        }
        if (!result.error || ac.signal.aborted) break;
        // Já respondeu parte ou usou ferramentas (mexeu em arquivos?): não repete em outra IA, mostra o erro.
        if (partial.trim() || assistant.tools.length > toolsBefore || !RETRYABLE.test(result.error)) break;
        failures.push(`${t.modelLabel || t.provider} falhou (${clip(result.error, 120)})`);
        delete chat.sessions[t.provider];
      }
    } finally {
      this.running.delete(runId);
    }
    // Cancelado antes da primeira tentativa (ex.: durante a foto da pasta).
    if (!result) result = { provider: used.provider, model: used.model, text: '', error: 'Cancelado.', tokens: {} };

    delete assistant.pending;
    assistant.provider = used.provider;
    assistant.model = used.modelLabel || result.model;
    assistant.modelId = result.model;
    assistant.text = result.text || '';
    assistant.error = ac.signal.aborted ? 'Cancelado.' : result.error || null;
    assistant.tokens = result.tokens || {};
    if (failures.length) assistant.switched = failures;
    if (result.anonymized) assistant.anonymized = result.anonymized;
    if (result.sessionId && used.provider !== 'ollama') chat.sessions[used.provider] = { id: result.sessionId, syncedUpTo: chat.messages.length };

    try {
      if (!assistant.error || assistant.text) this.usage.record(used.provider, result.model || used.model || used.provider, result.tokens || {}, 'chat');
      if (used.provider === 'codex') this.usage.refreshCodexLimits();
    } catch { /* contabilidade é secundária */ }

    if (before) {
      const after = await this.#snapshot(chat.cwd, `depois: ${clip(label || text, 80)}`);
      if (after) {
        const files = await this.checkpoints.changes(chat.cwd, before, after).catch(() => []);
        if (files.length) assistant.checkpoint = { cwd: chat.cwd, before, after, files: files.slice(0, 50), count: files.length };
      }
    }

    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('usage:update', {});
    this.emit('chat:done', { chatId, runId, message: assistant, running: this.isRunning(chatId) });
    return assistant;
  }

  // ---------- Ohara-AI: o modelo local lê e faz coisas no PC ----------

  #forOharaAi(text) {
    const config = this.getConfig();
    if (config.ollama?.enabled === false || config.providers?.ollama?.enabled === false || config.ollama?.oharaAi === false) return false;
    const av = this.getAvailable();
    const ready = av?.has ? av.has('ollama') : Array.isArray(av) && av.includes('ollama');
    return ready && (asksPcAction(text) || asksPcInfo(text));
  }

  #actionCtx() {
    if (this.actionCtxOverride) return this.actionCtxOverride;
    return {
      schedule: (texto, ms) => {
        const t = setTimeout(() => this.notify?.('Lembrete da Ohara', texto), ms);
        t.unref?.();
        return Date.now() + ms;
      },
    };
  }

  /**
   * Responde com a Ohara-AI. Devolve null (sem deixar rastro na conversa) quando ela não sabe ou o modelo local
   * falhou antes de fazer qualquer coisa: aí o pedido segue para as outras IAs, pelo roteador de sempre.
   */
  async #oharaAi(chat, text, clientRunId) {
    const config = { ...this.getConfig(), edition: 'guia' };
    const userIndex = chat.messages.length;
    const titleBefore = chat.title;
    chat.messages.push({ role: 'user', text, images: [], at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip(text.replace(/\s+/g, ' '), 48);
    const runId = clientRunId || crypto.randomUUID();
    const action = asksPcAction(text);
    const route = {
      provider: 'ollama',
      model: config.ollama?.model,
      modelLabel: 'Ohara-AI (local)',
      category: 'pc',
      label: action ? 'Ohara-AI: ação no PC' : 'Ohara-AI: consulta do PC',
      reasons: [action ? 'ação no PC: a Ohara-AI faz sozinha (o arriscado pede confirmação)' : 'consulta do PC: a Ohara-AI lê sozinha'],
    };
    const assistant = { id: runId, role: 'assistant', text: '', provider: 'ollama', model: route.modelLabel, route, tools: [], pending: true, at: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId: chat.id, runId, route });

    const ac = new AbortController();
    this.running.set(runId, { chatId: chat.id, ac });
    const onEvent = (ev) => {
      if (ev.kind === 'tool') assistant.tools.push(ev.text);
      this.emit('chat:event', { chatId: chat.id, runId, ...ev });
    };
    let result;
    try {
      result = await this.localChat({
        config,
        history: chat.messages.slice(0, userIndex),
        text,
        signal: ac.signal,
        onDelta: (t) => onEvent({ kind: 'delta', text: t }),
        onStep: (t) => onEvent({ kind: 'tool', text: t }),
        actionCtx: this.#actionCtx(),
      });
    } catch (err) {
      result = { text: '', error: ac.signal.aborted ? 'Cancelado.' : err.message };
    } finally {
      this.running.delete(runId);
    }
    const didSomething = !!result?.pending?.length || !!result?.done?.length;
    if (!ac.signal.aborted && (result?.consult || (result?.error && !didSomething))) {
      chat.messages.splice(userIndex, 2);
      chat.title = titleBefore;
      this.chats.save();
      return null;
    }
    delete assistant.pending;
    assistant.text = result.text || '';
    assistant.error = ac.signal.aborted ? 'Cancelado.' : result.error || null;
    assistant.tokens = result.tokens || {};
    if (result.pending?.length) {
      assistant.pcActions = toPending(result.pending);
      if (!/confirm/i.test(assistant.text)) assistant.text = assistant.text ? assistant.text + '\n\n' + askLine(assistant.pcActions) : askLine(assistant.pcActions);
    }
    try {
      this.usage.record('ollama', config.ollama?.model || 'ollama', assistant.tokens, 'chat');
    } catch { /* contabilidade é secundária */ }
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('usage:update', {});
    this.emit('chat:done', { chatId: chat.id, runId, message: assistant, running: this.isRunning(chat.id) });
    return assistant;
  }

  #findAction(chatId, messageId, index = 0) {
    const chat = this.get(chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    const action = msg?.pcActions?.[index];
    if (!action) throw new Error('Ação não encontrada.');
    return { chat, msg, action };
  }

  /** Botão "Confirmar": roda o que ficou guardado na mensagem (a tela só diz qual item). */
  async confirmPcAction(chatId, messageId, index = 0) {
    const { chat, msg, action } = this.#findAction(chatId, messageId, index);
    const onChange = () => {
      chat.updatedAt = Date.now();
      this.chats.save();
      this.emit('chat:message', { chatId, message: msg });
    };
    return runPending(action, defaultCtx(this.#actionCtx()), { onChange });
  }

  cancelPcAction(chatId, messageId, index = 0) {
    const { msg, action } = this.#findAction(chatId, messageId, index);
    if (action.status !== 'pending') return action;
    action.status = 'cancelled';
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    return action;
  }

  // "confirma"/"pode"/"sim" faz as ações pendentes da última resposta; "cancela"/"não" descarta. Sem IA.
  async #tryActionReply(chat, text, clientRunId) {
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant');
    const onChange = () => {
      this.chats.save();
      this.emit('chat:message', { chatId: chat.id, message: last });
    };
    const reply = await replyToPending(last, text, defaultCtx(this.#actionCtx()), { onChange });
    if (!reply) return null;
    const runId = clientRunId || crypto.randomUUID();
    const route = { provider: 'local', model: 'ação local', modelLabel: 'ação local', category: 'pc', label: 'Ação no PC', reasons: [reply.intent === 'cancel' ? 'cancelou a ação pendente, sem IA' : 'confirmou a ação pendente, sem IA'] };
    chat.messages.push({ role: 'user', text, images: [], at: Date.now() });
    const assistant = { id: runId, role: 'assistant', text: reply.lines.join('\n'), provider: 'local', model: 'ação local', route, tools: [], at: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId: chat.id, runId, route });
    this.emit('chat:done', { chatId: chat.id, runId, message: assistant, running: this.isRunning(chat.id) });
    return assistant;
  }

  /** Desfaz o que a IA mexeu nos arquivos naquela resposta. */
  async undo(chatId, messageId) {
    const chat = this.get(chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    const cp = msg?.checkpoint;
    if (!cp) throw new Error('Esta resposta não mexeu em arquivos.');
    if (cp.undone) throw new Error('Já foi desfeito.');
    if (this.running.size && [...this.running.values()].some((r) => r.chatId === chatId)) throw new Error('Espere a IA terminar antes de desfazer.');
    let r;
    try {
      r = await this.checkpoints.undo(cp.cwd, cp.before, cp.after);
    } catch (err) {
      if (!err.safety) throw err;
      // Desfez só uma parte: guarda a foto de segurança para o "Refazer" voltar ao estado de antes.
      cp.undone = Date.now();
      cp.safety = err.safety;
      this.chats.save();
      this.emit('chat:message', { chatId, message: msg });
      throw new Error(`Não consegui desfazer tudo (${err.message}). Feche o programa que está usando o arquivo e tente de novo, ou use "Refazer" para voltar ao estado de antes.`);
    }
    cp.undone = Date.now();
    cp.safety = r.safety;
    delete chat.sessions[msg.provider]; // a IA não sabe que os arquivos voltaram: começa uma sessão nova
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    return { files: r.files.length };
  }

  /** Refaz o que o "Desfazer" voltou. */
  async redo(chatId, messageId) {
    const chat = this.get(chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    const cp = msg?.checkpoint;
    if (!cp?.undone || !cp.safety) throw new Error('Nada para refazer.');
    // "safety" é a foto de logo antes do desfazer: volta para ela os arquivos que o desfazer mudou.
    const now = await this.checkpoints.snapshot(cp.cwd, 'antes de refazer');
    await this.checkpoints.undo(cp.cwd, cp.safety, now);
    delete cp.undone;
    delete cp.safety;
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    return { ok: true };
  }

  projectName(chat) {
    return chat?.cwd ? path.basename(chat.cwd) : null;
  }
}

module.exports = { GuideAgent, systemPrompt, RETRYABLE };
