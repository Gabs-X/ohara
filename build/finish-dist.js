// Roda depois do electron-builder (só se ele der certo): copia a versão nova para as pastas de uso
// e apaga os instaladores de versões antigas. Só toca em arquivos Ohara-Setup/Portatil-x.y.z.exe(.blockmap).
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');
const home = os.homedir();
const INSTALLER_RE = /^Ohara-(Setup|Portatil)-(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/;

// Pasta de destino -> quais tipos recebem a versão nova.
const targets = [
  { dir: dist, copy: [] }, // o electron-builder já gerou aqui
  { dir: path.join(home, 'Claude', 'Ohara'), copy: ['Setup', 'Portatil'] },
  { dir: path.join(home, 'Downloads'), copy: ['Setup'] },
];

for (const kind of ['Setup', 'Portatil']) {
  const f = path.join(dist, `Ohara-${kind}-${version}.exe`);
  if (!fs.existsSync(f)) {
    console.error(`finish-dist: ${path.basename(f)} não foi gerado; nada foi copiado nem apagado.`);
    process.exit(1);
  }
}

for (const { dir, copy } of targets) {
  if (!fs.existsSync(dir)) continue;
  for (const kind of copy) {
    const name = `Ohara-${kind}-${version}.exe`;
    fs.copyFileSync(path.join(dist, name), path.join(dir, name));
    console.log(`finish-dist: copiado ${name} -> ${dir}`);
  }
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(INSTALLER_RE);
    if (!m || m[2] === version) continue;
    try {
      fs.rmSync(path.join(dir, name));
      console.log(`finish-dist: apagado ${path.join(dir, name)}`);
    } catch (e) {
      console.warn(`finish-dist: não consegui apagar ${name} (${e.code || e.message})`);
    }
  }
}
