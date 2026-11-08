/* global central */
const toggle = document.getElementById('toggle');
let enabled = false;
function renderConfig(cfg) {
  enabled = !!cfg.voice.wakeWord;
  toggle.textContent = enabled ? 'Desligar' : 'Ligar';
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.disabled = false;
}
function renderStatus(status) {
  document.getElementById('dot').dataset.mode = status.mode;
  const label = document.getElementById('status');
  label.textContent = status.text;
  label.title = status.text;
}
central.onConfigChanged(renderConfig);
central.onListeningStatus(renderStatus);
toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try { renderConfig(await central.setConfig({ voice: { wakeWord: !enabled } })); }
  catch (err) { renderStatus({ mode: 'error', text: err.message }); }
  finally { toggle.disabled = false; }
});
document.getElementById('hide').addEventListener('click', () => central.setConfig({ voice: { showListeningIndicator: false } }));
Promise.all([central.getConfig(), central.listeningStatus()]).then(([cfg, status]) => {
  renderConfig(cfg);
  renderStatus(status);
}).catch((err) => renderStatus({ mode: 'error', text: err.message }));
