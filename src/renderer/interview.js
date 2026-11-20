/* Modo entrevista: captura o áudio do PC (loopback), corta em falas pelo volume e manda cada trecho
   (WAV 16 kHz mono) para o processo principal, que transcreve e pede os tópicos de resposta. */
/* global central */

const $ = (id) => document.getElementById(id);
const TARGET_RATE = 16000;

// Corte das falas. Áudio do Teams é limpo (silêncio quase zero), então o limiar é baixo.
const END_SILENCE_MS = 1100; // pausa que encerra a fala de quem pergunta (dispara a análise)
const SOFT_SPLIT_MS = 6000; // depois disso, corta na primeira respirada (transcreve enquanto a pessoa fala)
const SOFT_PAUSE_MS = 250;
const HARD_SPLIT_MS = 12000;
const MIN_SPEECH_MS = 350;
const PRE_ROLL_MS = 300;

function downsample(chunks, inRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { input.set(c, o); o += c.length; }
  if (inRate === TARGET_RATE) return input;
  const ratio = inRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((ch, i) => v.setUint8(off + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TARGET_RATE, true); v.setUint32(28, TARGET_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// ---------- Captura ----------
let capture = null;

async function startCapture() {
  // O processo principal responde com o áudio do sistema (loopback); o vídeo é descartado na hora.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('O Windows não entregou o áudio do PC.');
  }
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const proc = ctx.createScriptProcessor(2048, 1, 1); // mistura os canais em mono
  const mute = ctx.createGain();
  mute.gain.value = 0; // processa sem tocar de volta (senão ecoaria)
  const rate = ctx.sampleRate;
  const chunkMs = (2048 / rate) * 1000;
  const preRoll = [];
  let seg = null;
  let noise = 0.002;
  let turnOpen = false; // já mandou trecho desta fala sem o "fim de fala"
  let silentMs = 0;

  const send = (done, turnEnd) => {
    if (done.speechMs >= MIN_SPEECH_MS) {
      central.interviewAudio(wav(downsample(done.chunks, rate)), { turnEnd });
      turnOpen = !turnEnd;
    } else if (turnEnd && turnOpen) {
      central.interviewTurnEnd();
      turnOpen = false;
    }
  };

  proc.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (let i = 0; i < data.length; i += 2) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / (data.length / 2));
    $('level').firstElementChild.style.width = `${Math.min(100, rms * 900)}%`;
    const voiced = rms > Math.max(0.006, noise * 3);
    if (!seg && !voiced) noise = noise * 0.98 + rms * 0.02;
    silentMs = voiced ? 0 : silentMs + chunkMs;

    if (!seg) {
      preRoll.push(data);
      while (preRoll.length * chunkMs > PRE_ROLL_MS) preRoll.shift();
      if (voiced) {
        seg = { chunks: [...preRoll], ms: preRoll.length * chunkMs, speechMs: 0 };
        preRoll.length = 0;
      } else if (turnOpen && silentMs > END_SILENCE_MS) {
        central.interviewTurnEnd(); // a fala acabou logo depois de um corte por tamanho
        turnOpen = false;
      }
      return;
    }
    seg.chunks.push(data);
    seg.ms += chunkMs;
    if (voiced) seg.speechMs += chunkMs;

    if (silentMs > END_SILENCE_MS) {
      send(seg, true);
      seg = null;
    } else if ((seg.ms > SOFT_SPLIT_MS && silentMs > SOFT_PAUSE_MS) || seg.ms > HARD_SPLIT_MS) {
      send(seg, false);
      seg = null;
    }
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();
  track.addEventListener('ended', () => { stopAll(); renderStatus({ mode: 'error', text: 'A captura do áudio foi interrompida.' }); });

  return {
    stop() {
      proc.onaudioprocess = null;
      try { src.disconnect(); proc.disconnect(); mute.disconnect(); } catch { /* já desligado */ }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

// ---------- Interface ----------
const cards = new Map(); // id → elemento

function renderStatus({ mode, text }) {
  $('dot').dataset.mode = mode;
  $('status').textContent = text;
  $('status').title = text;
}

function setRunning(on) {
  const t = $('toggle');
  t.textContent = on ? 'Parar' : 'Começar a ouvir';
  t.classList.toggle('on', on);
  t.setAttribute('aria-pressed', String(on));
  $('now').disabled = !on;
  if (!on) $('level').firstElementChild.style.width = '0';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderCard(c) {
  let node = cards.get(c.id);
  if (c.state === 'dismissed') {
    node?.remove();
    cards.delete(c.id);
    return;
  }
  $('empty')?.remove();
  if (!node) {
    node = el('article', 'card');
    cards.set(c.id, node);
    $('cards').prepend(node);
    for (const other of cards.values()) if (other !== node) { other.classList.remove('latest'); other.classList.add('old'); }
    node.classList.add('latest');
  }
  node.classList.toggle('error', c.state === 'error');
  node.replaceChildren();
  node.append(el('p', 'q', c.questionPt || (c.state === 'error' ? 'Não consegui responder' : 'Pensando…')));
  node.append(el('p', 'orig', `“${c.original}”`));
  if (c.bullets?.length) {
    const ul = el('ul');
    for (const b of c.bullets) ul.append(el('li', null, b));
    node.append(ul);
  }
  if (c.state === 'error') node.append(el('p', 'meta', c.error || 'Erro desconhecido'));
  if (c.state === 'done' && c.ms) node.append(el('p', 'meta', `${new Date(c.at).toLocaleTimeString('pt-BR')} · respondida em ${(c.ms / 1000).toFixed(1)} s`));
  $('cards').scrollTop = 0;
}

function addLine(line) {
  const box = $('transcript');
  const p = el('p', null, line.text);
  p.title = new Date(line.at).toLocaleTimeString('pt-BR');
  box.append(p);
  while (box.childElementCount > 60) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

async function stopAll() {
  capture?.stop();
  capture = null;
  setRunning(false);
  await central.interviewStop();
}

$('toggle').addEventListener('click', async () => {
  const t = $('toggle');
  t.disabled = true;
  try {
    if (capture) {
      await stopAll();
      return;
    }
    renderStatus({ mode: 'starting', text: 'Abrindo o áudio do PC…' });
    const r = await central.interviewStart();
    if (!r.ok) throw new Error(r.error);
    try {
      capture = await startCapture();
    } catch (err) {
      await central.interviewStop();
      throw err;
    }
    setRunning(true);
    renderStatus({ mode: 'listening', text: 'Ouvindo o áudio do PC' });
  } catch (err) {
    setRunning(false);
    renderStatus({ mode: 'error', text: err.message });
  } finally {
    t.disabled = false;
  }
});

$('now').addEventListener('click', () => central.interviewAnswerNow());
$('context').addEventListener('click', () => central.interviewOpenContext());
$('close').addEventListener('click', async () => {
  await stopAll();
  central.interviewHide();
});
$('manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('manual-text');
  const text = input.value.trim();
  if (!text) return;
  central.interviewAsk(text);
  input.value = '';
});

central.onInterviewStatus(renderStatus);
central.onInterviewCard(renderCard);
central.onInterviewLine(addLine);

central.interviewSnapshot().then((s) => {
  for (const l of s.lines) addLine(l);
  for (const c of s.cards) renderCard(c);
  if (!s.whisper.installed) renderStatus({ mode: 'error', text: `Falta o modelo "${s.whisper.modelName}" do Whisper.` });
}).catch(() => {});
