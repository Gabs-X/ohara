const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { asksPcInfo, guessTools, resolveFolder, armazenamento, processos, navegadores, programas, pasta, runPcTool, TOOL_DEFS } = require('../src/core/pc-tools');
const { draftWithTools } = require('../src/core/local-chat');

test('perguntas sobre o PC ficam com a Ohara-AI', () => {
  for (const t of [
    'verifica quanto tenho de armazenamento',
    'quanto espaço livre tem no disco?',
    'quais navegadores eu tenho instalados?',
    'o chrome está aberto?',
    'o que está pesando na memória?',
    'quanto de RAM tem meu pc',
    'o que ocupa mais espaço na pasta Downloads',
    'tenho o node instalado? quais programas tenho',
    'estou conectado na internet?',
  ]) assert.ok(asksPcInfo(t), t);
});

test('mudar algo ou usar um site continua com o Claude', () => {
  for (const t of [
    'apaga os arquivos grandes da pasta Downloads',
    'desinstala o edge',
    'fecha o chrome',
    'abre o linkedin no chrome e procura vagas',
    'entra no gmail pelo navegador',
    'limpa o disco C',
    'faz um backup do meu pc',
    'reinicia o computador',
    'organiza a pasta Downloads',
    'me explica como funciona a fotossíntese',
  ]) assert.ok(!asksPcInfo(t), t);
});

test('pastas conhecidas pelo nome', () => {
  const home = path.join('C:', 'Users', 'teste');
  assert.equal(resolveFolder('Downloads', home), path.join(home, 'Downloads'));
  assert.equal(resolveFolder('área de trabalho', home), path.join(home, 'Desktop'));
  assert.equal(resolveFolder('', home), home);
  assert.equal(resolveFolder('D:', home), 'D:\\');
});

test('armazenamento converte para GB e calcula o uso', async () => {
  const run = async () => ({ DeviceID: 'C:', VolumeName: 'Sistema', Size: 1000 * 1024 ** 3, FreeSpace: 250 * 1024 ** 3, DriveType: 3 });
  const r = await armazenamento({ run });
  assert.deepEqual(r.unidades[0], { unidade: 'C:', nome: 'Sistema', tipo: 'interno', totalGB: 1000, livreGB: 250, usadoGB: 750, usoPct: 75 });
});

test('processos ordena por memória e respeita o limite', async () => {
  const run = async () => [
    { nome: 'a', instancias: 1, memoria: 100 * 1024 ** 2, cpu: 5 },
    { nome: 'b', instancias: 3, memoria: 900 * 1024 ** 2, cpu: 1 },
    { nome: 'c', instancias: 1, memoria: 300 * 1024 ** 2, cpu: 9 },
  ];
  const r = await processos({ limite: 2, run });
  assert.deepEqual(r.processos.map((p) => p.nome), ['b', 'c']);
  assert.equal(r.processos[0].memoria, '900 MB');
  const byCpu = await processos({ ordenar: 'cpu', limite: 1, run });
  assert.equal(byCpu.processos[0].nome, 'c');
});

test('navegadores junta instalados, versão e janelas abertas', async () => {
  const find = () => [{ nome: 'Google Chrome', proc: 'chrome', exe: 'C:\\chrome.exe' }, { nome: 'Microsoft Edge', proc: 'msedge', exe: 'C:\\msedge.exe' }];
  const run = async () => ({ versoes: { 'C:\\chrome.exe': '150.0' }, abertos: { proc: 'chrome', instancias: 4, memoria: 512 * 1024 ** 2, janelas: 'GitHub - Google Chrome' } });
  const r = await navegadores({ run, find });
  assert.deepEqual(r.instalados[0], { nome: 'Google Chrome', versao: '150.0', aberto: true, memoria: '512 MB', processos: 4, janelas: ['GitHub - Google Chrome'] });
  assert.deepEqual(r.instalados[1], { nome: 'Microsoft Edge', versao: null, aberto: false });
});

test('programas filtra pela busca e tira repetidos', async () => {
  const run = async () => [
    { nome: 'Node.js', versao: '24', editor: 'Node.js Foundation' },
    { nome: 'Node.js', versao: '24', editor: 'Node.js Foundation' },
    { nome: 'Microsoft Office', versao: '16', editor: 'Microsoft' },
  ];
  const r = await programas({ busca: 'node', run });
  assert.equal(r.total, 1);
  assert.equal(r.programas[0].nome, 'Node.js');
});

test('pasta lista os maiores itens e soma subpastas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-pasta-'));
  fs.mkdirSync(path.join(dir, 'grande'));
  fs.writeFileSync(path.join(dir, 'grande', 'x.bin'), Buffer.alloc(3 * 1024 ** 2));
  fs.writeFileSync(path.join(dir, 'pequeno.txt'), 'oi');
  const r = await pasta({ caminho: dir });
  assert.equal(r.totalItens, 2);
  assert.equal(r.maiores[0].nome, 'grande');
  assert.equal(r.maiores[0].tamanho, '3 MB');
  const missing = await pasta({ caminho: path.join(dir, 'nao-existe') });
  assert.match(missing.erro, /não existe/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ferramenta desconhecida ou com erro vira { erro } sem lançar', async () => {
  assert.match((await runPcTool('formatar_disco', {})).erro, /desconhecida/);
  const r = await runPcTool('sistema', {}, { sistema: async () => { throw new Error('falhou'); } });
  assert.deepEqual(r, { erro: 'falhou' });
});

test('todas as ferramentas oferecidas ao modelo são só de leitura e existem', () => {
  const names = TOOL_DEFS.map((t) => t.function.name);
  assert.deepEqual(names, ['armazenamento', 'sistema', 'processos', 'navegadores', 'programas', 'rede', 'pasta']);
});

test('rascunho com ferramentas: consulta o PC e responde com o resultado', async () => {
  const seen = [];
  const call = async ({ messages, tools }) => {
    seen.push({ messages: [...messages], tools: !!tools });
    if (seen.length === 1) return { message: { content: '', tool_calls: [{ function: { name: 'armazenamento', arguments: {} } }] }, input: 10, output: 2 };
    return { message: { content: 'Você tem 441 GB livres no C:.' }, input: 20, output: 8 };
  };
  const run = async (name) => ({ unidades: [{ unidade: 'C:', livreGB: 441 }], ferramenta: name });
  const steps = [];
  const r = await draftWithTools({ config: { ollama: {} }, messages: [{ role: 'user', content: 'quanto tenho de armazenamento?' }], call, run, onStep: (t) => steps.push(t) });
  assert.equal(r.text, 'Você tem 441 GB livres no C:.');
  assert.equal(r.used[0].name, 'armazenamento');
  assert.equal(r.input, 30);
  const toolMsg = seen[1].messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.match(toolMsg.content, /441/);
  assert.deepEqual(steps, ['Ohara-AI: consultando o PC (armazenamento)']);
});

test('rascunho com ferramentas não entra em laço: a última rodada é sem ferramentas', async () => {
  let n = 0;
  const call = async ({ tools }) => {
    n++;
    if (tools) return { message: { tool_calls: [{ function: { name: 'sistema', arguments: '{}' } }] }, input: 1, output: 1 };
    return { message: { content: 'pronto' }, input: 1, output: 1 };
  };
  const r = await draftWithTools({ config: { ollama: {} }, messages: [], call, run: async () => ({}) });
  assert.equal(r.text, 'pronto');
  assert.equal(n, 5);
});

test('"instalados", "atualizado" e "configuração" são consulta; "instala" e "atualiza" são mudança', () => {
  assert.ok(asksPcInfo('o chrome está atualizado?'));
  assert.ok(asksPcInfo('qual a configuração do meu pc?'));
  assert.ok(!asksPcInfo('instala o firefox'));
  assert.ok(!asksPcInfo('atualiza o chrome'));
});

test('consultas óbvias pelo assunto já saem antes do modelo', () => {
  assert.deepEqual(guessTools('verifica quanto tenho de armazenamento'), [{ name: 'armazenamento', args: {} }]);
  assert.deepEqual(guessTools('o que ocupa espaço na pasta Downloads?').map((c) => c.name), ['armazenamento', 'pasta']);
  assert.deepEqual(guessTools('quais navegadores tenho?'), [{ name: 'navegadores', args: {} }]);
  assert.deepEqual(guessTools('o pc está lento, o que está pesando?').map((c) => c.name), ['processos']);
  assert.deepEqual(guessTools('tenho o node instalado?'), [{ name: 'programas', args: { busca: 'node' } }]);
  assert.deepEqual(guessTools('apaga a pasta Downloads'), []);
  assert.deepEqual(guessTools('me conta uma piada'), []);
});

test('rascunho com consulta prévia: o resultado já chega ao modelo na primeira chamada', async () => {
  const seen = [];
  const call = async ({ messages }) => {
    seen.push(messages);
    return { message: { content: 'ok' }, input: 1, output: 1 };
  };
  const r = await draftWithTools({ config: { ollama: {} }, messages: [{ role: 'user', content: 'armazenamento?' }], prefetch: [{ name: 'armazenamento', args: {} }], call, run: async () => ({ livreGB: 441 }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].at(-1).role, 'tool');
  assert.equal(r.used.length, 1);
});
