/* global central, esc, toast, callSafe */
// Tela "Ajustes": integrações (agenda, GitHub, Slack), voz, atalhos, reuniões e geral.

let settingsUpdOff = null;

// Texto do estado da atualização. `checked`: o usuário acabou de pedir a verificação ("idle" = já está na última).
function updateText(s, checked) {
  switch (s?.status) {
    case 'unsupported': return 'A atualização automática só funciona na Ohara instalada (não no portátil nem em desenvolvimento).';
    case 'checking': return 'Procurando versão nova…';
    case 'downloading': return `Versão ${s.version} encontrada. Baixando${s.percent ? ` (${s.percent}%)` : ''}… o botão para instalar aparece quando terminar.`;
    case 'ready': return `Versão ${s.version} baixada e pronta para instalar.`;
    case 'error': return `Não consegui verificar: ${s.message || 'erro desconhecido'}. Confira a internet e tente de novo.`;
    default: return checked ? 'Você já está na versão mais recente.' : '';
  }
}

async function renderSettings() {
  const [cfg, hk, cal, sl, login, version, upd] = await Promise.all([
    central.getConfig(),
    central.hotkeyStatus(),
    central.calendarStatus(),
    central.slackStatus(),
    central.loginItem(),
    central.appVersion().catch(() => '?'),
    central.updateState().catch(() => ({ status: 'error', message: 'não consegui ler o estado da atualização' })),
  ]);
  const body = document.getElementById('settings-body');
  const ok = (good, text) => `<span class="status ${good ? 'good' : 'bad'}">${good ? '●' : '○'} ${esc(text)}</span>`;
  const I = cfg.integrations;

  body.innerHTML = `
  <div class="settings">
    <section class="section">
      <h2>Codex</h2>
      <label class="check"><input id="codex-on" type="checkbox" ${cfg.codex?.enabled === true ? 'checked' : ''}> Usar o Codex (conta logada no "codex" deste PC)</label>
      <p class="muted small">Desligado, tudo vai para o Claude: chat, funções automáticas e a reserva quando a cota do Claude aperta. A Ohara também para de ler as sessões em ~/.codex.</p>
    </section>
    <section class="section">
      <h2>Desenvolvimento e publicação</h2>
      <p class="muted small">Permissões do Codex ao trabalhar no código da Ohara. Valem nas próximas execuções; outras pastas mantêm sua configuração habitual.</p>
      <label>Acesso ao desenvolver a Ohara<select id="dev-permissions">
        <option value="restricted" ${cfg.codex?.developmentPermissions !== 'full' ? 'selected' : ''}>Restrito ao ambiente de trabalho</option>
        <option value="full" ${cfg.codex?.developmentPermissions === 'full' ? 'selected' : ''}>Acesso completo ao PC e à rede</option>
      </select></label>
      <p class="muted small">Acesso completo permite ao Codex executar comandos com os acessos da sua conta, inclusive fora do projeto. Políticas do sistema e permissões do Windows ainda se aplicam. Ações destrutivas e publicações continuam dependendo do seu pedido.</p>
      <label class="check"><input id="dev-preflight" type="checkbox" ${cfg.codex?.developmentPreflight !== false ? 'checked' : ''}> Verificar acessos no início das tarefas no código da Ohara</label>
      <div class="row"><button class="btn small-btn" id="dev-save">Salvar permissões</button><button class="btn small-btn" id="dev-check">Verificar acessos agora</button></div>
      <p class="muted small">A verificação abaixo roda pelo aplicativo e abre uma janela de teste por alguns segundos. A sessão do Codex pode ter restrições adicionais, verificadas no início da tarefa.</p>
      <p id="dev-result" class="small pre-line" role="status"></p>
    </section>
    <section class="section">
      <h2>📅 Agenda</h2>
      <p class="muted small">Google Agenda → ⚙️ Configurações → clique na sua agenda → <b>Endereço secreto no formato iCal</b>. Com ela, a aba Hoje mostra suas reuniões e a pauta chega ${cfg.meetings.prepMinutes} min antes. O endereço fica criptografado neste PC.</p>
      <div class="row"><input id="cal-url" type="password" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" value="${I.calendarIcsUrlSet ? '••••••' : ''}"><button class="btn small-btn" id="cal-save">Salvar</button>${I.calendarIcsUrlSet ? '<button class="btn small-btn" id="cal-clear">Remover</button>' : ''}</div>
      <p>${cal.configured ? (cal.error ? ok(false, `erro: ${cal.error}`) : ok(true, `${cal.count} evento(s) nos próximos 8 dias · ${cal.today.length} hoje`)) : ok(false, 'não conectada')}</p>
    </section>

    <section class="section">
      <h2>🔀 GitHub</h2>
      <p class="muted small">Usa o <code>gh</code> já logado neste PC. Mostra na aba Hoje as PRs esperando seu review e as suas abertas.</p>
      <label class="check"><input type="checkbox" id="gh-on" ${I.github.enabled ? 'checked' : ''}> Ligado</label>
      <label>Contas do gh (separe por vírgula)<div class="row"><input id="gh-accounts" value="${esc(I.github.accounts.join(', '))}"><button class="btn small-btn" id="gh-save">Salvar</button><button class="btn small-btn" id="gh-test">Testar</button></div></label>
      <p id="gh-result" class="small"></p>
    </section>

    <section class="section">
      <h2>💬 Slack</h2>
      <p class="muted small">Precisa de um <b>token de usuário</b> (xoxp-…) de um app Slack seu com os escopos <code>search:read</code>, <code>users:read</code>, <code>im:write</code> e <code>chat:write</code>. Com ele a Ohara envia cobranças por DM e importa menções como demandas. O token fica criptografado neste PC.</p>
      <div class="row"><input id="sl-token" type="password" placeholder="xoxp-..." value="${I.slack.tokenSet ? '••••••' : ''}"><button class="btn small-btn" id="sl-save">Salvar</button>${I.slack.tokenSet ? '<button class="btn small-btn" id="sl-clear">Remover</button>' : ''}</div>
      <p>${!sl.configured ? ok(false, 'não conectado') : sl.ok ? ok(true, `conectado como ${sl.name} (${sl.team})`) : ok(false, sl.error)}</p>
      ${sl.ok ? '<button class="btn small-btn" id="sl-import">Importar menções agora</button> <span class="muted small">Para importar sozinho, ligue o agendamento “Importar menções do Slack” em Automações.</span>' : ''}
    </section>

    <section class="section">
      <h2>Leitura em voz alta</h2>
      <label class="check"><input type="checkbox" id="w-speak" ${cfg.voice.speakReplies ? 'checked' : ''}> Ler respostas em voz alta</label>
      <label>Voz da Ohara<div class="row">
        <select id="w-tts">${[
          ['pt-BR-FranciscaNeural', 'Francisca · feminina, natural'],
          ['pt-BR-AntonioNeural', 'Antonio · masculina, natural'],
          ['Microsoft Maria Desktop', 'Maria · voz do Windows (robótica, funciona sem internet)'],
        ].map(([v, l]) => `<option value="${v}" ${cfg.voice.ttsVoice === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn small-btn" id="w-tts-test">▶ Ouvir</button>
      </div></label>
      <p class="muted small">As vozes naturais são as mesmas do “Ler em voz alta” do Edge: o texto vai para o serviço de fala da Microsoft. Sem internet, ela usa a voz do Windows.</p>
    </section>

    <section class="section">
      <h2>⌨️ Atalhos globais</h2>
      <p class="muted small">Formato do Electron: <code>CommandOrControl+Alt+V</code>, <code>Alt+Space</code>… Deixe vazio para desligar um atalho.</p>
      <p class="muted small">Corrigir texto: selecione o que escreveu em qualquer app e aperte o atalho. A Ohara copia, corrige ortografia, acentos e pontuação mantendo o seu jeito e cola no lugar. O texto selecionado vai para a IA (Claude ou Codex).</p>
      <table class="table compact"><tbody>${[
        ['toggle', 'Mostrar/esconder a Ohara'],
        ['quick', 'Janela rápida'],
        ['clipboard', 'Janela rápida com o que você copiou'],
        ['fixText', 'Corrigir o texto selecionado (em qualquer app)'],
      ].map(([k, l]) => `<tr><td>${l}</td><td><input data-hk="${k}" value="${esc(cfg.hotkeys[k] || '')}"></td><td>${hk[k] ? ok(hk[k] === 'ok', hk[k]) : ''}</td></tr>`).join('')}</tbody></table>
      <button class="btn small-btn" id="hk-save">Salvar atalhos</button>
    </section>

    <section class="section">
      <h2>📋 Reuniões</h2>
      <label>Pasta dos transcripts<div class="row"><input id="m-folder" value="${esc(cfg.meetings.folder)}"><button class="btn small-btn" id="m-pick">Escolher…</button></div></label>
      <div class="row wrap">
        <label>Mínimo de falas<input id="m-min" type="number" min="1" value="${cfg.meetings.minUtterances}"></label>
        <label>Aviso de pauta (min antes)<input id="m-prep" type="number" min="0" max="60" value="${cfg.meetings.prepMinutes}"></label>
        <label>Ignorar reuniões antes de<input id="m-ignore" type="date" value="${esc(cfg.meetings.ignoreBefore || '')}"></label>
      </div>
      <label class="check"><input type="checkbox" id="m-on" ${cfg.meetings.enabled ? 'checked' : ''}> Monitorar a pasta</label>
      <label class="check"><input type="checkbox" id="m-auto" ${cfg.meetings.autoAnalyze ? 'checked' : ''}> Analisar automaticamente cada reunião nova (gasta cota do Claude; desligado, você pede a análise na reunião)</label>
      <button class="btn small-btn" id="m-save">Salvar</button>
    </section>

    <section class="section">
      <h2>🔄 Atualizações</h2>
      <p class="muted small">Versão instalada: <b>v${esc(version)}</b>. A Ohara procura versões novas sozinha ao abrir e a cada 4 horas; aqui você confere na hora.</p>
      <div class="row"><button class="btn small-btn" id="upd-check" ${upd.status === 'unsupported' ? 'disabled' : ''}>Verificar atualizações</button><button class="btn small-btn" id="upd-install" ${upd.status === 'ready' ? '' : 'hidden'}>Reiniciar e atualizar</button></div>
      <p id="upd-result" class="small" role="status">${esc(updateText(upd, false))}</p>
    </section>

    <section class="section">
      <h2>🖥️ Geral</h2>
      <label class="check"><input type="checkbox" id="g-login" ${login.enabled ? 'checked' : ''} ${login.available ? '' : 'disabled'}> Iniciar com o Windows (escondida na bandeja)${login.available ? '' : ' <span class="muted small">— só no app instalado</span>'}</label>
      <label>Pasta para arquivos gerados<input id="g-out" value="${esc(cfg.outputDir)}"></label>
      <label>Raiz dos repositórios<input id="g-root" value="${esc(cfg.workspaceRoot)}"></label>
      <label>Pasta de login do Claude <span class="muted small">— vazio = ~/.claude-pessoal (sua conta pessoal); ~/.claude = conta da empresa</span><input id="g-claude-dir" value="${esc(cfg.claude?.configDir || '')}" placeholder="~/.claude-pessoal"></label>
      <label class="check"><input type="checkbox" id="g-chrome" ${cfg.claude?.chrome !== false ? 'checked' : ''}> Usar o Chrome nas tarefas <span class="muted small">— extensão Claude in Chrome: navega logado, ex.: conferir vagas e se candidatar</span></label>
      <button class="btn small-btn" id="g-save">Salvar</button>
    </section>
  </div>`;

  const $s = (sel) => body.querySelector(sel);
  const save = async (partial, msg = 'Salvo.') => {
    try {
      await central.setConfig(partial);
      toast(msg);
    } catch (err) {
      toast(`Não salvei: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
      throw err;
    }
  };
  $s('#codex-on').addEventListener('change', (e) => callSafe(save({ codex: { enabled: e.target.checked } }, e.target.checked ? 'Codex ligado.' : 'Codex desligado: tudo vai para o Claude.')));
  $s('#dev-save').addEventListener('click', () => callSafe((async () => {
    await save({ codex: { developmentPermissions: $s('#dev-permissions').value, developmentPreflight: $s('#dev-preflight').checked } }, 'Permissões salvas para as próximas execuções.');
  })()));
  $s('#dev-check').addEventListener('click', async () => {
    const button = $s('#dev-check');
    button.disabled = true;
    $s('#dev-result').textContent = 'Verificando Git, GitHub e Electron…';
    try {
      const result = await central.checkDevelopment();
      $s('#dev-result').textContent = result.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.detail}`).join('\n');
    } catch (err) { $s('#dev-result').textContent = err.message; }
    finally { button.disabled = false; }
  });

  // Agenda
  $s('#cal-save').addEventListener('click', async () => {
    const v = $s('#cal-url').value.trim();
    if (v === '••••••') return;
    if (v && !/^https:\/\//.test(v)) return toast('O endereço precisa começar com https://', 'error');
    await save({ integrations: { calendarIcsUrl: v } }, 'Agenda salva. Carregando eventos…');
    setTimeout(renderSettings, 2500);
  });
  $s('#cal-clear')?.addEventListener('click', async () => { await save({ integrations: { calendarIcsUrl: '' } }, 'Agenda removida.'); renderSettings(); });

  // GitHub
  const ghAccounts = () => $s('#gh-accounts').value.split(',').map((x) => x.trim()).filter(Boolean);
  $s('#gh-save').addEventListener('click', () => save({ integrations: { github: { enabled: $s('#gh-on').checked, accounts: ghAccounts() } } }));
  $s('#gh-on').addEventListener('change', () => save({ integrations: { github: { enabled: $s('#gh-on').checked } } }));
  $s('#gh-test').addEventListener('click', async () => {
    await central.setConfig({ integrations: { github: { accounts: ghAccounts() } } });
    $s('#gh-result').textContent = 'Consultando…';
    const r = await central.githubPrs(true);
    $s('#gh-result').textContent = r.ok ? `${r.data.review.length} PR(s) para revisar, ${r.data.mine.length} sua(s) abertas${r.data.errors.length ? ` · erros: ${r.data.errors.join('; ')}` : ''}` : r.error;
  });

  // Slack
  $s('#sl-save').addEventListener('click', async () => {
    const v = $s('#sl-token').value.trim();
    if (v === '••••••') return;
    if (v && !/^xox[pb]-/.test(v)) return toast('O token deve começar com xoxp-', 'error');
    await save({ integrations: { slack: { token: v } } }, 'Token salvo.');
    renderSettings();
  });
  $s('#sl-clear')?.addEventListener('click', async () => { await save({ integrations: { slack: { token: '' } } }, 'Slack desconectado.'); renderSettings(); });
  $s('#sl-import')?.addEventListener('click', async () => {
    const n = await callSafe(central.slackImport(), 'Slack: ');
    if (n != null) toast(`${n} demanda(s) importada(s).`);
  });

  // Leitura em voz alta
  $s('#w-tts').addEventListener('change', (e) => save({ voice: { ttsVoice: e.target.value } }, 'Voz salva.'));
  $s('#w-tts-test').addEventListener('click', () =>
    central.speak('Oi, Gabriel! Eu sou a Ohara. Abri o Spotify pra você e já deixei o resumo da reunião no painel de demandas.', $s('#w-tts').value),
  );
  $s('#w-speak').addEventListener('change', (e) => {
    save({ voice: { speakReplies: e.target.checked } });
    const chk = document.getElementById('speak-replies');
    if (chk) chk.checked = e.target.checked;
  });

  // Atalhos
  $s('#hk-save').addEventListener('click', async () => {
    const hotkeys = {};
    body.querySelectorAll('[data-hk]').forEach((i) => (hotkeys[i.dataset.hk] = i.value.trim()));
    await save({ hotkeys }, 'Atalhos salvos.');
    renderSettings();
  });

  // Reuniões
  $s('#m-pick').addEventListener('click', async () => {
    const p = await central.pickFolder();
    if (p) $s('#m-folder').value = p;
  });
  $s('#m-save').addEventListener('click', () =>
    save({
      meetings: {
        folder: $s('#m-folder').value.trim(),
        minUtterances: Number($s('#m-min').value) || 15,
        prepMinutes: Number($s('#m-prep').value) || 0,
        ignoreBefore: $s('#m-ignore').value || null,
        enabled: $s('#m-on').checked,
        autoAnalyze: $s('#m-auto').checked,
      },
    }),
  );

  // Atualizações
  const showUpd = (s, checked) => {
    $s('#upd-result').textContent = updateText(s, checked);
    $s('#upd-install').hidden = s?.status !== 'ready';
  };
  $s('#upd-check').addEventListener('click', async () => {
    const button = $s('#upd-check');
    button.disabled = true;
    $s('#upd-result').textContent = 'Procurando versão nova…';
    try {
      showUpd(await central.updateCheck(), true);
    } catch (err) {
      showUpd({ status: 'error', message: err.message }, true);
    } finally {
      button.disabled = false;
    }
  });
  $s('#upd-install').addEventListener('click', () => central.updateInstall());
  // Acompanha o download até o fim (a tela é redesenhada a cada abertura: troca a inscrição anterior).
  if (typeof settingsUpdOff === 'function') settingsUpdOff();
  settingsUpdOff = central.onUpdateStatus((s) => {
    if (body.contains($s('#upd-result'))) showUpd(s, true);
  });

  // Geral
  $s('#g-login').addEventListener('change', (e) => central.loginItem(e.target.checked));
  $s('#g-save').addEventListener('click', () => save({ outputDir: $s('#g-out').value.trim(), workspaceRoot: $s('#g-root').value.trim(), claude: { configDir: $s('#g-claude-dir').value.trim(), chrome: $s('#g-chrome').checked } }));
}

