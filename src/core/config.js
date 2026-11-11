// Configuração padrão. O usuário pode sobrescrever qualquer chave em
// %APPDATA%/Ohara/config.json (o app cria o arquivo na primeira execução).

const DEFAULT_CONFIG = {
  // Pasta padrão de trabalho dos agentes.
  workspaceRoot: 'C:\\repositorios',
  defaultCwd: 'C:\\Users\\gabri',
  // Código-fonte da própria Ohara: onde ela se altera quando você aceita uma melhoria.
  selfRepo: 'C:\\repositorios\\Projetos-Pessoais\\ohara',
  // Onde salvar arquivos gerados para você (exportações de reunião etc.).
  outputDir: 'C:\\Users\\gabri\\Claude\\Ohara',

  hotkeys: {
    toggle: 'CommandOrControl+Space', // mostra/esconde a janela principal
    quick: 'Alt+Space', // janela rápida
    clipboard: 'CommandOrControl+Alt+Space', // janela rápida com o conteúdo copiado
    fixText: 'CommandOrControl+Alt+C', // corrige o texto selecionado em qualquer app e cola no lugar
    voice: '', // fala → texto (Whisper)
  },

  claude: {
    bin: 'claude',
    configDir: '', // pasta de login do Claude Code; vazio = ~/.claude-pessoal se existir
    // "auto" = o próprio Claude Code decide com classificador de segurança.
    // "bypassPermissions" = acesso total (ative no app só quando quiser).
    permissionMode: 'auto',
    // Extensão Claude in Chrome nas sessões (ex.: /vagas conferir vagas e se candidatar no LinkedIn logado).
    chrome: true,
    models: {
      rapido: 'haiku',
      equilibrado: 'sonnet',
      profundo: 'opus',
    },
  },

  codex: {
    // Desligado: a Ohara não usa o Codex em nada (chat, funções automáticas, cota). Liga em Ajustes.
    enabled: false,
    // Vazio = usa o modelo padrão configurado no ~/.codex/config.toml.
    model: '',
    sandbox: 'workspace-write',
    developmentPermissions: 'restricted', // restricted | full; apenas no selfRepo
    developmentPreflight: true,
  },

  // Limites de uso (0 a 1) que mudam o roteamento do chat.
  quota: {
    claudeDowngradeAt: 0.7, // acima disso, opus vira sonnet
    claudeAvoidAt: 0.9, // acima disso, tarefas vão para o Codex quando possível
    codexAvoidAt: 0.9, // acima disso, tarefas de código voltam para o Claude
  },

  // Orçamento das funções automáticas (segundo plano): acima destes limites elas
  // trocam de IA e, se as duas estiverem altas, esperam a janela renovar.
  budgets: {
    backgroundClaude: 0.7,
    backgroundCodex: 0.85,
  },

  // Modelo e prioridade de cada função automática.
  // model: rapido | equilibrado | profundo (ou um id); provider: auto | claude | codex
  features: {
    meetings: { background: true, model: 'equilibrado', effort: 'medium', provider: 'auto' },
    briefing: { background: true, model: 'rapido', effort: 'low', provider: 'auto' },
    busca: { background: false, model: 'equilibrado', effort: 'medium', provider: 'auto' },
    cobranca: { background: false, model: 'rapido', effort: 'low', provider: 'auto' },
    slack: { background: true, model: 'rapido', effort: 'low', provider: 'auto' },
    correcao: { background: false, model: 'rapido', effort: 'low', provider: 'auto' },
  },

  // Roteador que aprende com as suas trocas manuais de modelo.
  learning: {
    enabled: true,
    minVotes: 3, // quantas escolhas iguais (das últimas 5) para virar padrão
  },

  // Reuniões: transcripts salvos pelo bot após cada call.
  meetings: {
    enabled: true,
    folder: 'C:\\Users\\gabri\\Downloads\\Gutenberg',
    selfName: 'Gabriel',
    stableSeconds: 30, // espera o arquivo parar de mudar
    minUtterances: 15, // abaixo disso a reunião é ignorada (não gasta token)
    ignoreBefore: null, // "AAAA-MM-DD": não processa reuniões anteriores
    prepMinutes: 5, // aviso com a pauta antes de reuniões recorrentes
  },

  integrations: {
    // Google Agenda → Configurações → (sua agenda) → "Endereço secreto no formato iCal".
    calendarIcsUrl: '',
    github: {
      enabled: true,
      // Contas do `gh` a consultar (precisam estar logadas: gh auth login).
      accounts: ['Gabs-X'],
    },
    slack: {
      // Token de usuário (xoxp-...) de um app Slack com os escopos do README.
      token: '',
      importMentions: false,
    },
    // Mensagens para o seu próprio WhatsApp via CallMeBot (a chave fica criptografada).
    whatsapp: {
      enabled: false,
      phone: '', // com DDI, ex.: +5511999999999
      apikey: '',
      notifyMeetingTasks: false, // avisa quando uma reunião gera demandas novas para você
      confirmContacts: true, // mensagem para contato: mostra o contato achado e só envia depois que você confirmar
    },
  },

  voice: {
    commandsEnabled: false,
    ttsRate: '+15%', // velocidade da voz neural (+0% = normal)
    conversationTimeoutSec: 25, // depois de cada resposta, espera o próximo pedido por esse tempo
    ttsVoice: 'pt-BR-FranciscaNeural', // voz neural (internet); 'Microsoft Maria Desktop' = voz do Windows, offline
    speakReplies: false,
    whisperModel: 'base', // tiny | base | small (maior = mais preciso e mais lento)
    language: 'pt',
    wakeWord: false, // escuta contínua: diga "Ohara, ..." (precisa do Whisper)
    showListeningIndicator: false, // indicador flutuante, inclusive com a janela escondida
    autoSendVoice: false, // na janela rápida, envia assim que transcreve
  },
};

// Recursos desativados nesta edição, inclusive para configurações antigas.
function simplifyConfig(config) {
  config.voice.commandsEnabled = false;
  config.voice.wakeWord = false;
  config.voice.showListeningIndicator = false;
  config.voice.autoSendVoice = false;
  config.hotkeys.voice = '';
  config.integrations.whatsapp.enabled = false;
  config.integrations.whatsapp.notifyMeetingTasks = false;
  return config;
}

module.exports = { DEFAULT_CONFIG, simplifyConfig };
