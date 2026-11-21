const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { anonymize, deanonymize, triage, commitMessage, diagnoseLog, preSummarize, splitLines, extractFields } = require('../src/core/local-tools');
const { readZipEntry, docxText, htmlText, extractText } = require('../src/core/doc-text');
const { DocIndex, chunkText, cosine, topK, packVec, unpackVec } = require('../src/core/doc-index');
const { DEFAULT_CONFIG } = require('../src/core/config');

const config = structuredClone(DEFAULT_CONFIG);

// Zip mínimo (um arquivo, deflate), só para testar a leitura do .docx.
function makeZip(name, content) {
  const data = Buffer.from(content, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}

test('docx: lê o texto de word/document.xml com parágrafos e entidades', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Contrato de Honorários</w:t></w:r></w:p><w:p><w:r><w:t>Valor: R$ 5.000 &amp; multa</w:t></w:r></w:p></w:body></w:document>';
  const zip = makeZip('word/document.xml', xml);
  assert.equal(readZipEntry(zip, 'word/document.xml').toString(), xml);
  assert.equal(readZipEntry(zip, 'outro.xml'), null);
  assert.equal(docxText(zip).trim(), 'Contrato de Honorários\nValor: R$ 5.000 & multa');
});

test('html: tira scripts e tags, mantém quebras', () => {
  assert.equal(htmlText('<p>Olá</p><script>x()</script><div>mundo &lt;3</div>').trim(), 'Olá\nmundo <3');
});

test('extractText: tipo não suportado e arquivo .docx', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-doc-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.xyz'), 'x');
    await assert.rejects(extractText(path.join(dir, 'a.xyz')), /não suportado/);
    fs.writeFileSync(path.join(dir, 'b.docx'), makeZip('word/document.xml', '<w:p><w:t>Olá</w:t></w:p>'));
    assert.equal(await extractText(path.join(dir, 'b.docx')), 'Olá');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trechos: cobrem o texto todo, com sobreposição e sem passar do tamanho', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Frase número ${i} do contrato de teste.`).join(' ');
  const parts = chunkText(text, 300, 50);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 300));
  assert.ok(parts[0].startsWith('Frase número 0'));
  assert.ok(parts.at(-1).endsWith('59 do contrato de teste.'));
  assert.deepEqual(chunkText('curto'), ['curto']);
});

test('vetores: empacota em base64 e o cosseno ordena pelo mais parecido', () => {
  const v = unpackVec(packVec([0.5, -1, 2]));
  assert.deepEqual([...v], [0.5, -1, 2]);
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100), 100);
  assert.equal(Math.round(cosine([1, 0], [0, 1]) * 100), 0);
  const top = topK([1, 0], [{ id: 'b', vec: [0, 1] }, { id: 'a', vec: [0.9, 0.1] }], 1);
  assert.equal(top[0].id, 'a');
});

test('índice: indexa só o que mudou, acha o trecho certo e responde com fontes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-idx-'));
  try {
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(path.join(docs, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'acordo.txt'), 'Acordo trabalhista com multa de 20% por atraso.');
    fs.writeFileSync(path.join(docs, 'receita.md'), 'Bolo de cenoura com cobertura de chocolate.');
    fs.writeFileSync(path.join(docs, 'node_modules', 'ignorar.txt'), 'multa multa multa');
    // Embedding de mentira: [tem "multa", tem "bolo"].
    let embedCalls = 0;
    const ai = {
      embed: async ({ texts }) => {
        embedCalls++;
        return texts.map((t) => [/multa/i.test(t) ? 1 : 0, /bolo/i.test(t) ? 1 : 0.01]);
      },
      generate: async ({ prompt }) => ({ data: `Resposta com base em: ${prompt.includes('acordo.txt') ? 'acordo' : '?'} [1]` }),
    };
    const cfg = structuredClone(config);
    cfg.documents.folders = [docs];
    const idx = new DocIndex({ file: path.join(dir, 'idx.json'), getConfig: () => cfg, ai });
    const r1 = await idx.rebuild();
    assert.equal(r1.files, 2, 'node_modules fica de fora');
    assert.equal(r1.changed, 2);
    const before = embedCalls;
    const r2 = await idx.rebuild();
    assert.equal(r2.changed, 0, 'segunda vez não relê nada');
    assert.equal(embedCalls, before);

    const ans = await idx.ask('quais acordos têm multa?');
    assert.equal(ans.sources[0].name, 'acordo.txt');
    assert.match(ans.answer, /acordo/);

    // Reabre do disco.
    const again = new DocIndex({ file: path.join(dir, 'idx.json'), getConfig: () => cfg, ai });
    assert.equal(again.status().files, 2);
    fs.rmSync(path.join(docs, 'receita.md'));
    assert.equal((await again.rebuild()).files, 1, 'arquivo apagado sai do índice');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('índice: sem pasta configurada, avisa', async () => {
  const idx = new DocIndex({ file: path.join(os.tmpdir(), `ohara-nada-${Date.now()}.json`), getConfig: () => config, ai: {} });
  await assert.rejects(idx.rebuild(), /pasta/);
  await assert.rejects(idx.ask('x'), /Nenhum documento/);
});

test('anonimização: padrões fixos e nomes do modelo, e desfaz em objetos', async () => {
  const text = 'João da Silva, CPF 123.456.789-09, e-mail joao@exemplo.com.br, tel (11) 98765-4321, processo 0001234-56.2024.5.02.0001, CNPJ 12.345.678/0001-90. Fala com o Gabriel. João da Silva assina.';
  const ai = { generate: async () => ({ data: { pessoas: ['João da Silva', 'Gabriel', 'Fulano Inventado'], enderecos: [] } }) };
  const r = await anonymize({ config, text, keep: ['Gabriel'], ai });
  assert.doesNotMatch(r.text, /123\.456|joao@|98765|0001234|12\.345|João/);
  assert.match(r.text, /\[PESSOA_1\], CPF \[CPF_1\]/);
  assert.match(r.text, /\[PROCESSO_1\]/);
  assert.match(r.text, /\[CNPJ_1\]/);
  assert.match(r.text, /Gabriel/, 'nome da lista "keep" fica');
  assert.equal((r.text.match(/\[PESSOA_1\]/g) || []).length, 2, 'mesmo nome, mesmo marcador');
  assert.ok(!Object.values(r.map).includes('Fulano Inventado'), 'nome que não está no texto é ignorado');
  const back = deanonymize({ resumo: `${'[PESSOA_1]'} deve pagar`, itens: ['[CPF_1]'] }, r.map);
  assert.deepEqual(back, { resumo: 'João da Silva deve pagar', itens: ['123.456.789-09'] });
  assert.equal(deanonymize(r.text, r.map), text);
});

test('anonimização: sem o modelo local, fica com os padrões fixos', async () => {
  const ai = { generate: async () => { throw new Error('Ollama fora'); } };
  const r = await anonymize({ config, text: 'Maria, CPF 111.222.333-44', ai });
  assert.equal(r.text, 'Maria, CPF [CPF_1]');
});

test('askOnce: com privacidade ligada, o prompt sai anonimizado e a resposta volta normal', async () => {
  // Simula o Claude trocando o provedor por uma função falsa via cache do require.
  const claudePath = require.resolve('../src/core/providers/common');
  const common = require(claudePath);
  const original = common.runJsonl;
  let sent = '';
  common.runJsonl = async ({ input, onJson }) => {
    sent = input;
    onJson({ type: 'result', result: 'Resumo: [CPF_1] confirmado', usage: {} });
    return { code: 0, stderr: '' };
  };
  try {
    delete require.cache[require.resolve('../src/core/ai')];
    const { askOnce } = require('../src/core/ai');
    const cfg = structuredClone(config);
    cfg.privacy = { anonymizeCloud: true, names: false, keep: [] };
    cfg.features.meetings.provider = 'claude';
    const usage = { limits: () => ({}), record: () => {}, updateClaudeLimits: () => {} };
    const r = await askOnce({ feature: 'meetings', prompt: 'CPF 123.456.789-09', config: cfg, usage });
    assert.equal(sent, 'CPF [CPF_1]');
    assert.equal(r.data, 'Resumo: 123.456.789-09 confirmado');
    assert.equal(r.anonymized, 1);
  } finally {
    common.runJsonl = original;
    delete require.cache[require.resolve('../src/core/ai')];
  }
});

test('triagem: ordena por urgência mantendo a ordem original como desempate', async () => {
  const ai = { generate: async () => ({ data: { itens: [
    { resumo: 'newsletter', urgencia: 'baixa', area: 'outro', cliente: '', prazo: '', acao_sugerida: 'ler' },
    { resumo: 'intimação', urgencia: 'alta', area: 'trabalhista', cliente: 'ACME', prazo: '5 dias', acao_sugerida: 'contestar' },
    { resumo: 'cliente pergunta', urgencia: 'media', area: 'cível', cliente: 'Ana', prazo: '', acao_sugerida: 'responder' },
  ] } }) };
  const r = await triage({ config, text: 'a\n---\nb\n---\nc', ai });
  assert.deepEqual(r.itens.map((i) => i.ordem), [2, 3, 1]);
  await assert.rejects(triage({ config, text: '  ', ai }), /Cole/);
});

test('extração: marca quando o documento foi cortado', async () => {
  const ai = { generate: async ({ prompt }) => ({ data: { tipo_documento: 'Contrato', tamanho: prompt.length } }) };
  const cfg = structuredClone(config);
  cfg.ollama.contextTokens = 2000;
  const r = await extractFields({ config: cfg, text: 'x'.repeat(20000), ai });
  assert.equal(r._cortado, true);
  assert.ok(r.tamanho < 20000);
});

test('commit: usa o diff preparado e, sem ele, o pendente; sem mudanças, avisa', async () => {
  const calls = [];
  const fake = (diffs) => async (_repo, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'diff') return args.includes('--staged') ? diffs.staged : diffs.work;
    if (args[0] === 'log') return 'feat: algo\nfix: outro\n';
    if (args[0] === 'branch') return 'minha-branch\n';
    return ' M a.js\n';
  };
  let prompt = '';
  const ai = { generate: async (o) => { prompt = o.prompt; return { data: { commit_titulo: 't', commit_corpo: '', pr_titulo: 'p', pr_descricao: 'd' } }; } };
  const r = await commitMessage({ config, repo: 'x', ai, run: fake({ staged: '', work: '+linha' }) });
  assert.equal(r.staged, false);
  assert.match(prompt, /minha-branch/);
  assert.match(prompt, /feat: algo/);
  assert.match(prompt, /\+linha/);
  const r2 = await commitMessage({ config, repo: 'x', ai, run: fake({ staged: '+preparado', work: '+outro' }) });
  assert.equal(r2.staged, true);
  await assert.rejects(commitMessage({ config, repo: 'x', ai, run: fake({ staged: '', work: '' }) }), /Não há mudanças/);
});

test('diagnóstico: log longo manda começo e, principalmente, o final', async () => {
  let sent = '';
  const ai = { generate: async ({ prompt }) => { sent = prompt; return { data: { resumo: 'ok' } }; } };
  await diagnoseLog({ config, text: `INICIO${'a'.repeat(30000)}ERRO_FINAL`, ai });
  assert.match(sent, /^INICIO/);
  assert.match(sent, /ERRO_FINAL$/);
  assert.match(sent, /omitido/);
  assert.ok(sent.length < 15000);
});

test('resumo prévio: divide por linhas, condensa cada parte e cai fora se o Ollama falhar', async () => {
  const text = Array.from({ length: 200 }, (_, i) => `Pessoa ${i % 3}: fala número ${i} com bastante conteúdo aqui`).join('\n');
  const parts = splitLines(text, 2000);
  assert.ok(parts.length > 3 && parts.every((p) => p.length <= 2100));
  assert.equal(parts.join(''), `${text}\n`);
  const ai = { generate: async () => ({ data: 'Pessoa 1: pediu X' }) };
  const s = await preSummarize({ config, text, chunkChars: 2000, ai });
  assert.match(s, /\[Trecho 1 de \d+, condensado\]/);
  assert.ok(s.length < text.length);
  const bad = { generate: async () => { throw new Error('fora'); } };
  assert.equal(await preSummarize({ config, text, ai: bad }), null);
});

test('config: padrões novos das ferramentas locais', () => {
  assert.equal(DEFAULT_CONFIG.ollama.embedModel, 'bge-m3');
  assert.equal(DEFAULT_CONFIG.privacy.anonymizeCloud, false, 'privacidade é opt-in');
  assert.equal(DEFAULT_CONFIG.meetings.localPreSummary, true);
  assert.deepEqual(DEFAULT_CONFIG.documents.folders, []);
});
