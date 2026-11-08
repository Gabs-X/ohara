const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// IA falsa para a análise da reunião.
const aiFile = require.resolve('../src/core/ai');
const answers = [];
require.cache[aiFile] = {
  id: aiFile, filename: aiFile, loaded: true,
  exports: { askOnce: async () => ({ provider: 'claude', model: 'fake', tokens: {}, data: answers.shift() }) },
};
const { MeetingsService } = require('../src/core/meetings');

function transcript() {
  const lines = ['# Reunião 05/11/2026 — meetabc-defg-hij', '20 falas · quem falou: Ana Souza, Eu', '10:00:00 → 10:20:00 · capturado', '---'];
  for (let i = 0; i < 20; i++) lines.push(`**10:${String(i).padStart(2, '0')}:00 — ${i % 2 ? 'Eu' : 'Ana Souza'}:** frase número ${i} sobre o relatório trimestral`);
  return lines.join('\n');
}

function service(folder) {
  const store = { data: { meetings: {}, tasks: [], waiting: [] }, save() {} };
  const usage = { summary: () => ({}) };
  const cfg = { meetings: { enabled: true, folder, selfName: 'Gabriel', stableSeconds: 0, minUtterances: 15 } };
  return new MeetingsService({ store, usage, getConfig: () => cfg, emit() {}, notify() {} });
}

const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('prazo do que outra pessoa ficou de entregar é salvo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-meet-'));
  fs.writeFileSync(path.join(dir, 'meet-2026-11-05-abc-defg-hij.md'), transcript());
  answers.push({
    relevante: true, titulo: 'Relatório', tipo: 'alinhamento', resumo: 'r', topicos: [], decisoes: [],
    minhas_demandas: [],
    demandas_de_outros: [{ responsavel: 'Ana Souza', descricao: 'Enviar o relatório', prazo: '2026-11-20', para_mim: true }],
  });
  const s = service(dir);
  s.scan();
  await until(() => s.store.data.waiting.length > 0);
  assert.equal(s.store.data.waiting[0].deadline, '2026-11-20');
  s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scan não lança mesmo com a pasta inexistente', () => {
  const s = service(path.join(os.tmpdir(), `ohara-sem-pasta-${Date.now()}`));
  assert.doesNotThrow(() => s.scan());
  s.start(); // liga o timer mesmo sem a pasta, para pegar quando ela aparecer
  assert.ok(s.scanTimer);
  s.stop();
});
