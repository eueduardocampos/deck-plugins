"use strict";
// Copia lib/render.js e lib/ws.js para o bin/ de cada plugin (cada .sdPlugin e uma pasta isolada).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LIB = ["render.js", "ws.js"];
const pluginsDir = path.join(ROOT, "plugins");

let n = 0;
for (const name of fs.readdirSync(pluginsDir)) {
  const plugDir = path.join(pluginsDir, name);
  if (!fs.statSync(plugDir).isDirectory()) continue;
  for (const sd of fs.readdirSync(plugDir).filter((d) => d.endsWith(".sdPlugin"))) {
    const bin = path.join(plugDir, sd, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const f of LIB) {
      fs.copyFileSync(path.join(ROOT, "lib", f), path.join(bin, f));
      n++;
    }
    console.log(`ok: ${path.relative(ROOT, bin)}`);
  }
}
console.log(`${n} arquivos copiados`);
