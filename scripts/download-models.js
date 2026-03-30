const fs = require("fs");
const path = require("path");
const https = require("https");

const MODELS_DIR = path.join(__dirname, "..", "models");

const FILES = [
  // Silero VAD v5
  {
    url: "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx",
    dest: "silero_vad.onnx",
  },
  // Whisper Tiny — quantized encoder
  {
    url: "https://huggingface.co/Xenova/whisper-tiny/resolve/main/onnx/encoder_model_quantized.onnx",
    dest: "whisper-tiny/encoder_model_quantized.onnx",
  },
  // Whisper Tiny — quantized decoder (non-merged, no KV cache needed)
  {
    url: "https://huggingface.co/Xenova/whisper-tiny/resolve/main/onnx/decoder_model_quantized.onnx",
    dest: "whisper-tiny/decoder_model_quantized.onnx",
  },
  // Tokenizer
  {
    url: "https://huggingface.co/Xenova/whisper-tiny/resolve/main/tokenizer.json",
    dest: "whisper-tiny/tokenizer.json",
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, { headers: { "User-Agent": "SetLoop/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          const next = loc.startsWith("/") ? new URL(loc, u).href : loc;
          get(next);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers["content-length"], 10) || 0;
        let downloaded = 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(0);
            process.stdout.write(`\r  ${path.basename(dest)}: ${pct}%`);
          }
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); console.log(); resolve(); });
      }).on("error", reject);
    };
    get(url);
  });
}

async function main() {
  console.log("Downloading models to models/\n");
  for (const { url, dest } of FILES) {
    const fullDest = path.join(MODELS_DIR, dest);
    if (fs.existsSync(fullDest)) {
      console.log(`  ${dest} — already exists, skipping`);
      continue;
    }
    console.log(`  Downloading ${dest}…`);
    await download(url, fullDest);
  }
  console.log("\n✓ All models downloaded");
}

main().catch(err => { console.error(err); process.exit(1); });
