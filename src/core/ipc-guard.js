'use strict';
// Salvaguardas para o que chega do renderer pelo IPC. A interface é tratada como não
// confiável: um arquivo arrastado, um XSS ou um texto malicioso da IA não pode virar
// execução de programa no PC.
const path = require('path');
const { fileURLToPath } = require('url');

// Só as páginas .html da pasta do renderer do próprio app.
function isAppPage(url, rendererDir) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    const file = path.resolve(fileURLToPath(url));
    return path.dirname(file).toLowerCase() === path.resolve(rendererDir).toLowerCase()
      && file.toLowerCase().endsWith('.html');
  } catch { return false; }
}

// A interface não pode trocar os executáveis que a Ohara roda (claude.bin, orca.bin...)
// nem poluir o protótipo dos objetos de configuração.
const BLOCKED_KEYS = new Set(['bin', '__proto__', 'constructor', 'prototype']);
function sanitizeConfigPatch(partial) {
  const strip = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) if (!BLOCKED_KEYS.has(k)) out[k] = strip(v);
    return out;
  };
  return strip(partial && typeof partial === 'object' ? partial : {});
}

// Extensões que o Windows executa ao "abrir". O renderer só abre documentos e pastas.
const EXECUTABLE = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.msi', '.msp', '.scr', '.hta', '.cpl', '.pif', '.lnk', '.url', '.reg', '.jar', '.appref-ms',
  '.application', '.gadget', '.msc', '.inf', '.settingcontent-ms', '.library-ms', '.scf',
]);
function assertSafeToOpen(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('Caminho inválido.');
  if (/^[a-z][a-z0-9+.-]+:(?![\\/])/i.test(p) && !/^[a-z]:/i.test(p)) throw new Error('Caminho inválido.');
  const ext = path.extname(p.trim().replace(/[.\s]+$/, '')).toLowerCase();
  if (EXECUTABLE.has(ext)) throw new Error('Por segurança, a Ohara não abre programas ou atalhos por aqui.');
  return p;
}

module.exports = { isAppPage, sanitizeConfigPatch, assertSafeToOpen, EXECUTABLE };
