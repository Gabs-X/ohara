/* Modo entrevista: captura o áudio do PC (loopback), corta em falas pelo volume e manda cada trecho
   (WAV 16 kHz mono) para o processo principal, que transcreve e pede os tópicos de resposta. */
/* global central */

const $ = (id) => document.getElementById(id);
const TARGET_RATE = 16000;

// Corte das falas. Áudio do Teams é limpo (silêncio quase zero), então o limiar é baixo.
// Pausa curta dispara a análise cedo; se a pessoa continuar, a continuação atualiza o mesmo cartão.
const END_SILENCE_MS = 700;
const SOFT_SPLIT_MS = 3000; // depois disso, corta na primeira respirada: no fim da pergunta sobra só um trecho curto
const SOFT_PAUSE_MS = 200;
const HARD_SPLIT_MS = 8000;
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

/**
 * Corta um áudio em falas pelo volume e manda cada trecho ao processo principal.
 * speaker 'them' = áudio do PC (quem entrevista): pausas viram "fim de fala" e disparam a resposta.
 * speaker 'me' = seu microfone: só transcrito, para a transcrição salva ter as suas respostas.
 */
function listen(ctx, track, { speaker, minLevel, onLevel }) {
  const me = speaker === 'me';
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const proc = ctx.createScriptProcessor(2048, 1, 1); // mistura os canais em mono
  const mute = ctx.createGain();
  mute.gain.value = 0; // processa sem tocar de volta (senão ecoaria)
  const rate = ctx.sampleRate;
  const chunkMs = (2048 / rate) * 1000;
  // A sua fala não dispara nada: dá para esperar pausas maiores e mandar trechos mais longos.
  const endSilence = me ? 1200 : END_SILENCE_MS;
  const softSplit = me ? 8000 : SOFT_SPLIT_MS;
  const softPause = me ? 400 : SOFT_PAUSE_MS;
  const hardSplit = me ? 15000 : HARD_SPLIT_MS;
  const preRoll = [];
  let seg = null;
  let noise = minLevel / 3;
  let turnOpen = false; // já mandou trecho desta fala sem o "fim de fala"
  let silentMs = 0;

  const send = (done, turnEnd) => {
    if (done.speechMs >= MIN_SPEECH_MS) {
      // startedAt: quando a fala começou (para saber se é continuação da pergunta anterior).
      central.interviewAudio(wav(downsample(done.chunks, rate)), { turnEnd, startedAt: Date.now() - Math.round(done.ms), speaker });
      turnOpen = !turnEnd;
    } else if (turnEnd && turnOpen && !me) {
      central.interviewTurnEnd();
      turnOpen = false;
    }
  };

  proc.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (let i = 0; i < data.length; i += 2) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / (data.length / 2));
    onLevel?.(rms);
    const voiced = rms > Math.max(minLevel, noise * 3);
    if (!seg && !voiced) noise = noise * 0.98 + rms * 0.02;
    silentMs = voiced ? 0 : silentMs + chunkMs;

    if (!seg) {
      preRoll.push(data);
      while (preRoll.length * chunkMs > PRE_ROLL_MS) preRoll.shift();
      if (voiced) {
        seg = { chunks: [...preRoll], ms: preRoll.length * chunkMs, speechMs: 0 };
        preRoll.length = 0;
      } else if (turnOpen && silentMs > endSilence) {
        if (!me) central.interviewTurnEnd(); // a fala acabou logo depois de um corte por tamanho
        turnOpen = false;
      }
      return;
    }
    seg.chunks.push(data);
    seg.ms += chunkMs;
    if (voiced) seg.speechMs += chunkMs;

    if (silentMs > endSilence) {
      send(seg, true);
      seg = null;
    } else if ((seg.ms > softSplit && silentMs > softPause) || seg.ms > hardSplit) {
      send(seg, false);
      seg = null;
    }
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  return () => {
    proc.onaudioprocess = null;
    try { src.disconnect(); proc.disconnect(); mute.disconnect(); } catch { /* já desligado */ }
  };
}

async function startCapture({ mic }) {
  // O processo principal responde com o áudio do sistema (loopback); o vídeo é descartado na hora.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('O Windows não entregou o áudio do PC.');
  }
  const ctx = new AudioContext();
  const level = (rms) => { $('level').firstElementChild.style.width = `${Math.min(100, rms * 900)}%`; };
  const stops = [listen(ctx, track, { speaker: 'them', minLevel: 0.006, onLevel: level })];
  const streams = [stream];
  let micError = '';
  if (mic) {
    try {
      // Cancelamento de eco e supressão de ruído do Chromium: ajudam quando a call sai no alto-falante.
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streams.push(micStream);
      stops.push(listen(ctx, micStream.getAudioTracks()[0], { speaker: 'me', minLevel: 0.012 }));
    } catch (err) {
      micError = err.message || 'sem acesso ao microfone';
    }
  }
  if (ctx.state === 'suspended') await ctx.resume();
  track.addEventListener('ended', () => { stopAll(); renderStatus({ mode: 'error', text: 'A captura do áudio foi interrompida.' }); });

  return {
    micError,
    stop() {
      stops.forEach((f) => f());
      streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
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
  const p = el('p', line.speaker === 'me' ? 'me' : null);
  p.append(el('b', null, line.speaker === 'me' ? 'Eu: ' : 'Entrevistador: '), line.text);
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
      capture = await startCapture({ mic: micEnabled });
    } catch (err) {
      await central.interviewStop();
      throw err;
    }
    setRunning(true);
    if (capture.micError) renderStatus({ mode: 'error', text: `Ouvindo só o PC: microfone indisponível (${capture.micError}).` });
    else renderStatus({ mode: 'listening', text: micEnabled ? 'Ouvindo o PC e o seu microfone' : 'Ouvindo o áudio do PC' });
  } catch (err) {
    setRunning(false);
    renderStatus({ mode: 'error', text: err.message });
  } finally {
    t.disabled = false;
  }
});

$('log').addEventListener('click', () => central.interviewOpenLog());
$('now').addEventListener('click', () => central.interviewAnswerNow());
$('context').addEventListener('click', () => central.interviewOpenContext());
$('new').addEventListener('click', async () => {
  capture?.stop();
  capture = null;
  setRunning(false);
  await central.interviewNew();
  for (const node of cards.values()) node.remove();
  cards.clear();
  $('transcript').replaceChildren();
});
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

let micEnabled = true;
central.interviewSnapshot().then((s) => {
  micEnabled = s.captureMic !== false;
  for (const l of s.lines) addLine(l);
  for (const c of s.cards) renderCard(c);
  if (!s.whisper.installed) renderStatus({ mode: 'error', text: `Falta o modelo "${s.whisper.modelName}" do Whisper.` });
}).catch(() => {});
