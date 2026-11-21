// "Abrir meu projeto": descobre como rodar o projeto da pasta e abre. Site estático abre no navegador;
// projeto Node ou Python roda num terminal visível (para ele ver o que acontece e fechar quando quiser).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PY_MAIN = ['main.py', 'app.py', 'run.py', 'bot.py'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/**
 * @returns {{ kind:'browser', file:string, label:string } | { kind:'terminal', command:string, label:string } | { kind:'none', reason:string }}
 */
function detectProject(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { kind: 'none', reason: 'A pasta da conversa não existe.' };
  const has = (f) => fs.existsSync(path.join(cwd, f));

  const pkg = has('package.json') ? readJson(path.join(cwd, 'package.json')) : null;
  if (pkg) {
    const scripts = pkg.scripts || {};
    const script = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
    if (script) {
      const run = script === 'start' ? 'npm start' : `npm run ${script}`;
      const command = has('node_modules') ? run : `npm install && ${run}`;
      return { kind: 'terminal', command, label: has('node_modules') ? `Rodar "${run}"` : `Instalar as dependências e rodar "${run}"` };
    }
    if (pkg.main && has(pkg.main)) return { kind: 'terminal', command: `node ${JSON.stringify(pkg.main)}`, label: `Rodar ${pkg.main}` };
  }

  for (const f of ['index.html', 'public/index.html', 'src/index.html', 'docs/index.html']) {
    if (has(f)) return { kind: 'browser', file: path.join(cwd, f), label: `Abrir ${f} no navegador` };
  }

  const py = PY_MAIN.find(has);
  if (py) {
    const req = has('requirements.txt') ? fs.readFileSync(path.join(cwd, 'requirements.txt'), 'utf8') : '';
    const install = req.trim() ? 'python -m pip install -r requirements.txt && ' : '';
    const runner = /streamlit/i.test(req) ? `streamlit run ${py}` : `python ${py}`;
    return { kind: 'terminal', command: `${install}${runner}`, label: `Rodar ${py}` };
  }

  const html = fs.readdirSync(cwd).find((f) => f.toLowerCase().endsWith('.html'));
  if (html) return { kind: 'browser', file: path.join(cwd, html), label: `Abrir ${html} no navegador` };

  return { kind: 'none', reason: 'Não achei como rodar este projeto (nem package.json, nem index.html, nem main.py). Peça para a Ohara: "como eu rodo este projeto?".' };
}

/** Roda o projeto. openFile: abre um arquivo no navegador padrão (shell.openPath). */
async function runProject(cwd, { openFile } = {}) {
  const d = detectProject(cwd);
  if (d.kind === 'browser') {
    // shell.openPath não rejeita: devolve a mensagem de erro (vazia quando abriu).
    const err = await openFile(d.file);
    if (err) throw new Error(`Não consegui abrir ${path.basename(d.file)}: ${err}`);
  } else if (d.kind === 'terminal') {
    // Linha montada à mão: o Node escaparia as aspas com \" (que o cmd.exe não entende) e o título
    // "Projeto" virava o programa a rodar. Entre aspas, o && do comando fica para a janela nova.
    spawn('cmd.exe', ['/d', '/c', `start "Projeto" cmd.exe /k "${d.command}"`], {
      cwd, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
    }).on('error', () => {}).unref();
  }
  return d;
}

module.exports = { detectProject, runProject };
