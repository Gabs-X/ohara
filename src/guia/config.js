// Configuração padrão da edição Guia: a Ohara para quem não é desenvolvedor.
// Sem caminhos de um PC específico e sem as integrações pessoais (reuniões, WhatsApp, Slack, Orca, entrevista).
// O usuário pode sobrescrever qualquer chave em %APPDATA%\Ohara Guia\config.json.
const os = require('os');
const path = require('path');

function guiaDefaults(home = os.homedir()) {
  return {
    edition: 'guia',
    userName: '', // perguntado em "Primeiros passos"
    onboarded: false,
    // Onde ficam os projetos criados pela Ohara ("Novo projeto").
    projectsDir: path.join(home, 'Documents', 'Projetos Ohara'),
    defaultCwd: home,
    workspaceRoot: '', // sem pasta extra para os agentes
    selfRepo: '', // a edição Guia não se altera sozinha

    hotkeys: { toggle: 'CommandOrControl+Shift+Space' },

    claude: {
      bin: 'claude',
      configDir: '',
      permissionMode: 'auto', // o próprio Claude Code decide o que é seguro rodar sozinho
      chrome: false,
      models: { rapido: 'haiku', equilibrado: 'sonnet', profundo: 'opus' },
    },
    codex: {
      enabled: true,
      model: '',
      sandbox: 'workspace-write', // só escreve dentro da pasta do projeto
      developmentPermissions: 'restricted',
      developmentPreflight: false,
    },
    gemini: { bin: 'gemini', approvalMode: 'auto_edit' },
    ollama: {
      enabled: true,
      url: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b', // cabe em PCs comuns (~5 GB)
      timeoutSec: 180,
      contextTokens: 8192,
    },

    // IAs: enabled liga/desliga; tiers.<nível>.model troca o modelo; dailyRequests (Gemini) é a cota estimada do dia.
    providers: {},

    // Orquestração: economia (padrão), equilibrio ou qualidade; prefer: { tipo: 'claude' } força uma IA para um tipo.
    orchestration: { mode: 'economia', prefer: {} },

    safety: {
      checkpoints: true, // foto da pasta antes e depois de cada pedido (botão Desfazer)
      explain: true, // fim de cada tarefa com "O que eu fiz", sem jargão
    },
  };
}

module.exports = { guiaDefaults };
