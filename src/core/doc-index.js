// Busca por significado nos documentos do escritório, 100% local.
// Cada arquivo das pastas configuradas vira trechos; cada trecho vira um vetor (embeddings no Ollama).
// Na pergunta, acha os trechos mais parecidos e o modelo local responde citando de onde tirou.
const fs = require('fs');
const path = require('path');
const { extractText, SUPPORTED_EXT } = require('./doc-text');
const llm = require('./local-llm');

const CHUNK = 1200;
const OVERLAP = 200;
const MAX_FILES = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

/** Divide em trechos de ~1200 caracteres, quebrando em parágrafo ou frase quando dá. */
function chunkText(text, size = CHUNK, overlap = OVERLAP) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const window = text.slice(i + Math.floor(size * 0.6), end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '));
      if (cut > 0) end = i + Math.floor(size * 0.6) + cut + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

// Vetores guardados como Float32 em base64: ~4x menor que JSON de números.
const packVec = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const unpackVec = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Os k trechos mais parecidos com o vetor da pergunta. */
function topK(query, entries, k = 6) {
  return entries
    .map((e) => ({ ...e, score: cosine(query, e.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function listFiles(folders) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= MAX_FILES) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name.startsWith('.') || it.name.startsWith('~$')) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) walk(full);
      } else if (SUPPORTED_EXT.has(path.extname(it.name).toLowerCase())) {
        out.push(full);
        if (out.length >= MAX_FILES) return;
      }
    }
  };
  for (const f of folders) if (f && fs.existsSync(f)) walk(f);
  return out;
}

const ANSWER_SYSTEM = [
  'Você responde perguntas sobre os documentos de um escritório de advocacia, usando SOMENTE os trechos fornecidos.',
  'Responda em português do Brasil, direto ao ponto. Cite a fonte de cada afirmação com o número do trecho entre colchetes, como [1] ou [2][3].',
  'Se os trechos não trouxerem a resposta, diga claramente que não encontrou nos documentos indexados. Nunca invente nomes, valores, datas ou números de processo.',
].join('\n');

class DocIndex {
  /**
   * @param {object} o
   * @param {string} o.file onde o índice é salvo
   * @param {() => object} o.getConfig
   * @param {(ch:string, p:any) => void} [o.emit]
   * @param {object} [o.ai] troca as chamadas ao Ollama (testes)
   */
  constructor({ file, getConfig, emit = () => {}, ai = llm }) {
    this.file = file;
    this.getConfig = getConfig;
    this.emit = emit;
    this.ai = ai;
    this.data = this.#load();
    this.running = null;
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.files) return d;
    } catch {
      /* índice novo */
    }
    return { model: null, updatedAt: null, files: {} };
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  folders() {
    return (this.getConfig().documents?.folders || []).filter(Boolean);
  }

  status() {
    const files = Object.values(this.data.files);
    return {
      folders: this.folders(),
      files: files.filter((f) => !f.error).length,
      errors: files.filter((f) => f.error).map((f) => ({ path: f.path, error: f.error })).slice(0, 30),
      chunks: files.reduce((n, f) => n + (f.chunks?.length || 0), 0),
      updatedAt: this.data.updatedAt,
      model: this.data.model,
      running: !!this.running,
    };
  }

  /** Reindexa: só lê de novo o que mudou desde a última vez e tira o que sumiu. */
  rebuild() {
    if (!this.running) this.running = this.#rebuild().finally(() => (this.running = null));
    return this.running;
  }

  async #rebuild() {
    const config = this.getConfig();
    const model = config.ollama?.embedModel || 'bge-m3';
    if (this.data.model && this.data.model !== model) this.data.files = {}; // trocou de modelo: vetores antigos não servem
    this.data.model = model;
    const folders = this.folders();
    if (!folders.length) throw new Error('Escolha ao menos uma pasta de documentos antes de indexar.');
    const list = listFiles(folders);
    const seen = new Set(list);
    for (const p of Object.keys(this.data.files)) if (!seen.has(p)) delete this.data.files[p];

    let done = 0;
    let changed = 0;
    for (const p of list) {
      done++;
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      const old = this.data.files[p];
      if (old && old.mtime === stat.mtimeMs && old.size === stat.size) continue;
      this.emit('docs:progress', { done, total: list.length, file: path.basename(p) });
      try {
        const text = await extractText(p);
        const pieces = chunkText(text);
        const vecs = [];
        for (let i = 0; i < pieces.length; i += 16) vecs.push(...(await this.ai.embed({ config, texts: pieces.slice(i, i + 16) })));
        this.data.files[p] = { path: p, mtime: stat.mtimeMs, size: stat.size, chunks: pieces.map((t, i) => ({ t, v: packVec(vecs[i]) })) };
      } catch (e) {
        if (/Ollama|modelo/i.test(e.message)) throw e; // Ollama fora: para tudo, não marca arquivo como erro
        this.data.files[p] = { path: p, mtime: stat.mtimeMs, size: stat.size, chunks: [], error: e.message };
      }
      changed++;
      if (changed % 20 === 0) this.#save();
    }
    this.data.updatedAt = Date.now();
    this.#save();
    this.emit('docs:progress', null);
    return { ...this.status(), running: false, changed };
  }

  /** Trechos mais parecidos com a pergunta, sem chamar o modelo de texto. */
  async find(question, k = 6) {
    const config = this.getConfig();
    const entries = [];
    for (const f of Object.values(this.data.files)) for (const c of f.chunks || []) entries.push({ path: f.path, text: c.t, vec: unpackVec(c.v) });
    if (!entries.length) throw new Error('Nenhum documento indexado ainda. Escolha as pastas e clique em "Indexar".');
    const [q] = await this.ai.embed({ config, texts: [question] });
    return topK(q, entries, k).map(({ vec, ...rest }) => rest);
  }

  /** Pergunta em linguagem natural: responde só com base nos trechos achados. */
  async ask(question, { signal } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Escreva a pergunta.');
    const hits = await this.find(q, 6);
    const context = hits.map((h, i) => `[${i + 1}] (${path.basename(h.path)})\n${h.text}`).join('\n\n');
    const r = await this.ai.generate({ config: this.getConfig(), system: ANSWER_SYSTEM, prompt: `Trechos:\n${context}\n\nPergunta: ${q}`, signal });
    return { answer: r.data, sources: hits.map((h, i) => ({ n: i + 1, path: h.path, name: path.basename(h.path), score: Math.round(h.score * 100) / 100, text: h.text })) };
  }
}

module.exports = { DocIndex, chunkText, cosine, topK, packVec, unpackVec, listFiles };
