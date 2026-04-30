const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const SITE = path.join(ROOT, "site");

function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function buildExtension() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const staticFiles = [
    "manifest.json",
    "background.js", "content.js", "popup.js",
    "onboarding-mic.js",
    "popup.html", "onboarding.html", "privacy.html",
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

  if (fs.existsSync("icons")) {
    copyDir("icons", path.join(DIST, "icons"),
      (name) => name === "generate.html" || name === "setloop-icon.png");
  }
}

// Mirror privacy.html and icons into site/ so Cloudflare Pages serves
// /privacy and the favicon/OG image straight from one source of truth.
function buildSite() {
  if (!fs.existsSync(SITE)) return;
  if (fs.existsSync("privacy.html")) {
    copy("privacy.html", path.join(SITE, "privacy", "index.html"));
  }
  if (fs.existsSync("icons")) {
    copyDir("icons", path.join(SITE, "icons"),
      (name) => name === "generate.html" || name === "setloop-icon.png");
  }
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

buildExtension();
buildSite();
console.log(`Built dist/ (${(dirSize(DIST) / 1024).toFixed(0)} KB) and synced site/`);
