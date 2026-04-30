// ═══ Constants ═══
const SAMPLE_RATE = 16000;
const VAD_FRAME = 512;
const VAD_CONTEXT_SIZE = 64;
const INIT_TIMEOUT_MS = 120000;

// ═══ State ═══
let ort = null;
let transcriber = null;
let vadSession = null;
let vadState = null;
let vadContext = new Float32Array(VAD_CONTEXT_SIZE);
let initReady = false;
let initPromise = null;

let micStream = null;
let audioCtx = null;

let isSpeaking = false;
let speechBuffer = [];
let silenceFrames = 0;
let vadThreshold = 0.5;
let energyThreshold = 0.015;
let silenceThresholdVAD = 0.20;
const MAX_SPEECH_SEC = 8;
const MIN_SPEECH_FRAMES = 4;
const SILENCE_END_FRAMES = 20; // ~0.65s silence ends speech — fast response for short commands

// Continuous ambient noise calibration (only during VAD-confirmed silence)
const AMBIENT_BUFFER_SIZE = 300; // ~10 seconds of frames
const AMBIENT_RECALC_INTERVAL = 150; // recalculate every ~5 seconds
let ambientSamples = [];
let ambientFramesSinceCalc = 0;
let calibrated = false;

// ═══ Initialization ═══
async function init() {
  console.log("[SetLoop] offscreen init starting");
  send("vad-status", { status: "loading", message: "Loading models…" });

  // Load ONNX Runtime for Silero VAD
  console.log("[SetLoop] importing onnxruntime-web…");
  ort = await import(chrome.runtime.getURL("ort.wasm.bundle.min.mjs"));
  ort.env.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
  ort.env.wasm.numThreads = 1;
  console.log("[SetLoop] ort loaded");

  // Load Silero VAD model
  console.log("[SetLoop] loading Silero VAD…");
  vadSession = await ort.InferenceSession.create(
    chrome.runtime.getURL("models/silero_vad.onnx"),
    { executionProviders: ["wasm"] }
  );
  vadState = new Float32Array(2 * 1 * 128);
  console.log("[SetLoop] VAD loaded");

  // Load Whisper via @huggingface/transformers
  console.log("[SetLoop] importing transformers.js…");
  const hf = await import(chrome.runtime.getURL("transformers.web.min.js"));
  console.log("[SetLoop] transformers loaded");

  // Configure for local models only — zero network requests
  hf.env.localModelPath = chrome.runtime.getURL("models/");
  hf.env.allowRemoteModels = false;
  hf.env.allowLocalModels = true;

  // Point ONNX WASM to our local copies (same files used by Silero VAD)
  if (hf.env?.backends?.onnx?.wasm) {
    hf.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("");
  }

  console.log("[SetLoop] creating Whisper pipeline…");
  transcriber = await hf.pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
    dtype: "q8",
    device: "wasm",
  });
  console.log("[SetLoop] Whisper pipeline ready");

  initReady = true;
  send("vad-status", { status: "ready" });
  console.log("[SetLoop] init complete, ready for audio");
}

// ═══ Microphone Pipeline ═══
async function startPipeline() {
  console.log("[SetLoop] startPipeline called, initReady:", initReady, "micStream:", !!micStream);

  // Wait for init if it hasn't completed yet
  if (!initReady && initPromise) {
    console.log("[SetLoop] waiting for init to complete…");
    try { await initPromise; } catch {}
  }
  if (!initReady) {
    send("vad-status", { status: "error", message: "Models failed to load" });
    return;
  }
  if (micStream) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    console.log("[SetLoop] getUserMedia OK, tracks:", micStream.getTracks().length);
  } catch (err) {
    console.error("[SetLoop] getUserMedia FAILED:", err);
    send("vad-status", { status: "error", message: "Mic access required — use popup toggle" });
    return;
  }

  audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(micStream);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("vad-processor.js"));
  console.log("[SetLoop] AudioWorklet loaded");

  const node = new AudioWorkletNode(audioCtx, "vad-processor");
  source.connect(node);
  node.port.onmessage = onAudioFrame;
  console.log("[SetLoop] Pipeline running — listening for audio frames");

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

// ═══ Continuous Ambient Noise Calibration ═══
// Only samples RMS during VAD-confirmed silence (prob < 0.1).
// Never drifts from speech. Adapts both up and down as room conditions change.
function updateAmbientCalibration(rms) {
  ambientSamples.push(rms);
  if (ambientSamples.length > AMBIENT_BUFFER_SIZE) ambientSamples.shift();
  ambientFramesSinceCalc++;

  if (ambientFramesSinceCalc >= AMBIENT_RECALC_INTERVAL && ambientSamples.length >= 30) {
    ambientFramesSinceCalc = 0;
    const sorted = [...ambientSamples].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const newThreshold = Math.max(0.005, Math.min(0.1, p90 * 3));
    energyThreshold = newThreshold;
    if (!calibrated) {
      calibrated = true;
      console.log(`[SetLoop] initial calibration: p90=${p90.toFixed(4)}, threshold=${newThreshold.toFixed(4)}`);
    }
  }
}

// ═══ Audio Frame Handler ═══
let frameCount = 0;
async function onAudioFrame(e) {
  const { audio, rms } = e.data;
  frameCount++;

  if (!vadSession) return;

  // Energy gate: skip VAD on quiet frames to save compute.
  // But if already speaking, still feed to VAD — let VAD decide when speech ends.
  if (rms < energyThreshold && !isSpeaking) {
    // Feed quiet frames to ambient calibration (only during true silence)
    updateAmbientCalibration(rms);
    return;
  }

  let prob;
  try {
    prob = await runVAD(audio);
  } catch (err) {
    console.error("[SetLoop] VAD error:", err);
    return;
  }

  // Feed VAD-confirmed silence to ambient calibration (adapts to speaker volume changes)
  if (prob < 0.1 && !isSpeaking) {
    updateAmbientCalibration(rms);
  }

  if (!isSpeaking && prob > vadThreshold) {
    isSpeaking = true;
    speechBuffer = [];
    silenceFrames = 0;
    send("vad-speech-start", {});
    console.log("[SetLoop] speech started");
  }

  if (isSpeaking) {
    speechBuffer.push(new Float32Array(audio));

    const maxFrames = Math.ceil((MAX_SPEECH_SEC * SAMPLE_RATE) / VAD_FRAME);
    if (speechBuffer.length > maxFrames) {
      console.log("[SetLoop] max speech buffer reached, finishing");
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
  console.log(`[SetLoop] speech ended, ${audio.length} samples (${(audio.length / SAMPLE_RATE).toFixed(1)}s)`);
  send("vad-speech-end", {});

  try {
    const text = await transcribe(audio);
    if (text && text.trim()) {
      console.log(`[SetLoop] transcribed: "${text.trim()}"`);
      send("vad-transcript", { text: text.trim() });
    }
  } catch (err) {
    console.error("[SetLoop] Whisper error:", err);
  }
}

// ═══ Silero VAD ═══
async function runVAD(frame) {
  const withContext = new Float32Array(VAD_CONTEXT_SIZE + frame.length);
  withContext.set(vadContext, 0);
  withContext.set(frame, VAD_CONTEXT_SIZE);

  const feeds = {
    input: new ort.Tensor("float32", withContext, [1, withContext.length]),
    state: new ort.Tensor("float32", new Float32Array(vadState), [2, 1, 128]),
    sr: new ort.Tensor("int64", new BigInt64Array([16000n])),
  };

  const out = await vadSession.run(feeds);
  vadState.set(out.stateN.data);
  vadContext.set(frame.subarray(frame.length - VAD_CONTEXT_SIZE));

  return out.output.data[0];
}

// ═══ Whisper Transcription (via @huggingface/transformers) ═══
// Initial prompt primes Whisper to expect our command vocabulary.
// This is the #1 accuracy improvement — the model becomes biased toward
// recognizing "loop", "last", "stop", "wider", "tighter" etc.
const WHISPER_PROMPT = "Loop last twenty at fifty. Loop stop. Loop last thirty at seventy five. Loop wider. Loop tighter. Loop slower. Loop faster. Loop speed sixty. Loop back ten. Loop forward five. Loop bookmark. Loop pause. Loop play.";

async function transcribe(audio) {
  if (!transcriber) return "";
  // Try multiple parameter formats — transformers.js API varies by version
  const result = await transcriber(audio, {
    language: "english",
    task: "transcribe",
    // Direct prompt parameter (transformers.js v4+)
    prompt: WHISPER_PROMPT,
    // Fallback: generate_kwargs (transformers.js v3)
    generate_kwargs: { prompt: WHISPER_PROMPT },
  });
  return result.text || "";
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
  chrome.runtime.sendMessage({ type, ...data }, () => {
    if (chrome.runtime.lastError) { /* receiver may not be ready yet */ }
  });
}

// ═══ Message Handler ═══
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "start-pipeline":
      console.log("[SetLoop] received start-pipeline");
      startPipeline();
      break;
    case "stop-pipeline": stopPipeline(); break;
    case "recalibrate": recalibrate(); break;
    case "set-sensitivity":
      if (typeof msg.threshold === "number") {
        vadThreshold = Math.max(0.1, Math.min(0.95, msg.threshold));
      }
      break;
  }
});

// Boot with timeout
initPromise = Promise.race([
  init(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Model loading timed out (120s)")), INIT_TIMEOUT_MS)
  ),
]).catch(err => {
  console.error("[SetLoop] Init failed:", err);
  send("vad-status", { status: "error", message: err.message });
});
