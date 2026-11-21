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
    fixText: 'CommandOrControl+Shift+F8', // corrige o texto selecionado em qualquer app e cola no lugar
    voice: '', // fala → texto (Whisper)
    interview: 'CommandOrControl+Alt+E', // abre/esconde o modo entrevista
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

  // IA local via Ollama (grátis, offline, sem cota). Usada nas funções com provedor "Sempre local";
  // se o Ollama não responder, a função cai para o Claude.
  ollama: {
    enabled: true,
    url: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    timeoutSec: 180,
    contextTokens: 16384, // janela de contexto (o padrão do Ollama é pequeno para buscas em reuniões)
    embedModel: 'bge-m3', // busca por significado nos documentos (ollama pull bge-m3)
    visionModel: 'qwen2.5vl:7b', // leitura de documento por foto (ollama pull qwen2.5vl:7b)
    tools: true, // Ohara-AI consulta o PC sozinha (disco, memória, processos, navegadores, programas, rede, pastas); só leitura
    // A Ohara-AI chama o Claude no próprio chat quando o modelo local não basta e o assunto não é projeto
    // (informação atual da internet, raciocínio difícil, texto formal longo). Gasta cota; projeto continua indo ao Orca.
    claudeChat: true,
  },

  // Ferramentas locais → Documentos: pastas indexadas para a busca por significado (nada sai do PC).
  documents: {
    folders: [],
  },

  // Privacidade: antes de mandar texto para o Claude/Codex, troca CPF, CNPJ, nomes, e-mails etc. por
  // marcadores e desfaz na resposta. Os nomes são achados pelo modelo local.
  privacy: {
    anonymizeCloud: false,
    names: true, // false: só os padrões fixos (CPF, CNPJ, e-mail, telefone, CEP, OAB, nº de processo)
    keep: [], // nomes que nunca são trocados (o seu já entra sozinho)
  },

  // Orca: o chat da Ohara roda no modelo local; o que exige o Claude (código, comandos, pesquisa)
  // abre o Orca no projeto, com a branch da tarefa e o Claude já recebendo o contexto.
  orca: {
    bin: '', // vazio = %LOCALAPPDATA%\Programs\orca
    agent: 'claude',
    generalDir: 'C:/Users/gabri/Claude', // onde o Claude abre quando o pedido não cita um projeto
    // Antes de abrir o Claude no Orca, a Ohara pergunta qual conta usar. "account" é o que o Orca aceita em
    // `orca account select` (e-mail ou id; "system" = login padrão, ~/.claude). Vazio: imlaw = system;
    // pessoal = e-mail do login em ~/.claude-pessoal. Cadastre a conta no Orca com `orca account add`.
    accounts: {
      imlaw: { label: 'Claude do escritório (ImLaw)', account: '' },
      pessoal: { label: 'Claude pessoal', account: '' },
    },
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
    meetings: { background: true, model: 'equilibrado', effort: 'medium', provider: 'claude' }, // a análise de reunião é sempre no Claude
    briefing: { background: true, model: 'rapido', effort: 'low', provider: 'ollama' },
    busca: { background: false, model: 'equilibrado', effort: 'medium', provider: 'ollama' },
    cobranca: { background: false, model: 'rapido', effort: 'low', provider: 'ollama' },
    slack: { background: true, model: 'rapido', effort: 'low', provider: 'ollama' },
    correcao: { background: false, model: 'rapido', effort: 'low', provider: 'ollama' },
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
    // false: reunião nova fica "aguardando análise" e só gasta token quando você pede (botão na reunião).
    // true: cada reunião nova é analisada sozinha.
    autoAnalyze: false,
    ignoreBefore: null, // "AAAA-MM-DD": não processa reuniões anteriores
    prepMinutes: 5, // aviso com a pauta antes de reuniões recorrentes
    // Reunião longa: o modelo local condensa a transcrição antes e só o resumo vai para o Claude.
    localPreSummary: true,
    preSummaryMinChars: 40000, // abaixo disso vai a transcrição inteira
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

  // Modo entrevista (bandeja → Modo entrevista ou Ctrl+Alt+E): ouve o áudio do PC, transcreve em inglês
  // e mostra tópicos de resposta para cada pergunta. Currículo e vaga ficam em %APPDATA%\Ohara\entrevista\contexto.md.
  interview: {
    whisperModel: 'small', // small acerta bem o inglês; base é mais rápido e erra mais
    // Subpasta da pasta do Whisper com outra build do whisper.cpp. Vazio = "bin" (CPU).
    // "bin-cuda" = build CUDA do release oficial (whisper-bin-win-cuda-*-x64.zip): roda na placa NVIDIA, bem mais rápido.
    whisperBinDir: '',
    mergeWindowMs: 3000, // fala que começa até 3 s depois da anterior = continuação da mesma pergunta
    model: 'haiku', // modelo do Claude para os tópicos (rápido)
    minWords: 4, // fala menor que isso, sem cara de pergunta, não chama a IA
    historyLines: 20, // falas anteriores (suas e de quem entrevista) mandadas junto, para entender perguntas de continuação
    captureMic: true, // também transcreve o seu microfone, para a transcrição salva ter as suas respostas
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
