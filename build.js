const fs = require("fs");
const path = require("path");

const DIST = path.join(__dirname, "dist");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

async function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Copy ONNX Runtime browser bundle (for Silero VAD)
  copy(
    path.join("node_modules", "onnxruntime-web", "dist", "ort.wasm.bundle.min.mjs"),
    path.join(DIST, "ort.wasm.bundle.min.mjs")
  );

  // Copy @huggingface/transformers browser bundle — patch ALL bare module imports
  const hfDist = path.join("node_modules", "@huggingface", "transformers", "dist");
  let hfCode = fs.readFileSync(path.join(hfDist, "transformers.web.min.js"), "utf8");
  // Redirect ALL bare onnxruntime imports to our local ONNX Runtime WASM bundle.
  // The library gets real classes (InferenceSession, Tensor, env) from both paths.
  // WebGPU features won't work but the library detects WASM-only and falls back.
  hfCode = hfCode.replaceAll('"onnxruntime-web/webgpu"', '"./ort.wasm.bundle.min.mjs"');
  hfCode = hfCode.replaceAll('"onnxruntime-common"', '"./ort.wasm.bundle.min.mjs"');
  // Verify no bare onnxruntime imports remain (excluding string literals like CDN URLs)
  const remaining = hfCode.match(/from\s*"onnxruntime[^"]*"/g) || [];
  if (remaining.length > 0) console.warn("⚠  Unpatched onnxruntime imports:", remaining);
  fs.writeFileSync(path.join(DIST, "transformers.web.min.js"), hfCode);

  // Copy WASM/MJS files that transformers.js needs for ONNX
  for (const f of fs.readdirSync(hfDist)) {
    if (f.endsWith(".wasm") || (f.endsWith(".mjs") && f.includes("ort-wasm"))) {
      copy(path.join(hfDist, f), path.join(DIST, f));
    }
  }

  // Copy static files
  const staticFiles = [
    "offscreen.js", "ort-stub.js", "content.js", "background.js", "popup.js",
    "popup.html", "mic-permission.html", "mic-permission.js",
    "manifest.json", "overlay.css", "offscreen.html",
    "vad-processor.js", "onboarding.html", "privacy.html", "index.html",
  ];
  for (const f of staticFiles) {
    if (fs.existsSync(f)) copy(f, path.join(DIST, f));
  }

  if (fs.existsSync("icons")) copyDir("icons", path.join(DIST, "icons"));

  // Copy ONNX Runtime WASM for Silero VAD
  const wasmDir = path.join("node_modules", "onnxruntime-web", "dist");
  fs.mkdirSync(path.join(DIST, "wasm"), { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
    const src = path.join(wasmDir, f);
    if (fs.existsSync(src)) copy(src, path.join(DIST, "wasm", f));
  }

  // Copy and validate model files
  const requiredModels = [
    "models/silero_vad.onnx",
    "models/Xenova/whisper-base/config.json",
    "models/Xenova/whisper-base/onnx/encoder_model_quantized.onnx",
    "models/Xenova/whisper-base/onnx/decoder_model_merged_quantized.onnx",
    "models/Xenova/whisper-base/tokenizer.json",
  ];
  const missing = requiredModels.filter(f => !fs.existsSync(f) || fs.statSync(f).size === 0);
  if (missing.length > 0) {
    console.error("\n✗ Missing model files:\n  " + missing.join("\n  "));
    console.error("  Run: node scripts/download-models.js\n");
    process.exit(1);
  }
  copyDir("models", path.join(DIST, "models"));

  console.log("✓ Built to dist/");
}

build().catch(err => { console.error(err); process.exit(1); });
