// Voz → texto local com whisper.cpp (offline, entende pt-BR).
// Na primeira vez baixa o executável oficial (GitHub ggml-org/whisper.cpp) e o modelo (Hugging Face).
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

function findWhisperExe(root) {
  const found = { cli: null, main: null };
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^whisper-cli\.exe$/i.test(e.name)) found.cli ||= p;
      else if (/^main\.exe$/i.test(e.name)) found.main ||= p;
    }
  };
  walk(root);
  return found.cli || found.main;
}

function findFile(root, re) {
  if (!fs.existsSync(root)) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, re);
      if (f) return f;
    } else if (re.test(e.name)) return p;
  }
  return null;
}

/**
 * whisper-server com o modelo carregado uma vez só: cada trecho é transcrito sem recarregar o modelo
 * (~1,5 s por frase longa na CPU, contra ~2,7 s do whisper-cli). Ouve só em 127.0.0.1.
 */
class WhisperServer {
  constructor({ binDir, modelPath, language = 'en', threads }) {
    this.exe = findFile(binDir, /^whisper-server\.exe$/i);
    this.modelPath = modelPath;
    this.language = language;
    this.threads = threads || Math.max(2, Math.min(12, require('os').cpus().length - 2));
    this.proc = null;
    this.url = null;
  }

  async start() {
    if (this.proc) return;
    if (!this.exe) throw new Error('whisper-server.exe não encontrado na pasta do Whisper.');
    const port = await new Promise((resolve, reject) => {
      const srv = require('net').createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });
    let log = '';
    this.proc = spawn(this.exe, ['-m', this.modelPath, '-l', this.language, '-t', String(this.threads), '-nt', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: path.dirname(this.exe), windowsHide: true,
    });
    this.proc.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
    this.proc.stdout.on('data', (d) => { log = (log + d).slice(-2000); });
    const exited = new Promise((r) => this.proc.once('exit', r));
    this.proc.once('exit', () => { this.proc = null; this.url = null; });
    this.url = `http://127.0.0.1:${port}`;
    // Pronto quando o modelo carrega e a porta responde.
    for (let i = 0; i < 120; i++) {
      if (!this.proc) break;
      if (/listening at|server is listening/i.test(log)) return;
      const ok = await fetch(`${this.url}/`).then((r) => r.ok, () => false);
      if (ok && /whisper_init|model/i.test(log)) return;
      await Promise.race([new Promise((r) => setTimeout(r, 250)), exited]);
    }
    this.stop();
    throw new Error(`whisper-server não iniciou: ${log.split('\n').filter(Boolean).pop() || 'sem resposta'}`);
  }

  async transcribe(wavPath) {
    if (!this.url) throw new Error('whisper-server parado');
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'trecho.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`whisper-server respondeu ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`whisper-server: ${data.error}`);
    return String(data.text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.url = null;
    if (p && !p.killed) {
      try { p.kill(); } catch { /* já saiu */ }
    }
  }
}

const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

class Whisper {
  constructor({ dir, getConfig }) {
    this.dir = dir; // %APPDATA%/Ohara/whisper
    this.getConfig = getConfig;
    this.installing = null;
  }

  get model() {
    return this.getConfig().voice.whisperModel || 'base';
  }

  #binDir() {
    return path.join(this.dir, 'bin');
  }

  // Prefere o whisper-cli.exe. Nas versões novas do whisper.cpp, o main.exe é só um aviso de
  // "binário obsoleto" que sai com código 1; ele só serve em versões antigas, sem whisper-cli.
  #findExe() {
    return findWhisperExe(this.#binDir());
  }

  #modelPath(name = this.model) {
    return path.join(this.dir, 'models', `ggml-${name}.bin`);
  }

  /**
   * Servidor com o modelo sempre carregado (modo entrevista).
   * binDir: subpasta da pasta do Whisper com outra build (ex.: "bin-cuda", para usar a placa de vídeo).
   */
  server({ model = this.model, language = 'en', binDir = '' } = {}) {
    const dir = binDir ? path.join(this.dir, binDir) : this.#binDir();
    return new WhisperServer({ binDir: dir, modelPath: this.#modelPath(model), language });
  }

  // model: outro modelo além do da voz (o modo entrevista usa o "small", mais preciso em inglês).
  status({ model = this.model } = {}) {
    const exe = this.#findExe();
    const file = this.#modelPath(model);
    return { installed: !!exe && fs.existsSync(file), exe: !!exe, model: fs.existsSync(file), modelName: model, installing: !!this.installing };
  }

  async #download(url, dest, onProgress) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ohara' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      if (total) onProgress?.(got / total);
    }
    await new Promise((r) => out.end(r));
    fs.renameSync(tmp, dest);
  }

  async #latestZipUrl() {
    const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10', { headers: { 'User-Agent': 'ohara', Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    for (const rel of await res.json()) {
      const a = rel.assets?.find((x) => x.name === 'whisper-bin-x64.zip');
      if (a) return a.browser_download_url;
    }
    throw new Error('Não encontrei whisper-bin-x64.zip nos releases do whisper.cpp');
  }

  install(onProgress) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      try {
        if (!this.#findExe()) {
          onProgress?.({ step: 'programa', pct: 0 });
          const zip = path.join(this.dir, 'whisper-bin-x64.zip');
          await this.#download(await this.#latestZipUrl(), zip, (p) => onProgress?.({ step: 'programa', pct: p }));
          // Extrai numa pasta própria (arquivo baixado = não confiável: nada roda de dentro dela além do exe).
          await new Promise((resolve, reject) =>
            execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${this.#binDir()}' -Force`], { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
          );
          fs.rmSync(zip, { force: true });
        }
        if (!fs.existsSync(this.#modelPath())) {
          onProgress?.({ step: 'modelo', pct: 0 });
          await this.#download(MODEL_URL(this.model), this.#modelPath(), (p) => onProgress?.({ step: 'modelo', pct: p }));
        }
        return this.status();
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  // Recebe um WAV 16 kHz mono e devolve o texto.
  // prompt: dica de vocabulário para o Whisper (ex.: "Ohara", para ele escrever o nome certo).
  // language/model: sobrescrevem os da voz (o modo entrevista transcreve em inglês).
  transcribe(wavPath, { prompt, language, model } = {}) {
    const exe = this.#findExe();
    const modelPath = this.#modelPath(model || this.model);
    if (!exe || !fs.existsSync(modelPath)) return Promise.reject(new Error('Whisper não instalado. Instale em Configurações → Voz.'));
    const lang = language || this.getConfig().voice.language || 'pt';
    const threads = Math.max(2, Math.min(8, require('os').cpus().length - 1));
    return new Promise((resolve, reject) => {
      const args = ['-m', modelPath, '-f', wavPath, '-l', lang, '-nt', '-np', '-t', String(threads)];
      if (prompt) args.push('--prompt', prompt);
      const p = spawn(exe, args, { cwd: path.dirname(wavPath), windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d.toString('utf8')));
      p.stderr.on('data', (d) => (err += d.toString('utf8')));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) {
          // Alguns erros vão para a saída normal (ex.: aviso de binário obsoleto).
          const last = (err + '\n' + out).split('\n').map((l) => l.trim()).filter(Boolean).pop();
          return reject(new Error(last ? `Whisper: ${last}` : `whisper saiu com código ${code}`));
        }
        resolve(out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim());
      });
    });
  }
}

module.exports = { Whisper, WhisperServer, findWhisperExe };
