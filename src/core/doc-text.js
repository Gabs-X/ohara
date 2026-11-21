// Texto de um arquivo, para as ferramentas locais: txt/md/csv/json/html, Word (.docx) e PDF com texto.
// PDF escaneado (só imagem) não tem texto: para ele, a tela oferece "Ler documento por foto".
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.rtf', '.log']);
const SUPPORTED_EXT = new Set([...TEXT_EXT, '.docx', '.pdf']);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_UNZIPPED = 100 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; // entidade inválida: deixa como está
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Lê um arquivo de dentro de um .zip (o .docx é um zip). Devolve Buffer ou null. */
function readZipEntry(buf, wanted) {
  // Fim do diretório central: assinatura 0x06054b50, procurada de trás para frente.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      // Limite na saída: um .docx pequeno que descompacta para GBs ("zip bomb") derrubaria o app.
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
        } catch (e) {
          if (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new Error('O documento descompactado passa de 100 MB: grande demais para ler.');
          throw e;
        }
      }
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('Não consegui abrir este .docx (arquivo corrompido ou protegido).');
  const text = xml
    .toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text);
}

function htmlText(s) {
  return decodeEntities(
    s
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages.join('\n\n');
}

const tidy = (s) => s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Texto do arquivo. Lança erro claro se o tipo não for suportado ou não houver texto. */
async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) throw new Error(`Tipo de arquivo não suportado (${ext || 'sem extensão'}). Use PDF, Word (.docx) ou texto.`);
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) throw new Error('Arquivo grande demais (acima de 25 MB).');
  const buf = fs.readFileSync(file);
  let text;
  if (ext === '.docx') text = docxText(buf);
  else if (ext === '.pdf') text = await pdfText(buf);
  else if (ext === '.html' || ext === '.htm') text = htmlText(buf.toString('utf8'));
  else text = buf.toString('utf8');
  text = tidy(text);
  if (!text) throw new Error(ext === '.pdf' ? 'Este PDF não tem texto (deve ser escaneado). Use "Ler documento por foto" com uma imagem da página.' : 'O arquivo está vazio.');
  return text;
}

module.exports = { extractText, readZipEntry, docxText, htmlText, SUPPORTED_EXT };
