// Publica a versão atual no GitHub (Gabs-X/ohara) com o que o atualizador automático precisa:
// latest.yml + instalador + blockmap (para baixar só o que mudou). O portátil vai junto para download manual.
// Uso: npm run release  (gera o build antes). Notas: dist/notas-<versão>.md, se existir.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');
const tag = `v${version}`;

const files = [`Ohara-Setup-${version}.exe`, `Ohara-Setup-${version}.exe.blockmap`, 'latest.yml', `Ohara-Portatil-${version}.exe`].map((f) => path.join(dist, f));
for (const f of files) if (!fs.existsSync(f)) throw new Error(`release: falta ${path.basename(f)} (rode npm run dist)`);
const yml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
if (!yml.includes(`version: ${version}`)) throw new Error(`release: latest.yml não é da versão ${version}`);

const notes = path.join(dist, `notas-${version}.md`);
// A tag precisa já estar no GitHub, no commit desta versão: sem ela o gh criaria a tag no master atual.
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
// Tag anotada: o "^{}" é o commit para onde ela aponta (sem ele vem o hash do objeto da tag).
const refs = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root, encoding: 'utf8' }).trim().split('\n').map((l) => l.split(/\s+/));
const remote = (refs.find((r) => r[1]?.endsWith('^{}')) || refs[0] || [])[0];
if (remote !== head) throw new Error(`release: a tag ${tag} não está no GitHub apontando para o commit atual (${head.slice(0, 7)}). Faça commit, git tag ${tag} e git push origin ${tag}.`);
const args = ['release', 'create', tag, ...files, '-R', 'Gabs-X/ohara', '--title', `Ohara ${version}`, '--verify-tag'];
args.push(...(fs.existsSync(notes) ? ['--notes-file', notes] : ['--generate-notes']));
execFileSync('gh', args, { stdio: 'inherit', cwd: root });
console.log(`release: ${tag} publicado. Quem tem a Ohara instalada recebe o aviso em até 4 horas (ou ao abrir).`);
