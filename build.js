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

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const staticFiles = [
    "manifest.json",
    "background.js", "content.js", "popup.js",
    "onboarding-mic.js",
    "popup.html",
    "onboarding.html", "privacy.html", "index.html",
    "overlay.css",
  ];
  for (const f of staticFiles) {
    if (!fs.existsSync(f)) continue;
    const dest = path.join(DIST, f);
    if (f === "content.js") {
      // Always ship with debug logging off regardless of source setting
      const src = fs.readFileSync(f, "utf8").replace(
        /const DEBUG = true;/g, "const DEBUG = false;"
      );
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, src);
    } else {
      copy(f, dest);
    }
  }

  if (fs.existsSync("icons")) copyDir("icons", path.join(DIST, "icons"));

  const size = dirSize(DIST);
  console.log(`Built to dist/ (${(size / 1024).toFixed(0)} KB)`);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

build();
