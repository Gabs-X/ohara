const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, simplifyConfig } = require('../src/core/config');

test('configuracao antiga nao reativa WhatsApp nem captura de voz', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.voice, { commandsEnabled: true, wakeWord: true, showListeningIndicator: true, autoSendVoice: true, speakReplies: true });
  Object.assign(config.integrations.whatsapp, { enabled: true, notifyMeetingTasks: true, phone: '+5511999999999', apikey: 'preservar' });
  config.hotkeys.voice = 'Ctrl+Alt+V';
  simplifyConfig(config);
  assert.equal(config.voice.commandsEnabled, false);
  assert.equal(config.voice.wakeWord, false);
  assert.equal(config.voice.showListeningIndicator, false);
  assert.equal(config.voice.autoSendVoice, false);
  assert.equal(config.hotkeys.voice, '');
  assert.equal(config.integrations.whatsapp.enabled, false);
  assert.equal(config.integrations.whatsapp.notifyMeetingTasks, false);
  assert.equal(config.integrations.whatsapp.apikey, 'preservar');
  assert.equal(config.voice.speakReplies, true);
});
