// Persistência simples em JSON dentro da pasta de dados do app.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = this.#load();
    this.timer = null;
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return structuredClone(this.defaults); // primeira execução
    }
    try {
      return { ...structuredClone(this.defaults), ...JSON.parse(raw.replace(/^﻿/, '')) };
    } catch {
      // Arquivo corrompido: guarda uma cópia antes que a próxima gravação o substitua pelos padrões.
      try { fs.copyFileSync(this.file, `${this.file}.corrompido-${Date.now()}`); } catch { /* sem cópia */ }
      return structuredClone(this.defaults);
    }
  }

  // Grava com pequeno atraso para juntar várias alterações seguidas.
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  // Nunca lança: roda em timer e no fechamento do app. Se a gravação falhar (disco cheio, arquivo
  // preso pelo antivírus/indexador do Windows), tenta de novo em alguns segundos sem perder os dados da memória.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, this.file);
      } catch (err) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        // O destino está aberto por outro programa: grava por cima em vez de trocar o arquivo.
        fs.copyFileSync(tmp, this.file);
        fs.rmSync(tmp, { force: true });
      }
      this.failures = 0;
      return true;
    } catch (err) {
      this.failures = (this.failures || 0) + 1;
      console.error(`Falha ao gravar ${path.basename(this.file)}:`, err.message);
      if (this.failures <= 5) this.timer = setTimeout(() => this.flush(), 2000 * this.failures);
      return false;
    }
  }
}

// Mescla profunda só para objetos simples (usada na configuração).
function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

module.exports = { JsonStore, deepMerge };
