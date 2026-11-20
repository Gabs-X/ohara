/* global central, esc, toast, renderMarkdown, relTime, setView, el */
// Tela "Ferramentas": tudo roda no modelo local (Ollama). Sem cota e sem o dado sair do PC.

const tl = { tab: 'docs', status: null, repos: null, busy: false, progress: null, results: {} };

const TOOL_TABS = [
  ['docs', '📚', 'Documentos'],
  ['extract', '🧾', 'Extrair dados'],
  ['triage', '📥', 'Triagem'],
  ['photo', '📷', 'Documento por foto'],
  ['privacy', '🕶️', 'Privacidade'],
  ['commit', '🔀', 'Commit e PR'],
  ['log', '🩺', 'Diagnóstico de erro'],
];

const LABELS = {
  cpf: 'CPF', rg: 'RG', cep: 'CEP', orgao_emissor: 'Órgão emissor', filiacao: 'Filiação', data_nascimento: 'Data de nascimento',
  endereco: 'Endereço', legivel: 'Legível', numero_processo: 'Nº do processo', obrigacoes: 'Obrigações', observacoes: 'Observações',
  descricao: 'Descrição', datas_importantes: 'Datas importantes', tipo_documento: 'Tipo de documento',
};
const label = (k) => LABELS[k] || k.replace(/^_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Objeto da IA → tabela legível (listas de objetos viram sub-tabela).
function fieldsHtml(obj) {
  const rows = Object.entries(obj || {}).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null && !(Array.isArray(v) && !v.length));
  if (!rows.length) return '<p class="muted small">Nada encontrado.</p>';
  const cell = (v) => {
    if (typeof v === 'boolean') return v ? 'sim' : 'não';
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== 'object')) return `<ul class="tl-list">${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      const keys = [...new Set(v.flatMap((x) => Object.keys(x || {})))];
      return `<table class="table compact"><thead><tr>${keys.map((k) => `<th>${esc(label(k))}</th>`).join('')}</tr></thead><tbody>${v
        .map((x) => `<tr>${keys.map((k) => `<td>${esc(x?.[k] ?? '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    }
    return esc(v);
  };
  return `<table class="table tl-fields"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(label(k))}</th><td>${cell(v)}</td></tr>`).join('')}</tbody></table>`;
}

async function run(key, fn) {
  if (tl.busy) return;
  tl.busy = key;
  renderTools();
  try {
    const r = await fn();
    if (r && r.ok === false) toast(r.error, 'error');
    else if (r) tl.results[key] = r.data;
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    tl.busy = false;
    renderTools();
  }
}

const busyBtn = (key, text) => (tl.busy === key ? '<span class="typing"><i></i><i></i><i></i></span> Pensando no modelo local…' : text);
const disabled = () => (tl.busy ? 'disabled' : '');
const copyBtn = (id) => `<button class="btn small-btn" data-copy="${id}">Copiar</button>`;

function statusBar(s) {
  if (!s) return '';
  if (!s.ollama) return '<div class="tl-warn">⚠️ O Ollama não está respondendo. Abra o Ollama e volte aqui.</div>';
  if (s.missing.length) return `<div class="tl-warn">⚠️ Falta baixar: ${s.missing.map((m) => `<code>ollama pull ${esc(m)}</code>`).join(' ')}</div>`;
  return `<div class="tl-ok">🔒 Modelo local pronto (${esc(s.models.texto)}). Nada desta tela sai do seu PC nem gasta cota.</div>`;
}

const PANELS = {
  docs(s) {
    const d = s.docs;
    const r = tl.results.docs;
    const prog = tl.progress ? `<p class="muted small">Indexando ${tl.progress.done}/${tl.progress.total}: ${esc(tl.progress.file)}</p>` : '';
    return `
      <section class="section">
        <div class="section-head"><h2>Pastas indexadas</h2>
          <div class="row"><button class="btn small-btn" id="tl-add-folder" ${disabled()}>+ Adicionar pasta</button>
          <button class="btn primary small-btn" id="tl-index" ${disabled()}>${busyBtn('index', '↻ Indexar')}</button></div></div>
        <p class="muted small">PDF com texto, Word (.docx), TXT, Markdown e HTML. Só o que mudou é lido de novo. ${d.updatedAt ? `Última indexação ${relTime(d.updatedAt)}: ${d.files} arquivos, ${d.chunks} trechos.` : 'Ainda não indexado.'}</p>
        ${prog}
        ${d.folders.length ? `<ul class="tl-folders">${d.folders.map((f, i) => `<li><span>${esc(f)}</span><button class="btn small-btn danger-btn" data-rm-folder="${i}">remover</button></li>`).join('')}</ul>` : '<p class="muted small">Nenhuma pasta ainda.</p>'}
        ${d.errors.length ? `<details class="small"><summary>${d.errors.length} arquivo(s) não lidos</summary><ul>${d.errors.map((e) => `<li>${esc(e.path)}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}
      </section>
      <section class="section">
        <h2>Perguntar aos documentos</h2>
        <form class="row" id="tl-ask"><input id="tl-q" placeholder="ex.: acordos com multa por atraso acima de 10%" autocomplete="off" value="${esc(tl.lastQ || '')}" />
          <button class="btn primary small-btn" ${disabled()}>${busyBtn('docs', 'Perguntar')}</button></form>
        ${r ? `<div class="answer bubble tl-answer">${renderMarkdown(r.answer)}</div>
          <h3 class="small muted">Fontes</h3><ol class="tl-sources">${r.sources.map((x) => `<li><a href="#" data-open="${esc(x.path)}">${esc(x.name)}</a> <span class="muted small">(${x.score})</span><details><summary class="small muted">trecho</summary><p class="small">${esc(x.text)}</p></details></li>`).join('')}</ol>` : ''}
      </section>`;
  },

  extract() {
    const r = tl.results.extract;
    return `
      <section class="section">
        <h2>Extrair dados de um documento</h2>
        <p class="muted small">Partes, valores, prazos, número do processo e datas de contratos, acordos, petições e sentenças.</p>
        <div class="row"><button class="btn primary small-btn" id="tl-ex-file" ${disabled()}>${busyBtn('extract', '📄 Escolher arquivo…')}</button><span class="muted small">ou cole o texto:</span></div>
        <textarea id="tl-ex-text" class="tl-area" rows="5" placeholder="Cole aqui o texto do documento"></textarea>
        <div class="row"><button class="btn small-btn" id="tl-ex-run" ${disabled()}>Extrair do texto colado</button></div>
      </section>
      ${r ? `<section class="section"><div class="section-head"><h2>${esc(r.tipo_documento || 'Resultado')}</h2>${copyBtn('extract')}</div>
        ${r._cortado ? '<p class="tl-warn small">Documento longo: só o começo coube no modelo local.</p>' : ''}${fieldsHtml(r)}</section>` : ''}`;
  },

  triage() {
    const r = tl.results.triage;
    return `
      <section class="section">
        <h2>Triagem do que chegou</h2>
        <p class="muted small">Cole e-mails, mensagens, publicações ou intimações. Separe cada um com uma linha contendo só <code>---</code>.</p>
        <textarea id="tl-tr-text" class="tl-area" rows="9" placeholder="Mensagem 1&#10;---&#10;Mensagem 2"></textarea>
        <div class="row"><button class="btn primary small-btn" id="tl-tr-run" ${disabled()}>${busyBtn('triage', 'Classificar')}</button></div>
      </section>
      ${r ? `<section class="section"><div class="section-head"><h2>Por urgência</h2>${copyBtn('triage')}</div>
        <table class="table"><thead><tr><th>#</th><th>Urgência</th><th>Resumo</th><th>Área</th><th>Cliente</th><th>Prazo</th><th>Próximo passo</th></tr></thead><tbody>
        ${r.itens.map((it) => `<tr><td>${it.ordem}</td><td><span class="tl-urg u-${esc(it.urgencia)}">${esc(it.urgencia)}</span></td><td>${esc(it.resumo)}</td><td>${esc(it.area)}</td><td>${esc(it.cliente)}</td><td>${esc(it.prazo)}</td><td>${esc(it.acao_sugerida)}</td></tr>`).join('')}
        </tbody></table></section>` : ''}`;
  },

  photo() {
    const r = tl.results.photo;
    return `
      <section class="section">
        <h2>Ler documento por foto</h2>
        <p class="muted small">RG, CNH, CPF, comprovante de residência, certidão ou página escaneada. Usa o modelo de visão local (a primeira leitura demora mais, enquanto ele carrega).</p>
        <button class="btn primary small-btn" id="tl-ph-file" ${disabled()}>${busyBtn('photo', '🖼️ Escolher imagem…')}</button>
        ${tl.photoFile ? `<p><img class="tl-photo" src="${esc(`file:///${encodeURI(tl.photoFile.replace(/\\/g, '/'))}`)}" alt="Documento escolhido" /></p>` : ''}
      </section>
      ${r ? `<section class="section"><div class="section-head"><h2>${esc(r.tipo_documento || 'Dados lidos')}</h2>${copyBtn('photo')}</div>
        ${r.legivel === false ? '<p class="tl-warn small">A imagem está difícil de ler: confira os dados com atenção.</p>' : ''}${fieldsHtml(r)}</section>` : ''}`;
  },

  privacy(s) {
    const p = s.privacy || {};
    const r = tl.results.privacy;
    return `
      <section class="section settings">
        <h2>Proteger dados antes de mandar para a nuvem</h2>
        <p class="muted small">Ligado, CPF, CNPJ, nº de processo, OAB, e-mail, telefone, CEP, nomes e endereços viram marcadores (<code>[PESSOA_1]</code>, <code>[CPF_1]</code>…) antes de ir para o Claude/Codex nas funções automáticas (reuniões, briefing, busca…). A resposta volta com os dados certos.</p>
        <label class="check"><input type="checkbox" id="tl-pv-on" ${p.anonymizeCloud ? 'checked' : ''}/> Anonimizar o que vai para a nuvem</label>
        <label class="check"><input type="checkbox" id="tl-pv-names" ${p.names !== false ? 'checked' : ''}/> Trocar também nomes e endereços (achados pelo modelo local)</label>
        <label>Nomes que nunca devem ser trocados (separe por vírgula)<input id="tl-pv-keep" value="${esc((p.keep || []).join(', '))}" /></label>
        <label class="check"><input type="checkbox" id="tl-pre" ${s.preSummary ? 'checked' : ''}/> Reunião longa: condensar no modelo local antes de mandar ao Claude (economiza cota)</label>
        <div class="row"><button class="btn small-btn" id="tl-pv-save">Salvar</button></div>
      </section>
      <section class="section">
        <h2>Testar / anonimizar um texto</h2>
        <textarea id="tl-pv-text" class="tl-area" rows="6" placeholder="Cole um texto com dados pessoais para ver como ele sai"></textarea>
        <div class="row"><button class="btn primary small-btn" id="tl-pv-run" ${disabled()}>${busyBtn('privacy', 'Anonimizar')}</button></div>
      </section>
      ${r ? `<section class="section"><div class="section-head"><h2>Texto protegido (${r.count} dado(s) trocados)</h2>${copyBtn('privacy')}</div>
        <pre class="tl-pre">${esc(r.text)}</pre>
        <details><summary class="small muted">Ver o que foi trocado</summary>${fieldsHtml(r.map)}</details></section>` : ''}`;
  },

  commit() {
    const r = tl.results.commit;
    const repos = tl.repos || [];
    return `
      <section class="section">
        <h2>Mensagem de commit e descrição de PR</h2>
        <p class="muted small">Lê o diff preparado (ou, se não houver, o pendente) e escreve no estilo dos commits anteriores. Não faz commit nem push: só escreve o texto.</p>
        <div class="row"><select id="tl-repo">${repos.map((p) => `<option value="${esc(p)}" ${p === tl.repo ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
          <button class="btn small-btn" id="tl-repo-other" ${disabled()}>Outra pasta…</button>
          <button class="btn primary small-btn" id="tl-cm-run" ${disabled()}>${busyBtn('commit', 'Gerar')}</button></div>
      </section>
      ${r ? `<section class="section"><div class="section-head"><h2>Commit ${r.staged ? '(mudanças preparadas)' : '(mudanças ainda não preparadas)'}</h2>${copyBtn('commit')}</div>
          ${r.cortado ? '<p class="tl-warn small">Diff grande: só o começo coube no modelo local.</p>' : ''}
          <pre class="tl-pre">${esc([r.commit_titulo, r.commit_corpo].filter(Boolean).join('\n\n'))}</pre></section>
        <section class="section"><div class="section-head"><h2>PR: ${esc(r.pr_titulo)}</h2>${copyBtn('pr')}</div>
          <div class="bubble">${renderMarkdown(r.pr_descricao)}</div></section>` : ''}`;
  },

  log() {
    const r = tl.results.log;
    return `
      <section class="section">
        <h2>Primeira olhada em um erro</h2>
        <p class="muted small">Cole o log ou a mensagem de erro. O modelo local diz a causa provável, como resolver e se vale chamar o Claude.</p>
        <textarea id="tl-lg-text" class="tl-area" rows="9" placeholder="Cole o erro aqui"></textarea>
        <div class="row"><button class="btn primary small-btn" id="tl-lg-run" ${disabled()}>${busyBtn('log', 'Analisar')}</button></div>
      </section>
      ${r ? `<section class="section"><div class="section-head"><h2>${esc(r.resumo)}</h2><span class="tl-urg u-${esc(r.gravidade === 'media' ? 'media' : r.gravidade)}">gravidade ${esc(r.gravidade)}</span></div>
        <p><b>Causa provável:</b> ${esc(r.causa_provavel)}</p>
        ${r.solucao?.length ? `<ol>${r.solucao.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
        <p class="${r.precisa_claude ? 'tl-warn' : 'tl-ok'} small">${r.precisa_claude ? '🤖 Vale chamar o Claude' : '✅ Dá para resolver sem o Claude'}: ${esc(r.motivo)}</p>
        ${r.precisa_claude ? '<button class="btn primary small-btn" id="tl-lg-claude">Mandar pro Claude</button>' : ''}</section>` : ''}`;
  },
};

function copyText(key) {
  const r = tl.results[key === 'pr' ? 'commit' : key];
  if (!r) return '';
  if (key === 'commit') return [r.commit_titulo, r.commit_corpo].filter(Boolean).join('\n\n');
  if (key === 'pr') return `${r.pr_titulo}\n\n${r.pr_descricao}`;
  if (key === 'privacy') return r.text;
  if (key === 'triage') return r.itens.map((it) => `[${it.urgencia}] ${it.resumo}${it.cliente ? ` · ${it.cliente}` : ''}${it.prazo ? ` · prazo: ${it.prazo}` : ''} → ${it.acao_sugerida}`).join('\n');
  const clean = Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
  return JSON.stringify(clean, null, 2);
}

async function renderTools() {
  const body = document.getElementById('tools-body');
  if (!body) return;
  if (!tl.status) tl.status = await central.toolsStatus();
  const s = tl.status;
  // Mantém o que estava digitado entre uma renderização e outra.
  const keepIds = ['tl-q', 'tl-ex-text', 'tl-tr-text', 'tl-pv-text', 'tl-lg-text'];
  const typed = Object.fromEntries(keepIds.map((id) => [id, document.getElementById(id)?.value]).filter(([, v]) => v != null));

  body.innerHTML = `${statusBar(s)}
    <nav class="tl-tabs">${TOOL_TABS.map(([k, icon, name]) => `<button class="${tl.tab === k ? 'active' : ''}" data-tl-tab="${k}">${icon} ${name}</button>`).join('')}</nav>
    ${PANELS[tl.tab](s)}`;
  for (const [id, v] of Object.entries(typed)) {
    const e = document.getElementById(id);
    if (e) e.value = v;
  }

  const $t = (sel) => body.querySelector(sel);
  body.querySelectorAll('[data-tl-tab]').forEach((b) => b.addEventListener('click', async () => {
    tl.tab = b.dataset.tlTab;
    if (tl.tab === 'commit' && !tl.repos) tl.repos = await central.listRepos();
    renderTools();
  }));
  body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    central.copy(copyText(b.dataset.copy));
    toast('Copiado.');
  }));
  body.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    central.openPath(a.dataset.open);
  }));

  // Documentos
  $t('#tl-add-folder')?.addEventListener('click', async () => {
    const dir = await central.pickFolder();
    if (!dir) return;
    const folders = [...new Set([...s.docs.folders, dir])];
    await central.setConfig({ documents: { folders } });
    tl.status = null;
    renderTools();
  });
  body.querySelectorAll('[data-rm-folder]').forEach((b) => b.addEventListener('click', async () => {
    const folders = s.docs.folders.filter((_, i) => i !== Number(b.dataset.rmFolder));
    await central.setConfig({ documents: { folders } });
    tl.status = null;
    renderTools();
  }));
  $t('#tl-index')?.addEventListener('click', () => run('index', async () => {
    const r = await central.docsIndex();
    tl.status = null;
    if (r.ok) toast(`Indexação concluída: ${r.data.changed} arquivo(s) lidos agora.`);
    return r.ok ? null : r;
  }));
  $t('#tl-ask')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $t('#tl-q').value.trim();
    if (!q) return;
    tl.lastQ = q;
    run('docs', () => central.docsAsk(q));
  });

  // Extração
  $t('#tl-ex-file')?.addEventListener('click', async () => {
    const file = await central.pickFile('doc');
    if (file) run('extract', () => central.toolExtract({ file }));
  });
  $t('#tl-ex-run')?.addEventListener('click', () => {
    const text = $t('#tl-ex-text').value;
    if (text.trim()) run('extract', () => central.toolExtract({ text }));
  });

  // Triagem
  $t('#tl-tr-run')?.addEventListener('click', () => {
    const text = $t('#tl-tr-text').value;
    if (text.trim()) run('triage', () => central.toolTriage(text));
  });

  // Foto
  $t('#tl-ph-file')?.addEventListener('click', async () => {
    const file = await central.pickFile('image');
    if (!file) return;
    tl.photoFile = file;
    delete tl.results.photo;
    run('photo', () => central.toolPhoto(file));
  });

  // Privacidade
  $t('#tl-pv-save')?.addEventListener('click', async () => {
    await central.setConfig({
      privacy: {
        anonymizeCloud: $t('#tl-pv-on').checked,
        names: $t('#tl-pv-names').checked,
        keep: $t('#tl-pv-keep').value.split(',').map((x) => x.trim()).filter(Boolean),
      },
      meetings: { localPreSummary: $t('#tl-pre').checked },
    });
    tl.status = null;
    toast('Salvo.');
    renderTools();
  });
  $t('#tl-pv-run')?.addEventListener('click', () => {
    const text = $t('#tl-pv-text').value;
    if (text.trim()) run('privacy', () => central.toolAnonymize(text));
  });

  // Commit
  $t('#tl-repo')?.addEventListener('change', (e) => (tl.repo = e.target.value));
  $t('#tl-repo-other')?.addEventListener('click', async () => {
    const dir = await central.pickFolder();
    if (!dir) return;
    tl.repos = [dir, ...(tl.repos || []).filter((p) => p !== dir)];
    tl.repo = dir;
    renderTools();
  });
  $t('#tl-cm-run')?.addEventListener('click', () => {
    const repo = $t('#tl-repo').value;
    tl.repo = repo;
    if (repo) run('commit', () => central.toolCommit(repo));
    else toast('Nenhum repositório encontrado: use "Outra pasta…".', 'error');
  });

  // Diagnóstico
  $t('#tl-lg-run')?.addEventListener('click', () => {
    const text = $t('#tl-lg-text').value;
    tl.lastLog = text;
    if (text.trim()) run('log', () => central.toolLog(text));
  });
  $t('#tl-lg-claude')?.addEventListener('click', () => {
    const r = tl.results.log;
    setView('chat');
    el.input.value = `manda pro Claude: investigar e corrigir este erro. Primeira análise local: ${r.resumo} (causa provável: ${r.causa_provavel}).\n\n\`\`\`\n${(tl.lastLog || '').slice(-6000)}\n\`\`\``;
    el.input.dispatchEvent(new Event('input'));
    el.input.focus();
  });
}

central.onDocsProgress((p) => {
  tl.progress = p;
  if (!document.getElementById('view-tools')?.hidden) renderTools();
});
