const esbuild = require("esbuild");
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
  // Clean
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Bundle offscreen.js (only file with npm imports)
  await esbuild.build({
    entryPoints: ["offscreen.js"],
    bundle: true,
    format: "esm",
    outfile: path.join(DIST, "offscreen.js"),
    platform: "browser",
    target: "chrome116",
    minify: false, // keep readable for CWS review + portfolio
    external: [],
  });

  // Copy files that don't need bundling
  const staticFiles = [
    "content.js",
    "background.js",
    "popup.js",
    "popup.html",
    "manifest.json",
    "overlay.css",
    "offscreen.html",
    "vad-processor.js",
    "onboarding.html",
    "privacy.html",
    "index.html",
  ];
  for (const f of staticFiles) {
    if (fs.existsSync(f)) copy(f, path.join(DIST, f));
  }

  // Copy icons
  if (fs.existsSync("icons")) copyDir("icons", path.join(DIST, "icons"));

  // Copy ONNX Runtime WASM files
  const wasmDir = path.join("node_modules", "onnxruntime-web", "dist");
  fs.mkdirSync(path.join(DIST, "wasm"), { recursive: true });
  for (const f of fs.readdirSync(wasmDir)) {
    if (f.endsWith(".wasm") || f.endsWith(".mjs")) {
      copy(path.join(wasmDir, f), path.join(DIST, "wasm", f));
    }
  }

  // Copy model files
  if (fs.existsSync("models")) {
    copyDir("models", path.join(DIST, "models"));
  } else {
    console.warn("\n⚠  models/ not found — run: node scripts/download-models.js\n");
  }

  console.log("✓ Built to dist/");
}

build().catch(err => { console.error(err); process.exit(1); });
