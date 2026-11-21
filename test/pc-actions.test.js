// Ações da Ohara-AI no PC: travas de caminho e de processo, o que roda na hora e o que pede confirmação,
// e quais pedidos ficam com ela (e não com o Claude). Nada aqui toca o PC: PowerShell e programas são falsos.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const A = require('../src/core/pc-actions');

const HOME = String.raw`C:\Users\gabri`;

test('travas de caminho: sistema, raiz, pasta do usuário e AppData ficam de fora; relativo é a partir do usuário', () => {
  const ok = (p) => A.guardPath(p, { home: HOME });
  assert.equal(ok(String.raw`downloads\x.pdf`), String.raw`C:\Users\gabri\Downloads\x.pdf`);
  assert.equal(ok(String.raw`contratos\a.docx`), String.raw`C:\Users\gabri\contratos\a.docx`);
  assert.equal(ok(String.raw`D:\Fotos\a.jpg`), String.raw`D:\Fotos\a.jpg`);
  for (const bad of [String.raw`C:\Windows\System32`, String.raw`C:\Windows`, 'C:\\', 'C:', String.raw`C:\Program Files\x`, String.raw`C:\ProgramData\y`, HOME, String.raw`C:\Users\gabri\AppData\Roaming\ohara`, String.raw`C:\Users\gabri\AppData`]) {
    assert.throws(() => ok(bad), undefined, bad);
  }
});

test('processos do sistema e a própria Ohara nunca são fechados', () => {
  assert.equal(A.cleanProcName('chrome.exe'), 'chrome');
  for (const p of ['lsass', 'winlogon', 'csrss', 'svchost', 'explorer;rm', 'Ohara', 'ollama', 'a&b']) {
    if (p === 'explorer;rm' || p === 'a&b') assert.throws(() => A.cleanProcName(p), /inválido/);
    else assert.throws(() => A.cleanProcName(p), /sistema|Ohara/);
  }
});

test('risco: o que dá para desfazer roda; fechar, mover, apagar, limpar e desligar pedem confirmação', () => {
  for (const n of ['volume', 'midia', 'print', 'copiar', 'lembrete', 'bloquear_tela', 'abrir_configuracao', 'buscar_arquivos', 'ler_arquivo', 'criar_pasta']) assert.equal(A.riskOf(n, {}), 'livre', n);
  for (const n of ['fechar_programa', 'mover', 'renomear', 'lixeira', 'limpar_temporarios', 'esvaziar_lixeira']) assert.equal(A.riskOf(n, {}), 'confirmar', n);
  assert.equal(A.riskOf('energia', { acao: 'desligar' }), 'confirmar');
  assert.equal(A.riskOf('energia', { acao: 'cancelar' }), 'livre');
  assert.equal(A.riskOf('abrir', { caminho: String.raw`downloads\nota.pdf` }), 'livre');
  assert.equal(A.riskOf('abrir', { caminho: String.raw`downloads\setup.exe` }), 'confirmar');
  assert.equal(A.riskOf('abrir', { caminho: String.raw`downloads\x.bat ` }), 'confirmar');
});

// Contexto falso: guarda os scripts do PowerShell e os programas chamados.
function fakeCtx(answers = {}) {
  const ps = [];
  const exec = [];
  const opened = [];
  const ctx = {
    home: HOME,
    ps: async (script) => {
      ps.push(script);
      for (const [k, v] of Object.entries(answers)) if (script.includes(k)) return v;
      return { ok: true };
    },
    exec: async (file, args) => {
      exec.push([file, ...args]);
      return '';
    },
    open: async (uri) => opened.push(uri),
    schedule: (t, ms) => Date.now() + ms,
  };
  return { ctx, ps, exec, opened };
}

test('ação arriscada não roda: vira pedido pendente com um resumo para ele confirmar', async () => {
  const { ctx, ps } = fakeCtx();
  const pending = [];
  const r = await A.requestAction('fechar_programa', { nome: 'chrome' }, { ctx, pending });
  assert.equal(r.status, 'aguardando_confirmacao');
  assert.equal(r.feito, false);
  assert.equal(ps.length, 0, 'nada rodou');
  assert.deepEqual(pending, [{ name: 'fechar_programa', args: { nome: 'chrome' }, resumo: 'Fechar chrome' }]);
});

test('nome que a pessoa usa vira o processo ("bloco de notas" → notepad) e "forçar" com cedilha vale', async () => {
  assert.equal(A.cleanProcName('Bloco de Notas'), 'notepad');
  assert.equal(A.cleanProcName('word'), 'WINWORD');
  assert.equal(A.cleanProcName('notepad.exe'), 'notepad');
  assert.equal(A.summarize('fechar_programa', { nome: 'notepad.exe', 'forçar': true }), 'Forçar o fechamento de notepad');
  const { ctx, ps } = fakeCtx({ 'Get-Process': { encontrados: 1, ainda_abertos: 0 } });
  await A.executeAction('fechar_programa', { nome: 'bloco de notas', 'forçar': true }, ctx);
  assert.match(ps.at(-1), /if\(\$left\.Count -and \$true\)/);
});

test('pedido arriscado com alvo proibido já volta como erro ao modelo, sem virar pendente', async () => {
  const { ctx } = fakeCtx();
  const pending = [];
  const r1 = await A.requestAction('lixeira', { caminho: String.raw`C:\Windows\System32` }, { ctx, pending });
  const r2 = await A.requestAction('fechar_programa', { nome: 'lsass' }, { ctx, pending });
  assert.match(r1.erro, /sistema/);
  assert.match(r2.erro, /sistema/);
  assert.equal(pending.length, 0);
});

test('ações livres rodam na hora pelos caminhos certos', async () => {
  const { ctx, ps, exec, opened } = fakeCtx({ CopyFromScreen: { arquivo: String.raw`C:\Users\gabri\Pictures\Screenshots\Ohara-x.png` } });
  assert.match((await A.requestAction('volume', { acao: 'subir' }, { ctx })).feito, /aumentei o volume em 10%/);
  assert.match(ps.at(-1), /\[char\]175/);
  assert.match((await A.requestAction('volume', { acao: 'definir', nivel: 40 }, { ctx })).feito, /40%/);
  assert.match(ps.at(-1), /-lt 50;.*\[char\]174.*-lt 20;.*\[char\]175/);
  assert.match((await A.requestAction('midia', { acao: 'tocar_pausar' }, { ctx })).feito, /tocar\/pausar/);
  assert.match((await A.requestAction('print', {}, { ctx })).arquivo, /Screenshots/);
  await A.requestAction('bloquear_tela', {}, { ctx });
  assert.deepEqual(exec.at(-1), ['rundll32.exe', 'user32.dll,LockWorkStation']);
  await A.requestAction('abrir_configuracao', { tela: 'Bluetooth' }, { ctx });
  assert.deepEqual(opened, ['ms-settings:bluetooth']);
  const bad = await A.requestAction('abrir_configuracao', { tela: 'regedit' }, { ctx });
  assert.match(bad.erro, /desconhecida/);
  const lem = await A.requestAction('lembrete', { texto: 'ligar pro João', minutos: 20 }, { ctx });
  assert.match(lem.feito, /20 min/);
  assert.match((await A.requestAction('energia', { acao: 'cancelar' }, { ctx })).feito, /cancelei/);
  assert.deepEqual(exec.at(-1), ['shutdown.exe', '/a']);
});

test('texto vindo do modelo vai para o PowerShell em base64 (aspas e comandos não escapam)', async () => {
  const { ctx, ps } = fakeCtx();
  await A.requestAction('copiar', { texto: "x'; Remove-Item C:\\ -Recurse; '" }, { ctx });
  assert.doesNotMatch(ps.at(-1), /Remove-Item/);
  assert.match(ps.at(-1), /FromBase64String/);
});

test('confirmado, a ação arriscada roda (executeAction) e erros viram { erro }', async () => {
  const { ctx, exec } = fakeCtx({ 'Get-Process': { encontrados: 2, ainda_abertos: 0 } });
  assert.match((await A.executeAction('fechar_programa', { nome: 'chrome' }, ctx)).feito, /fechei chrome/);
  await A.executeAction('energia', { acao: 'desligar', minutos: 5 }, ctx);
  assert.deepEqual(exec.at(-1).slice(0, 4), ['shutdown.exe', '/s', '/t', '300']);
  assert.match((await A.executeAction('nada', {}, ctx)).erro, /desconhecida/);
  assert.match((await A.executeAction('energia', { acao: 'formatar' }, ctx)).erro, /inválida/);
});

test('criar pasta e ler arquivo funcionam de verdade numa pasta temporária', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-acoes-'));
  const ctx = { ...fakeCtx().ctx, home: dir };
  const r = await A.executeAction('criar_pasta', { caminho: 'Contratos 2026' }, ctx);
  assert.equal(r.caminho, path.join(dir, 'Contratos 2026'));
  assert.ok(fs.statSync(r.caminho).isDirectory());
  fs.writeFileSync(path.join(dir, 'nota.txt'), 'reunião às 15h');
  const lido = await A.executeAction('ler_arquivo', { caminho: 'nota.txt' }, ctx);
  assert.equal(lido.texto, 'reunião às 15h');
  assert.match((await A.executeAction('ler_arquivo', { caminho: 'nao-existe.txt' }, ctx)).erro, /não achei/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quais pedidos são ação no PC (e com quais ferramentas); projeto e código continuam com o Claude', () => {
  const t = (s) => A.actionToolsFor(s);
  assert.deepEqual(t('aumenta o volume'), ['volume']);
  assert.deepEqual(t('pausa a música'), ['midia']);
  assert.deepEqual(t('tira um print'), ['print']);
  assert.deepEqual(t('me lembra de ligar pro João em 20 minutos'), ['lembrete']);
  assert.ok(t('acha o contrato da Silva nos downloads').includes('buscar_arquivos'));
  assert.deepEqual(t('fecha o chrome'), ['fechar_programa']);
  assert.ok(t('limpa os temporários do pc').includes('limpar_temporarios'));
  assert.ok(t('libera espaço no disco').includes('limpar_temporarios'));
  assert.deepEqual(t('desliga o pc em 30 minutos'), ['energia']);
  assert.deepEqual(t('cancela o desligamento'), ['energia']);
  assert.ok(t('apaga o arquivo teste.txt da área de trabalho').includes('lixeira'));
  assert.deepEqual(t('bloqueia a tela'), ['bloquear_tela']);
  assert.deepEqual(t('abre as configurações de bluetooth'), ['abrir_configuracao']);
  assert.ok(t('cria uma pasta Contratos 2026 nos documentos').includes('criar_pasta'));
  for (const s of ['corrige o bug do login no projeto', 'apaga o arquivo de configuração do projeto', 'qual a capital da França?', 'reinicia o servidor']) assert.deepEqual(t(s), [], s);
});

test('conversa que só usa as mesmas palavras não vira ação no PC', () => {
  for (const s of [
    'escreve uma notificação extrajudicial',
    'qual o volume de vendas do mês?',
    'qual sua música favorita?',
    'preciso fechar o contrato com o cliente',
    'lembra que meu cachorro se chama Rex',
    'como faço para copiar uma cláusula no Word?',
    'o som desse carro é bom?',
    'vamos encerrar por hoje',
  ]) assert.deepEqual(A.actionToolsFor(s), [], s);
  assert.deepEqual(A.actionToolsFor('abaixa o volume'), ['volume']);
  assert.deepEqual(A.actionToolsFor('coloca o volume em 30'), ['volume']);
  assert.deepEqual(A.actionToolsFor('muta o pc'), ['volume']);
  assert.deepEqual(A.actionToolsFor('pula essa música'), ['midia']);
  assert.deepEqual(A.actionToolsFor('copia esse texto: reunião às 15h'), ['copiar']);
  assert.deepEqual(A.actionToolsFor('ativa o não perturbe'), ['abrir_configuracao']);
  assert.deepEqual(A.actionToolsFor('fecha o spotify'), ['fechar_programa']);
  assert.deepEqual(A.actionToolsFor('mata o que estiver travado'), ['fechar_programa']);
});

test('definições das ferramentas: uma por ação implementada', () => {
  assert.deepEqual([...A.ACTION_NAMES].sort(), Object.keys(A.IMPLS).sort());
  for (const d of A.ACTION_DEFS) {
    assert.equal(d.type, 'function');
    assert.equal(d.function.parameters.type, 'object');
  }
});
