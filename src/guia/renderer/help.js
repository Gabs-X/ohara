/* global state, setView, esc, newChat, autosize, previewRoute, newPlanForm */
// Tela "O que eu faço": tudo o que a Ohara Guia sabe fazer, em linguagem simples, com exemplos para experimentar.
// Cada exemplo: { ask: 'texto que vai para o campo da conversa' } ou { view: 'tela' } ou { plan: true }.

const HELP_SECTIONS = [
  {
    id: 'conversa', icon: '💬', title: 'Conversar e pedir coisas',
    text: 'Peça do seu jeito, como pediria a uma pessoa. A Ohara responde perguntas, escreve textos, pesquisa na internet, analisa prints e imagens e mexe em arquivos quando você escolhe um projeto.',
    items: [
      'Perguntas rápidas, explicações e opiniões',
      'Escrever e revisar textos: e-mails, propostas, posts, contratos simples',
      'Pesquisar na internet e resumir o que achou',
      'Ver um print da tela (🖥️) ou uma imagem (🖼️) e explicar o que tem nela',
      'Criar sites, planilhas, automações e pequenos programas dentro de um projeto',
    ],
    try: [
      { label: 'Escrever um e-mail', ask: 'Escreva um e-mail curto e educado cobrando um cliente que está com o pagamento atrasado há 10 dias.' },
      { label: 'Pesquisar', ask: 'Pesquise as principais diferenças entre MEI e ME e me explique em tópicos simples.' },
      { label: 'Explicar um termo', ask: 'O que é uma API? Explique como se eu nunca tivesse programado.' },
    ],
  },
  {
    id: 'ohara-ai', icon: '✨', title: 'Ohara-AI: fazer coisas no seu PC',
    text: 'A Ohara-AI é a IA grátis que roda no seu computador. Além de conversar, ela lê e faz coisas no PC, e os seus dados não saem dele. Baixe em "Primeiros passos" (precisa do Ollama).',
    items: [
      'Volume e música: aumentar, abaixar, mudo, pausar, próxima faixa',
      'Print da tela, copiar um texto, lembretes e timers com aviso na tela, bloquear a tela',
      'Achar arquivos pelo nome, ler PDF e Word, abrir pastas e telas de configuração do Windows',
      'Ver espaço em disco, memória, programas abertos e instalados, internet',
      'Fechar programas, mover, renomear ou mandar para a Lixeira, limpar arquivos temporários, desligar ou reiniciar',
      'O que é arriscado (fechar, mover, apagar, limpar, desligar) aparece com o botão "Confirmar" e só acontece depois do seu clique ou de você responder "confirma"',
      'Nunca mexe nas pastas do Windows nem fecha programas do sistema',
    ],
    try: [
      { label: 'Baixar a Ohara-AI', view: 'health' },
      { label: 'Abaixar o volume', ask: 'abaixa o volume' },
      { label: 'Achar um arquivo', ask: 'acha o arquivo contrato nos downloads' },
      { label: 'Marcar um lembrete', ask: 'me lembra de beber água em 30 minutos' },
    ],
  },
  {
    id: 'orquestra', icon: '🤖', title: 'Escolher a IA certa (e economizar)',
    text: 'Você não precisa saber qual IA usar. A cada pedido, a Ohara olha o que ele exige e escolhe entre as suas IAs a de melhor custo-benefício naquele momento.',
    items: [
      'Usa Claude, ChatGPT/Codex, Gemini e uma IA grátis no seu PC (a que estiver pronta)',
      'Pergunta simples vai para a IA mais barata; planejamento e tarefas difíceis vão para um modelo forte',
      'Reparte o trabalho: a IA que já gastou mais da cota perde a vez',
      'Se uma IA falhar ou ficar sem cota, a próxima assume sozinha, levando o assunto da conversa',
      'Passe o mouse em "por quê?" em cada resposta para ver o motivo da escolha',
      'Três modos em "Uso e economia": Economia (padrão), Equilíbrio e Qualidade',
      'Quer escolher você mesmo? Use a lista ao lado do botão Enviar',
    ],
    try: [{ label: 'Ver uso e economia', view: 'usage' }],
  },
  {
    id: 'projetos', icon: '📂', title: 'Trabalhar em projetos',
    text: 'Um projeto é uma pasta só para uma ideia (um site, uma planilha, um robô). A IA trabalha só dentro dela.',
    items: [
      '"➕ Novo projeto" na lista do topo da conversa cria a pasta para você',
      'Também dá para escolher qualquer pasta que já existe',
      '"▶ Abrir meu projeto" mostra o resultado: site no navegador; programas num terminal',
      '"📁" abre a pasta do projeto no Windows',
      'Sem projeto escolhido, a Ohara só conversa e não cria arquivos',
    ],
    try: [{ label: 'Criar um site simples', ask: 'Crie um site de uma página para apresentar o meu trabalho, com uma seção de serviços e um botão de contato. Use só HTML e CSS para eu abrir direto no navegador.' }],
  },
  {
    id: 'planos', icon: '🗺️', title: 'Planejar uma ideia',
    text: 'Para ideias maiores, o Planejador transforma o que você descreveu num plano em etapas, com o que precisa decidir e os cuidados.',
    items: [
      'O plano é feito uma vez por um modelo forte',
      'Cada etapa é feita depois, uma de cada vez, pela IA mais barata que resolve aquele tipo de etapa',
      'Você confere cada etapa e marca como feita, pula ou reabre',
      'Pode pedir ajustes no plano; o que já foi feito fica guardado',
      'Cada plano tem a sua própria conversa',
    ],
    try: [{ label: 'Planejar uma ideia', plan: true }],
  },
  {
    id: 'seguranca', icon: '🛟', title: 'Desfazer e segurança',
    text: 'Antes de cada pedido num projeto, a Ohara guarda uma foto da pasta. Se não gostar do que a IA fez, é só desfazer.',
    items: [
      '"↶ Desfazer" volta só os arquivos que a IA mexeu naquele pedido (o que você mudou à mão fica)',
      '"↷ Refazer" traz de volta, se você se arrepender',
      '"Ver arquivos" mostra o que foi criado, alterado ou apagado',
      'As IAs não mexem fora da pasta do projeto e pedem confirmação antes de qualquer coisa difícil de desfazer (apagar muito, instalar, publicar)',
      '"Acesso total" tira essas travas: deixe desligado, a não ser que saiba o que está fazendo',
      'No fim de cada tarefa, ela explica "O que eu fiz" e "Como conferir", sem jargão',
    ],
  },
  {
    id: 'ferramentas', icon: '🧰', title: 'Ferramentas locais (grátis e privadas)',
    text: 'Rodam na IA do seu PC: não gastam cota e o conteúdo não sai do computador. Precisam do Ollama aberto (veja "Primeiros passos").',
    items: [
      'Documentos: escolha pastas e pergunte sobre elas ("quais contratos têm multa acima de 10%?"); a resposta cita o arquivo',
      'Extrair dados: partes, CPF/CNPJ, valores, prazos e nº do processo de um PDF ou Word',
      'Triagem: cole e-mails, mensagens ou intimações e receba a lista por urgência, área, cliente e prazo',
      'Documento por foto: lê RG, CNH, comprovantes e páginas escaneadas',
      'Diagnóstico de erro: cole uma mensagem de erro e veja a causa provável e o que fazer',
    ],
    try: [{ label: 'Abrir as ferramentas', view: 'tools' }],
  },
  {
    id: 'privacidade', icon: '🕶️', title: 'Privacidade',
    text: 'Ligue em Ferramentas → Privacidade. Antes de um pedido sair para Claude, Codex ou Gemini, os dados pessoais viram marcadores e voltam ao normal na resposta.',
    items: [
      'Troca CPF, CNPJ, nº de processo, OAB, e-mail, telefone, CEP, nomes e endereços',
      'Se a proteção falhar, nada é enviado',
      'A resposta mostra "🕶️ dados protegidos" quando isso aconteceu',
      'Atenção: os arquivos que a IA abre dentro do projeto não passam por essa proteção',
    ],
  },
  {
    id: 'uso', icon: '📊', title: 'Acompanhar o uso',
    text: 'Veja quanto cada IA já gastou da cota e quanto a escolha automática economizou.',
    items: [
      'Cota de cada IA na barra lateral (Claude e Codex com o valor real; Gemini estimado pelos pedidos do dia)',
      'Economia da semana e do mês, comparada com mandar tudo para o Claude Sonnet',
      'Pedidos por dia e por IA',
    ],
    try: [{ label: 'Ver uso e economia', view: 'usage' }],
  },
  {
    id: 'app', icon: '⚙️', title: 'No dia a dia',
    text: 'A Ohara fica nos ícones ao lado do relógio, pronta para abrir.',
    items: [
      'Atalho Ctrl+Shift+Espaço mostra ou esconde a janela',
      'Fechar a janela só esconde; para sair, use "Sair" no ícone ao lado do relógio',
      '"Primeiros passos" verifica se está tudo instalado e logado, e conserta com um clique',
      'Ela se atualiza sozinha quando sai versão nova (no app instalado)',
      'As conversas e os planos ficam salvos no seu PC',
      'Apagar conversas: o ✕ ao lado de cada uma (pede um segundo clique), "🗑 Apagar" na conversa aberta ou "Selecionar" para apagar várias de uma vez',
    ],
    try: [{ label: 'Verificar se está tudo certo', view: 'health' }],
  },
];

const HELP_LIMITS = [
  'Não mexe em nada fora da pasta do projeto escolhida.',
  'Não publica, não paga nada e não instala programas sem a sua confirmação.',
  'A Ohara-AI (a IA grátis do seu PC) só faz as ações da lista acima, e as arriscadas só depois do seu "Confirmar". Ela não pesquisa na internet.',
  'Não envia mensagens, e-mails ou WhatsApp por você: ela escreve, você envia.',
  'As IAs podem errar. Confira o resultado, principalmente valores, prazos e dados de clientes.',
];

function helpTry(t) {
  if (t.view) return setView(t.view);
  if (t.plan) { setView('plans'); return newPlanForm(); }
  if (t.ask) {
    newChat();
    setView('chat');
    const input = document.querySelector('#input');
    input.value = t.ask;
    autosize();
    previewRoute();
    input.focus();
  }
}

function renderHelp(filter = '') {
  const body = document.querySelector('#help-body');
  const q = filter.trim().toLowerCase();
  const ready = (state.providers || []).filter((p) => p.ready).map((p) => p.label);
  const match = (s) => !q || [s.title, s.text, ...s.items].join(' ').toLowerCase().includes(q);
  const sections = HELP_SECTIONS.filter(match);
  body.innerHTML = `
    <div class="card help-intro">
      <h2>👋 Eu sou a Ohara. Veja tudo o que eu faço.</h2>
      <p>Eu junto as suas IAs num lugar só, escolho a mais barata que resolve cada pedido, guardo um ponto de restauração antes de mexer nos seus arquivos e explico o que fiz sem jargão.</p>
      <p class="muted small">${ready.length ? `IAs prontas agora: <b>${esc(ready.join(', '))}</b>.` : 'Nenhuma IA pronta ainda: comece por "Primeiros passos".'}</p>
      <input type="text" id="help-q" placeholder="🔎 Procurar (ex.: desfazer, contrato, cota)" value="${esc(filter)}" />
      <nav class="help-index">${HELP_SECTIONS.map((s) => `<a href="#help-${s.id}">${s.icon} ${esc(s.title)}</a>`).join('')}</nav>
    </div>
    ${sections.map((s) => `
      <div class="card help-sec" id="help-${s.id}">
        <h2>${s.icon} ${esc(s.title)}</h2>
        <p>${esc(s.text)}</p>
        <ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        ${s.try?.length ? `<div class="row">${s.try.map((t, i) => `<button class="btn small" data-try="${s.id}:${i}">▶ ${esc(t.label)}</button>`).join('')}</div>` : ''}
      </div>`).join('') || '<p class="muted">Nada encontrado. Tente outra palavra.</p>'}
    ${!q ? `<div class="card help-sec"><h2>🚫 O que eu não faço</h2><ul>${HELP_LIMITS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}`;

  const input = body.querySelector('#help-q');
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    renderHelp(input.value);
    const again = document.querySelector('#help-q');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  body.querySelectorAll('.help-index a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    body.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  body.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => {
    const [id, i] = b.dataset.try.split(':');
    helpTry(HELP_SECTIONS.find((s) => s.id === id).try[Number(i)]);
  }));
}
