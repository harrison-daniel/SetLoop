import * as ort from "onnxruntime-web";

// ═══ Constants ═══
const SAMPLE_RATE = 16000;
const VAD_FRAME = 512;
const WHISPER_N_FFT = 400;
const WHISPER_HOP = 160;
const WHISPER_N_MELS = 80;
const WHISPER_CHUNK_SAMPLES = SAMPLE_RATE * 30; // 30s
const WHISPER_CHUNK_FRAMES = 3000;

// Whisper special tokens
const TOKEN_SOT = 50258;        // <|startoftranscript|>
const TOKEN_EN = 50259;         // <|en|>
const TOKEN_TRANSCRIBE = 50359; // <|transcribe|>
const TOKEN_NO_TIMESTAMPS = 50363;
const TOKEN_EOT = 50257;        // <|endoftext|>

// ═══ State ═══
let vadSession = null;
let whisperEncoder = null;
let whisperDecoder = null;
let vocabMap = null;            // id → token string
let melFilters = null;          // precomputed mel filter bank
let vadState = null;
let micStream = null;
let audioCtx = null;

let isSpeaking = false;
let speechBuffer = [];
let silenceFrames = 0;
let vadThreshold = 0.5;
let energyThreshold = 0.015;
let silenceThresholdVAD = 0.35;
const MAX_SPEECH_SEC = 8;
const MIN_SPEECH_FRAMES = 4;
const SILENCE_END_FRAMES = 15;  // ~500ms at 32ms/frame

// ═══ Initialization ═══
async function init() {
  send("vad-status", { status: "loading", message: "Loading models…" });

  ort.env.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
  ort.env.wasm.numThreads = 1;

  const [vad, enc, dec, vocab] = await Promise.all([
    ort.InferenceSession.create(chrome.runtime.getURL("models/silero_vad.onnx")),
    ort.InferenceSession.create(chrome.runtime.getURL("models/whisper-tiny/encoder_model_quantized.onnx")),
    ort.InferenceSession.create(chrome.runtime.getURL("models/whisper-tiny/decoder_model_quantized.onnx")),
    fetch(chrome.runtime.getURL("models/whisper-tiny/tokenizer.json")).then(r => r.json()),
  ]);

  vadSession = vad;
  whisperEncoder = enc;
  whisperDecoder = dec;
  vadState = new Float32Array(2 * 1 * 128);

  // Build reverse vocab: id → string
  const model = vocab.model?.vocab || vocab.vocab || {};
  vocabMap = {};
  for (const [token, id] of Object.entries(model)) {
    vocabMap[id] = token;
  }

  melFilters = createMelFilterBank();
  send("vad-status", { status: "ready" });
}

// ═══ Microphone Pipeline ═══
async function startPipeline() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  audioCtx = new AudioContext({ sampleRate: 48000 });
  const source = audioCtx.createMediaStreamSource(micStream);

  const workletUrl = URL.createObjectURL(
    new Blob(
      [await (await fetch(chrome.runtime.getURL("vad-processor.js"))).text()],
      { type: "application/javascript" }
    )
  );
  await audioCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const node = new AudioWorkletNode(audioCtx, "vad-processor");
  source.connect(node);
  node.port.onmessage = onAudioFrame;

  isSpeaking = false;
  speechBuffer = [];
  silenceFrames = 0;
}

function stopPipeline() {
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  isSpeaking = false;
  speechBuffer = [];
}

// ═══ Audio Frame Handler ═══
async function onAudioFrame(e) {
  const { audio, rms } = e.data;

  // Energy gate: reject quiet audio (speaker bleed after AEC)
  if (rms < energyThreshold) {
    if (isSpeaking) tickSilence();
    return;
  }

  const prob = await runVAD(audio);

  if (!isSpeaking && prob > vadThreshold) {
    isSpeaking = true;
    speechBuffer = [];
    silenceFrames = 0;
    send("vad-speech-start", {});
  }

  if (isSpeaking) {
    speechBuffer.push(new Float32Array(audio));

    // Cap buffer at MAX_SPEECH_SEC to prevent memory runaway
    const maxFrames = Math.ceil((MAX_SPEECH_SEC * SAMPLE_RATE) / VAD_FRAME);
    if (speechBuffer.length > maxFrames) {
      finishSpeech();
      return;
    }

    if (prob < silenceThresholdVAD) {
      tickSilence();
    } else {
      silenceFrames = 0;
    }
  }
}

function tickSilence() {
  silenceFrames++;
  if (silenceFrames >= SILENCE_END_FRAMES) {
    finishSpeech();
  }
}

async function finishSpeech() {
  if (speechBuffer.length < MIN_SPEECH_FRAMES) {
    isSpeaking = false;
    speechBuffer = [];
    silenceFrames = 0;
    return;
  }

  const frames = speechBuffer;
  isSpeaking = false;
  speechBuffer = [];
  silenceFrames = 0;

  const audio = concatFloat32(frames);

  try {
    const text = await transcribe(audio);
    if (text && text.trim()) {
      send("vad-transcript", { text: text.trim() });
    }
  } catch (err) {
    console.error("[SetLoop] Whisper error:", err);
  }
}

// ═══ Silero VAD ═══
async function runVAD(frame) {
  const feeds = {
    input: new ort.Tensor("float32", frame, [1, frame.length]),
    state: new ort.Tensor("float32", new Float32Array(vadState), [2, 1, 128]),
    sr: new ort.Tensor("int64", BigInt64Array.of(16000n), []),
  };
  const out = await vadSession.run(feeds);
  vadState.set(out.stateN.data);
  return out.output.data[0];
}

// ═══ Whisper Transcription ═══
async function transcribe(audio) {
  const mel = computeMelSpectrogram(audio);

  // Encoder: [1, 80, 3000] → [1, 1500, 384]
  const melTensor = new ort.Tensor("float32", mel, [1, WHISPER_N_MELS, WHISPER_CHUNK_FRAMES]);
  const encOut = await whisperEncoder.run({ input_features: melTensor });
  const hidden = encOut.last_hidden_state;

  // Greedy decoder
  const tokens = [TOKEN_SOT, TOKEN_EN, TOKEN_TRANSCRIBE, TOKEN_NO_TIMESTAMPS];
  const maxNew = 56;

  for (let i = 0; i < maxNew; i++) {
    const ids = BigInt64Array.from(tokens.map(BigInt));
    const idTensor = new ort.Tensor("int64", ids, [1, tokens.length]);

    const decOut = await whisperDecoder.run({
      input_ids: idTensor,
      encoder_hidden_states: hidden,
    });

    // logits shape: [1, seq_len, vocab_size]
    const logits = decOut.logits.data;
    const vocabSize = decOut.logits.dims[2];
    const offset = (tokens.length - 1) * vocabSize;

    let bestId = 0, bestVal = -Infinity;
    for (let j = 0; j < vocabSize; j++) {
      if (logits[offset + j] > bestVal) {
        bestVal = logits[offset + j];
        bestId = j;
      }
    }

    if (bestId === TOKEN_EOT) break;
    tokens.push(bestId);
  }

  return decodeTokens(tokens.slice(4));
}

function decodeTokens(ids) {
  if (!vocabMap) return "";
  const parts = [];
  for (const id of ids) {
    if (id >= TOKEN_EOT) continue; // skip special tokens
    const tok = vocabMap[id] || "";
    parts.push(tok);
  }
  // Whisper byte-level BPE: decode unicode escapes
  return decodeBPE(parts.join(""));
}

function decodeBPE(text) {
  // Whisper BPE uses Ġ for space, and byte-escapes for non-ASCII
  const byteMap = buildByteMap();
  let out = "";
  for (const ch of text) {
    out += byteMap[ch] ?? ch;
  }
  return out;
}

let _byteMap = null;
function buildByteMap() {
  if (_byteMap) return _byteMap;
  _byteMap = {};
  // GPT-2 / Whisper byte-to-unicode mapping
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);   // !..~
  for (let i = 161; i <= 172; i++) bs.push(i);   // ¡..¬
  for (let i = 174; i <= 255; i++) bs.push(i);   // ®..ÿ
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  for (let i = 0; i < bs.length; i++) {
    _byteMap[String.fromCodePoint(cs[i])] = String.fromCharCode(bs[i]);
  }
  return _byteMap;
}

// ═══ Mel Spectrogram ═══
function computeMelSpectrogram(audio) {
  // Pad audio to 30 seconds
  const padded = new Float32Array(WHISPER_CHUNK_SAMPLES);
  padded.set(audio.subarray(0, Math.min(audio.length, WHISPER_CHUNK_SAMPLES)));

  // Hann window
  const win = new Float32Array(WHISPER_N_FFT);
  for (let i = 0; i < WHISPER_N_FFT; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / WHISPER_N_FFT));
  }

  const nPad = WHISPER_N_FFT / 2;
  const signal = new Float32Array(padded.length + WHISPER_N_FFT);
  // Reflect-pad at boundaries
  for (let i = 0; i < nPad; i++) signal[nPad - 1 - i] = padded[i + 1];
  signal.set(padded, nPad);
  for (let i = 0; i < nPad; i++) signal[padded.length + nPad + i] = padded[padded.length - 2 - i];

  const nFrames = WHISPER_CHUNK_FRAMES;
  const nFreqs = WHISPER_N_FFT / 2 + 1; // 201
  const nFft = 512; // next power of 2

  // Output: [80, 3000] row-major
  const mel = new Float32Array(WHISPER_N_MELS * nFrames);

  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);

  for (let t = 0; t < nFrames; t++) {
    const off = t * WHISPER_HOP;

    // Windowed frame, zero-padded to nFft
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < WHISPER_N_FFT; i++) {
      re[i] = signal[off + i] * win[i];
    }

    fft(re, im, nFft);

    // Power spectrum → mel filters
    for (let m = 0; m < WHISPER_N_MELS; m++) {
      let sum = 0;
      const filt = melFilters[m];
      for (let f = 0; f < nFreqs; f++) {
        const power = re[f] * re[f] + im[f] * im[f];
        sum += filt[f] * power;
      }
      mel[m * nFrames + t] = sum;
    }
  }

  // Log-mel + normalize (Whisper convention)
  let maxLog = -Infinity;
  for (let i = 0; i < mel.length; i++) {
    mel[i] = Math.log10(Math.max(mel[i], 1e-10));
    if (mel[i] > maxLog) maxLog = mel[i];
  }
  for (let i = 0; i < mel.length; i++) {
    mel[i] = Math.max(mel[i], maxLog - 8.0);
    mel[i] = (mel[i] + 4.0) / 4.0;
  }

  return mel;
}

function createMelFilterBank() {
  const nFreqs = WHISPER_N_FFT / 2 + 1;
  const fMin = 0, fMax = 8000;
  const melMin = 2595 * Math.log10(1 + fMin / 700);
  const melMax = 2595 * Math.log10(1 + fMax / 700);
  const melPts = new Float64Array(WHISPER_N_MELS + 2);
  for (let i = 0; i < WHISPER_N_MELS + 2; i++) {
    melPts[i] = melMin + ((melMax - melMin) * i) / (WHISPER_N_MELS + 1);
  }
  const hzPts = melPts.map(m => 700 * (10 ** (m / 2595) - 1));
  const bins = hzPts.map(f => Math.floor((WHISPER_N_FFT + 1) * f / SAMPLE_RATE));

  const filters = [];
  for (let i = 0; i < WHISPER_N_MELS; i++) {
    const filt = new Float32Array(nFreqs);
    const lo = bins[i], mid = bins[i + 1], hi = bins[i + 2];
    for (let j = lo; j < mid; j++) {
      filt[j] = mid > lo ? (j - lo) / (mid - lo) : 0;
    }
    for (let j = mid; j < hi; j++) {
      filt[j] = hi > mid ? (hi - j) / (hi - mid) : 0;
    }
    filters.push(filt);
  }
  return filters;
}

// ═══ Radix-2 FFT ═══
function fft(re, im, n) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const angle = step * j;
        const wr = Math.cos(angle), wi = Math.sin(angle);
        const a = i + j, b = i + j + half;
        const tr = wr * re[b] - wi * im[b];
        const ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// ═══ Helpers ═══
function concatFloat32(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function send(type, data) {
  chrome.runtime.sendMessage({ type, ...data });
}

// ═══ Message Handler ═══
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "start-pipeline": startPipeline(); break;
    case "stop-pipeline": stopPipeline(); break;
    case "set-sensitivity":
      if (typeof msg.threshold === "number") {
        vadThreshold = Math.max(0.1, Math.min(0.95, msg.threshold));
      }
      break;
  }
});

// Boot
init().catch(err => {
  console.error("[SetLoop] Init failed:", err);
  send("vad-status", { status: "error", message: err.message });
});
