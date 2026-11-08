const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../src/core/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-store-'));

test('arquivo corrompido: guarda uma cópia antes de voltar aos padrões', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'chats.json');
  fs.writeFileSync(file, '{"chats": [ {"id": "a"'); // gravação cortada no meio
  const s = new JsonStore(file, { chats: [] });
  assert.deepEqual(s.data, { chats: [] });
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('chats.json.corrompido-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"chats": [ {"id": "a"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aceita JSON com BOM', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'prefs.json');
  fs.writeFileSync(file, '﻿{"overrides": [1]}');
  assert.deepEqual(new JsonStore(file, { overrides: [] }).data.overrides, [1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('falha ao gravar não lança e mantém os dados na memória', () => {
  const dir = tmpDir();
  // O "arquivo" é uma pasta: a gravação falha de verdade.
  const file = path.join(dir, 'ocupado.json');
  fs.mkdirSync(file);
  const s = new JsonStore(file, { n: 0 });
  s.data.n = 5;
  assert.equal(s.flush(), false);
  assert.equal(s.data.n, 5);
  clearTimeout(s.timer);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('grava e relê', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  const s = new JsonStore(file, { a: 1 });
  s.data.a = 2;
  assert.equal(s.flush(), true);
  assert.equal(new JsonStore(file, { a: 1 }).data.a, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
