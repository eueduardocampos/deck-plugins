"use strict";
/**
 * fake_sd_sysmonitor.js — Stream Deck falso para validar o plugin sysmonitor sem hardware.
 *
 * Sobe um servidor WebSocket que fala o protocolo real do Stream Deck e spawna o plugin.js de
 * verdade, mandando `willAppear` para TODAS as acoes do manifest, girando cada dial por todos os
 * itens e conferindo o que volta (setImage / setFeedback). Nao toca em hardware, LEDs nem
 * drivers; no modo padrao nao spawna nvidia-smi nem PowerShell (SYSMON_FAKE=1).
 *
 * Uso:
 *   node test/fake_sd_sysmonitor.js                  (exit 0 = tudo passou)
 *   node test/fake_sd_sysmonitor.js --real [--seconds=20]
 *       fontes REAIS: spawna o coletor PowerShell e o nvidia-smi; mede CPU do plugin e do
 *       coletor, confere que o coletor religa se morrer e que termina junto com o plugin
 *       (inclusive quando o plugin e morto na marra).
 *
 * Cenarios do modo padrao:
 *   1. completo  — fontes sinteticas + LibreHardwareMonitor falso (HTTP real)
 *   2. sem dado  — nvidia-smi ausente, coletor morto, LHM fora do ar -> `n/d`
 */

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "sysmonitor", "digital.astronauta.sysmonitor.sdPlugin");
const PLUGIN = path.join(PLUGIN_DIR, "bin", "plugin.js");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const NS = "digital.astronauta.sysmonitor";

const REAL = process.argv.includes("--real");
const SECONDS = Number((process.argv.find((a) => a.startsWith("--seconds=")) || "--seconds=20").split("=")[1]) || 20;

// ---------------------------------------------------------------- contrato (docs/00-convencoes.md)

const CONTRACT_KEYS = [
  "cpu", "cputemp", "ram", "gpu", "gputemp", "vram", "gpupower", "gpufan", "gpuclock",
  "disk", "diskwrite", "diskread", "netdown", "netup",
];
const CONTRACT_DIALS = ["dialcpu", "dialmem", "dialgpu", "dialdisk", "dialnet"];

// ---------------------------------------------------------------- resultado

const failures = [];
let passed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, stepMs = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return !!pred();
}

// ================================================================ 0. testes puros (sem processo)

function unitTests() {
  console.log("\n== 0. manifest e adaptador puro ==");

  // ---- manifest
  const manifestPath = path.join(PLUGIN_DIR, "manifest.json");
  let m = null;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    assert(false, `manifest.json e JSON valido (${err.message})`);
    return;
  }
  assert(true, "manifest.json e JSON valido");
  assert(m.UUID === NS, `UUID = ${NS}`);
  assert(m.SDKVersion === 2 && m.Nodejs && m.Nodejs.Version === "20", "SDKVersion 2, Nodejs 20");
  assert(m.Software && m.Software.MinimumVersion === "6.5", "Software.MinimumVersion 6.5");
  assert(/^2\.1\.0\.0$/.test(m.Version), `Version 2.1.0.0 (${m.Version})`);
  assert(
    Array.isArray(m.OS) && m.OS.length === 1 && m.OS[0].Platform === "windows" && m.OS[0].MinimumVersion === "10",
    "OS: windows 10+"
  );
  const uuids = m.Actions.map((a) => a.UUID);
  assert(uuids.length === 19, `19 acoes (${uuids.length})`);
  const esperados = [...CONTRACT_KEYS, ...CONTRACT_DIALS].map((a) => `${NS}.${a}`);
  assert(
    esperados.every((u) => uuids.includes(u)) && uuids.length === new Set(uuids).size,
    "UUIDs identicos ao contrato (sem repetidos)"
  );
  const teclas = m.Actions.filter((a) => a.Controllers.join() === "Keypad").length;
  const dials = m.Actions.filter((a) => a.Controllers.join() === "Encoder").length;
  assert(teclas === 14 && dials === 5, `14 teclas + 5 dials (${teclas}+${dials})`);

  const faltando = [];
  const existe = (rel) => fs.existsSync(path.join(PLUGIN_DIR, rel));
  const imagem = (rel) => existe(`${rel}.png`) && existe(`${rel}@2x.png`);
  for (const rel of [m.CodePath]) if (!existe(rel)) faltando.push(rel);
  for (const rel of [m.Icon, m.CategoryIcon]) if (!imagem(rel)) faltando.push(rel);
  for (const a of m.Actions) {
    if (!imagem(a.Icon)) faltando.push(a.Icon);
    if (!existe(a.PropertyInspectorPath)) faltando.push(a.PropertyInspectorPath);
    for (const s of a.States || []) if (!imagem(s.Image)) faltando.push(s.Image);
    if (a.Encoder && !existe(a.Encoder.layout)) faltando.push(a.Encoder.layout);
  }
  for (const rel of ["bin/render.js", "bin/ws.js", "bin/sources.js", "bin/views.js", "ui/sdpi.css"]) {
    if (!existe(rel)) faltando.push(rel);
  }
  assert(faltando.length === 0, `caminhos de imagem/layout/inspector existem${faltando.length ? ` (faltam: ${[...new Set(faltando)].join(", ")})` : ""}`);

  // render.js/ws.js sao copia exata de lib/ (nunca editados a mao)
  for (const f of ["render.js", "ws.js"]) {
    const a = fs.readFileSync(path.join(ROOT, "lib", f));
    const b = fs.readFileSync(path.join(PLUGIN_DIR, "bin", f));
    assert(a.equals(b), `bin/${f} identico a lib/${f}`);
  }

  // ---- views.js e sources.js (funcoes puras)
  const V = require(path.join(PLUGIN_DIR, "bin", "views.js"));
  const S = require(path.join(PLUGIN_DIR, "bin", "sources.js"));

  assert(
    V.KEY_ACTIONS.join() === CONTRACT_KEYS.join() && V.DIAL_ACTIONS.join() === CONTRACT_DIALS.join(),
    "views.js: catalogo de acoes = contrato"
  );

  assert(V.levelFor("cpu", 79) === "safe" && V.levelFor("cpu", 80) === "warn" && V.levelFor("cpu", 95) === "danger", "limiar CPU 80/95");
  assert(V.levelFor("gputemp", 74) === "safe" && V.levelFor("gputemp", 75) === "warn" && V.levelFor("gputemp", 85) === "danger", "limiar temp GPU 75/85");
  assert(V.levelFor("cputemp", 80) === "warn" && V.levelFor("cputemp", 90) === "danger", "limiar temp CPU 80/90");
  assert(V.levelFor("disk", 84) === "safe" && V.levelFor("disk", 85) === "warn" && V.levelFor("disk", 95) === "danger", "limiar disco 85/95");
  assert(V.levelFor("diskwrite", 1e12) === "safe" && V.levelFor("netdown", 1e12) === "safe", "gravacao/leitura/rede sem limiar (safe)");
  assert(V.levelFor("cpu", null) === "offline", "sem numero = offline");

  let r = V.fmtByteRate(352228);
  assert(r.n === "344" && r.unit === "KB/s", `352228 B/s -> ${r.n} ${r.unit}`);
  r = V.fmtByteRate(5 * 1048576);
  assert(r.n === "5.0" && r.unit === "MB/s", `5 MiB/s -> ${r.n} ${r.unit}`);
  r = V.fmtByteRate(2.5 * 1073741824);
  assert(r.n === "2.5" && r.unit === "GB/s", `2.5 GiB/s -> ${r.n} ${r.unit}`);
  r = V.fmtBitRate(37134698);
  assert(r.n === "297" && r.unit === "Mb/s", `37134698 B/s -> ${r.n} ${r.unit}`);
  r = V.fmtBitRate(500);
  assert(r.unit === "kb/s", `500 B/s -> ${r.n} ${r.unit}`);

  const tree = {
    Text: "Sensor",
    Children: [
      {
        Text: "ASTRO-PC",
        Children: [
          {
            Text: "AMD Ryzen 7 5700X",
            ImageURL: "images_icon/cpu.png",
            Children: [
              { Text: "Voltages", Children: [{ Text: "Core #1 VID", Value: "1,125 V", Type: "Voltage" }] },
              {
                Text: "Temperatures",
                Children: [
                  { Text: "Core #1", Value: "47,0 °C", Type: "Temperature" },
                  { Text: "Core (Tctl/Tdie)", Value: "52,3 °C", Type: "Temperature" },
                ],
              },
            ],
          },
          { Text: "AMD Radeon RX 6600", ImageURL: "images_icon/ati.png", Children: [{ Text: "GPU Core", Value: "61,0 °C" }] },
          { Text: "NVIDIA GeForce RTX 3060", ImageURL: "images_icon/nvidia.png", Children: [{ Text: "GPU Core", Value: "36.0 °C", Type: "Temperature" }] },
        ],
      },
    ],
  };
  const t = S.findCpuTemp(tree);
  assert(t && Math.abs(t.temp - 52.3) < 1e-9, `LHM: acha Core (Tctl/Tdie), ignora GPUs (${t && t.temp})`);
  assert(S.findCpuTemp({ Text: "Sensor", Children: [] }) === null, "LHM: arvore sem CPU -> null");
  assert(S.findCpuTemp("lixo") === null, "LHM: payload invalido -> null (sem excecao)");

  const g = S.parseGpuLine("26, 36, 2145, 12288, 28.09, 168.30, [N/A], 210, 2100, 405, 7501, 6, NVIDIA GeForce RTX 3060");
  assert(g && g.util === 26 && g.fan === null && g.wattsLimit === 168.3 && g.name === "NVIDIA GeForce RTX 3060", "nvidia-smi: parse, [N/A] vira null");
  assert(S.parseGpuLine("lixo") === null, "nvidia-smi: linha curta -> null");

  assert(S.parseCollectorLine("Aviso: algo") === null, "coletor: linha de lixo ignorada");
  assert(S.parseCollectorLine('{"ts":1,"disks":[]') === null, "coletor: JSON cortado ignorado");
  assert(S.parseCollectorLine('﻿{"ts":1}') !== null, "coletor: tolera BOM");

  const sum = S.summarizeIo({
    disks: [{ n: "0 C: D:", w: 10, r: 20 }, { n: "1 E:", w: 1, r: 2 }, { n: "_Total", w: 11, r: 22 }],
    net: [
      { n: "Realtek Wi-Fi", rx: 1000, tx: 100 },
      { n: "Loopback Pseudo-Interface 1", rx: 5e9, tx: 5e9 },
      { n: "vEthernet (WSL)", rx: 7e9, tx: 7e9 },
    ],
    cpu: { baseMHz: 3401, perf: 129 },
  });
  assert(sum.disk.C && sum.disk.D && sum.disk.E && sum.disk.total.w === 11, "coletor: '0 C: D:' vira C e D; _Total vira total");
  assert(sum.netDown === 1000 && sum.netUp === 100, "rede: loopback e virtuais fora da soma");
  assert(Math.round(sum.cpufreq.mhz) === 4387, `frequencia = base x perf (${Math.round(sum.cpufreq.mhz)} MHz)`);

  // estado nenhum: nada pode lancar e toda tecla diz alguma coisa
  let todasComTexto = true;
  for (const a of V.KEY_ACTIONS) {
    const v = V.view(null, a, {});
    if (!v.label || !v.value || v.level !== "offline") todasComTexto = false;
  }
  for (const a of V.DIAL_ACTIONS) {
    for (const v of V.dialItems(null, a, {}, {})) if (!v.label || !v.value) todasComTexto = false;
  }
  assert(todasComTexto, "views com estado nulo: todas dizem o motivo (n/d ou ...), nada em branco");
}

// ================================================================ infraestrutura do Stream Deck falso

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function writeFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + texto (servidor nao mascara)
  socket.write(Buffer.concat([header, payload]));
}

function makeFrameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buffer.length < off + 2) return;
        len = buffer.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buffer.length < off + 8) return;
        len = Number(buffer.readBigUInt64BE(off));
        off += 8;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < off + 4) return;
        mask = buffer.subarray(off, off + 4);
        off += 4;
      }
      if (buffer.length < off + len) return;
      const payload = Buffer.from(buffer.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(off + len);
      if (opcode === 0x1) onMessage(payload.toString("utf8"));
      if (opcode === 0x8) return;
    }
  };
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** data URI do setImage/canvas -> SVG. */
function decodeUri(uri) {
  const i = String(uri || "").indexOf(",");
  if (i < 0) return "";
  try {
    return decodeURIComponent(uri.slice(i + 1));
  } catch {
    return "";
  }
}

/** [rotulo, valor, detalhe] do SVG do R.clean. */
function textsOf(svg) {
  return [...String(svg).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1]));
}

/**
 * Uma sessao: sobe o SD falso, spawna o plugin, apresenta as instancias e roda `script(ctl)`.
 * Ao fim fecha o socket (o plugin tem que sair sozinho) e devolve o codigo de saida dele.
 */
async function session({ env, global, instances, script, keepAlive = false }) {
  const images = new Map(); // context -> SVG (ultimo)
  const feedback = new Map(); // context -> SVG (ultimo canvas)
  const counts = { setImage: 0, setFeedback: 0, showOk: 0, setSettings: 0 };
  const feedbackCount = new Map();
  const pluginLog = [];
  const pi = []; // payloads que o plugin mandou ao inspector
  let sock = null;
  let registered = false;

  const send = (o) => sock && writeFrame(sock, JSON.stringify(o));

  const server = net.createServer((socket) => {
    sock = socket;
    let upgraded = false;
    let head = Buffer.alloc(0);
    const reader = makeFrameReader((text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      switch (msg.event) {
        case "registerPlugin":
          registered = true;
          break;
        case "getGlobalSettings":
          send({ event: "didReceiveGlobalSettings", payload: { settings: global } });
          // depois das globais, as teclas aparecem (como no app real)
          setTimeout(() => {
            for (const i of instances) {
              send({
                event: "willAppear",
                action: `${NS}.${i.action}`,
                context: i.context,
                payload: { controller: i.controller, settings: i.settings || {} },
              });
            }
          }, 30);
          break;
        case "setImage":
          counts.setImage++;
          images.set(msg.context, decodeUri(msg.payload && msg.payload.image));
          break;
        case "setFeedback":
          counts.setFeedback++;
          feedback.set(msg.context, decodeUri(msg.payload && msg.payload.canvas));
          feedbackCount.set(msg.context, (feedbackCount.get(msg.context) || 0) + 1);
          break;
        case "showOk":
          counts.showOk++;
          break;
        case "sendToPropertyInspector":
          pi.push(msg.payload);
          break;
        case "setSettings":
          counts.setSettings++;
          send({ event: "didReceiveSettings", action: "", context: msg.context, payload: { settings: msg.payload } });
          break;
        default:
          break;
      }
    });
    socket.on("data", (chunk) => {
      if (upgraded) return reader(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const header = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(header);
      socket.write(
        ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${wsAccept(key[1])}`, "", ""].join("\r\n")
      );
      upgraded = true;
      if (rest.length) reader(rest);
    });
    socket.on("error", () => {});
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const wsPort = server.address().port;

  const child = spawn(
    process.execPath,
    [PLUGIN, "-port", String(wsPort), "-pluginUUID", "test-uuid", "-registerEvent", "registerPlugin", "-info", "{}"],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }
  );
  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code === null ? "killed" : code;
  });
  const onLine = (chunk) => {
    for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) pluginLog.push(l.trim());
  };
  child.stdout.on("data", onLine);
  child.stderr.on("data", onLine);

  const ctl = {
    child,
    counts,
    pluginLog,
    pi,
    send,
    sleep,
    waitFor,
    image: (ctx) => images.get(ctx) || "",
    canvas: (ctx) => feedback.get(ctx) || "",
    texts: (ctx) => textsOf(images.get(ctx) || feedback.get(ctx) || ""),
    feedbackCount: (ctx) => feedbackCount.get(ctx) || 0,
    exitCode: () => exitCode,
    registered: () => registered,
    closeSocket: () => sock && sock.destroy(),
  };

  let result;
  const aparece = await waitFor(() => instances.every((i) => images.has(i.context) || feedback.has(i.context)), 8000);
  assert(aparece, "todas as instancias desenharam em ate 8 s");
  if (aparece) await script(ctl);

  if (!keepAlive) {
    // fecha o socket: o plugin tem que sair sozinho (e levar o coletor junto)
    ctl.closeSocket();
    const saiu = await waitFor(() => exitCode !== null, 5000);
    if (!saiu) child.kill();
    result = { exited: saiu, code: exitCode };
    server.close();
  } else {
    result = { child, server, ctl };
  }
  return result;
}

// ---------------------------------------------------------------- instancias

function allInstances(extra = []) {
  const list = [];
  for (const a of CONTRACT_KEYS) {
    list.push({ action: a, context: `ctx-${a}`, controller: "Keypad", settings: a === "disk" ? { drive: "C" } : a === "diskwrite" || a === "diskread" ? { disk: "total" } : {} });
  }
  for (const a of CONTRACT_DIALS) list.push({ action: a, context: `ctx-${a}`, controller: "Encoder", settings: {} });
  return list.concat(extra);
}

const EXTRAS = [
  { action: "disk", context: "ctx-disk-d", controller: "Keypad", settings: { drive: "D" } },
  { action: "disk", context: "ctx-disk-z", controller: "Keypad", settings: { drive: "Z" } },
  { action: "diskwrite", context: "ctx-diskwrite-c", controller: "Keypad", settings: { disk: "C" } },
  { action: "diskread", context: "ctx-diskread-q", controller: "Keypad", settings: { disk: "Q" } },
];

function startFakeLhm(tree) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/data.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tree));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const LHM_TREE = {
  id: 0,
  Text: "Sensor",
  Children: [
    {
      Text: "ASTRO-PC",
      ImageURL: "images_icon/computer.png",
      Children: [
        {
          Text: "AMD Ryzen 7 5700X",
          ImageURL: "images_icon/cpu.png",
          Children: [
            {
              Text: "Temperatures",
              Children: [
                { Text: "Core #1", Value: "47,0 °C", Type: "Temperature" },
                { Text: "Core (Tctl/Tdie)", Value: "52,3 °C", Type: "Temperature" },
              ],
            },
          ],
        },
        {
          Text: "NVIDIA GeForce RTX 3060",
          ImageURL: "images_icon/nvidia.png",
          Children: [{ Text: "Temperatures", Children: [{ Text: "GPU Core", Value: "36,0 °C", Type: "Temperature" }] }],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------- verificacoes comuns

function printTable(ctl, contexts) {
  for (const c of contexts) {
    const t = ctl.texts(c);
    console.log(`        ${c.padEnd(18)} | ${String(t[0] || "").padEnd(14)} | ${String(t[1] || "").padEnd(10)} | ${t[2] || ""}`);
  }
}

/** Nenhuma tecla em branco: rotulo e valor com texto, e e o desenho do R.clean (nao blank). */
function checkNoBlank(ctl, contexts, quando) {
  const brancas = [];
  for (const c of contexts) {
    const t = ctl.texts(c);
    if (t.length < 3 || !t[0] || !t[1]) brancas.push(c);
  }
  assert(brancas.length === 0, `${quando}: nenhuma tecla/dial em branco${brancas.length ? ` (${brancas.join(", ")})` : ""}`);
}

async function rotateAll(ctl, ctx, maxItens) {
  const vistos = [];
  vistos.push(ctl.texts(ctx).join("|"));
  for (let i = 0; i < maxItens; i++) {
    const antes = ctl.feedbackCount(ctx);
    ctl.send({ event: "dialRotate", action: `${NS}.x`, context: ctx, payload: { ticks: 1 } });
    await waitFor(() => ctl.feedbackCount(ctx) > antes, 1500, 20);
    await sleep(40);
    vistos.push(ctl.texts(ctx).join("|"));
  }
  return vistos;
}

// ================================================================ 1. cenario completo

async function scenarioCompleto() {
  console.log("\n== 1. completo: fontes sinteticas (SYSMON_FAKE=1) + LHM falso ==");
  const lhm = await startFakeLhm(LHM_TREE);
  const instances = allInstances(EXTRAS);
  const ctxs = instances.map((i) => i.context);

  const r = await session({
    env: { SYSMON_FAKE: "1", SYSMON_FAKE_MISSING: "" },
    global: { refreshCpuSeconds: 1, refreshGpuSeconds: 1, refreshDiskSeconds: 10, refreshIoSeconds: 1, lhmUrl: lhm.url, drives: ["C", "D", "E"] },
    instances,
    script: async (ctl) => {
      assert(ctl.registered(), "plugin registrou (registerPlugin)");
      // espera as fontes (CPU precisa de 2 amostras; LHM e io tem 1 ciclo)
      await waitFor(() => /%$/.test(ctl.texts("ctx-cpu")[1] || "") && /°C$/.test(ctl.texts("ctx-cputemp")[1] || "") && /^\d/.test(ctl.texts("ctx-netdown")[1] || ""), 6000);
      await sleep(400);

      console.log("  -- teclas --");
      printTable(ctl, ctxs.filter((c) => !c.startsWith("ctx-dial")));
      for (const a of CONTRACT_KEYS) assert(ctl.image(`ctx-${a}`).length > 100, `tecla .${a} desenhou (setImage)`);
      for (const a of CONTRACT_DIALS) assert(ctl.canvas(`ctx-${a}`).length > 100, `dial .${a} desenhou (setFeedback)`);
      checkNoBlank(ctl, ctxs, "completo");

      const t = (c) => ctl.texts(c);
      assert(/^\d+%$/.test(t("ctx-cpu")[1]) && /threads/.test(t("ctx-cpu")[2]), `cpu: ${t("ctx-cpu")[1]} / ${t("ctx-cpu")[2]}`);
      assert(t("ctx-cputemp")[1] === "52°C", `cputemp via LHM falso: ${t("ctx-cputemp")[1]} (a GPU a 36 °C ficou de fora)`);
      assert(t("ctx-ram")[1] === "56%" && t("ctx-ram")[2] === "18/32 GB", `ram: ${t("ctx-ram")[1]} ${t("ctx-ram")[2]}`);
      assert(t("ctx-gpu")[1] === "26%" && t("ctx-gpu")[2] === "36°C", `gpu: ${t("ctx-gpu")[1]} ${t("ctx-gpu")[2]}`);
      assert(t("ctx-gputemp")[1] === "36°C", `gputemp: ${t("ctx-gputemp")[1]}`);
      assert(t("ctx-vram")[1] === "17%" && t("ctx-vram")[2] === "2.1/12 GB", `vram: ${t("ctx-vram")[1]} ${t("ctx-vram")[2]}`);
      assert(t("ctx-gpupower")[1] === "28 W" && /17% do limite/.test(t("ctx-gpupower")[2]), `gpupower: ${t("ctx-gpupower")[1]} ${t("ctx-gpupower")[2]}`);
      assert(t("ctx-gpufan")[1] === "30%", `gpufan: ${t("ctx-gpufan")[1]}`);
      assert(t("ctx-gpuclock")[1] === "210" && /MHz · 10% máx/.test(t("ctx-gpuclock")[2]), `gpuclock: ${t("ctx-gpuclock")[1]} ${t("ctx-gpuclock")[2]}`);
      assert(t("ctx-disk")[0] === "DISCO C:" && t("ctx-disk")[1] === "88%" && /livres/.test(t("ctx-disk")[2]), `disk C: ${t("ctx-disk").join(" / ")}`);
      assert(t("ctx-disk-d")[0] === "DISCO D:" && t("ctx-disk-d")[1] === "46%", `disk D: ${t("ctx-disk-d").join(" / ")}`);
      assert(t("ctx-disk-z")[1] === "n/d" && t("ctx-disk-z")[2] === "sem unidade", `disk Z (nao existe): ${t("ctx-disk-z").join(" / ")}`);
      assert(t("ctx-diskwrite")[1] === "344" && t("ctx-diskwrite")[2] === "KB/s", `diskwrite total: ${t("ctx-diskwrite")[1]} ${t("ctx-diskwrite")[2]}`);
      assert(t("ctx-diskwrite-c")[0] === "GRAV. C:" && t("ctx-diskwrite-c")[1] === "344", `diskwrite C: ${t("ctx-diskwrite-c").join(" / ")}`);
      assert(t("ctx-diskread-q")[1] === "n/d" && t("ctx-diskread-q")[2] === "sem disco", `diskread Q (nao existe): ${t("ctx-diskread-q").join(" / ")}`);
      assert(t("ctx-diskread")[1] === "94" && t("ctx-diskread")[2] === "KB/s", `diskread total: ${t("ctx-diskread")[1]} ${t("ctx-diskread")[2]}`);
      assert(t("ctx-netdown")[1] === "297" && t("ctx-netdown")[2] === "Mb/s", `netdown: ${t("ctx-netdown")[1]} ${t("ctx-netdown")[2]} (loopback fora)`);
      assert(t("ctx-netup")[1] === "6.1" && t("ctx-netup")[2] === "Mb/s", `netup: ${t("ctx-netup")[1]} ${t("ctx-netup")[2]}`);

      // cores: safe = accent da familia
      const cor = (c) => (/<rect x="12" y="8"[^>]*fill="(#[0-9a-f]{6})"/i.exec(ctl.image(c)) || [])[1];
      assert(cor("ctx-cpu") === "#5aa9ff", `cor da familia CPU #5aa9ff (${cor("ctx-cpu")})`);
      assert(cor("ctx-ram") === "#b48cff", `cor da familia RAM #b48cff (${cor("ctx-ram")})`);
      assert(cor("ctx-gpu") === "#76b900", `cor da familia GPU #76b900 (${cor("ctx-gpu")})`);
      assert(cor("ctx-diskwrite") === "#ffb454", `cor da familia disco #ffb454 (${cor("ctx-diskwrite")})`);
      assert(cor("ctx-disk") === "#d29922", `disco a 88% (>= 85) fica amarelo/warn (${cor("ctx-disk")})`);
      assert(cor("ctx-netdown") === "#4dd0e1", `cor da familia rede #4dd0e1 (${cor("ctx-netdown")})`);

      // dials: girar por TODOS os itens
      console.log("  -- dials (girando) --");
      const ESPERADO = { dialcpu: 4, dialmem: 3, dialgpu: 6, dialdisk: 5, dialnet: 3 };
      for (const d of CONTRACT_DIALS) {
        const n = ESPERADO[d];
        const vistos = await rotateAll(ctl, `ctx-${d}`, n);
        const unicos = new Set(vistos.slice(0, n));
        console.log(`        ${d}: ${vistos.slice(0, n).map((v) => v.split("|").slice(0, 2).join("=")).join("  ·  ")}`);
        assert(unicos.size === n, `.${d} tem ${n} itens e todos diferentes (${unicos.size})`);
        assert(vistos[n] === vistos[0], `.${d} da a volta depois de ${n} giros`);
        assert(vistos.every((v) => v.split("|")[1]), `.${d} sem item em branco`);
      }

      // sentido inverso volta um item
      {
        const ctx = "ctx-dialmem";
        const a = ctl.texts(ctx).join("|");
        ctl.send({ event: "dialRotate", action: `${NS}.dialmem`, context: ctx, payload: { ticks: 1 } });
        await sleep(150);
        ctl.send({ event: "dialRotate", action: `${NS}.dialmem`, context: ctx, payload: { ticks: -1 } });
        await sleep(150);
        assert(ctl.texts(ctx).join("|") === a, "dial gira nos dois sentidos");
      }

      // toque forca leitura (showOk) e teclas/dials abrem o Gerenciador de Tarefas
      const ok0 = ctl.counts.showOk;
      ctl.send({ event: "touchTap", action: `${NS}.dialcpu`, context: "ctx-dialcpu", payload: {} });
      await waitFor(() => ctl.counts.showOk > ok0, 1500);
      assert(ctl.counts.showOk > ok0, "touchTap respondeu com showOk");
      ctl.send({ event: "keyDown", action: `${NS}.cpu`, context: "ctx-cpu", payload: {} });
      ctl.send({ event: "dialDown", action: `${NS}.dialgpu`, context: "ctx-dialgpu", payload: {} });
      await waitFor(() => ctl.pluginLog.filter((l) => /abriria o Gerenciador/.test(l)).length >= 2, 1500);
      assert(ctl.pluginLog.filter((l) => /abriria o Gerenciador/.test(l)).length >= 2, "keyDown e dialDown abrem o Gerenciador de Tarefas (taskmgr)");

      // settings da instancia: trocar a unidade da tecla `disk`
      ctl.send({ event: "didReceiveSettings", action: `${NS}.disk`, context: "ctx-disk", payload: { settings: { drive: "E" } } });
      await waitFor(() => ctl.texts("ctx-disk")[0] === "DISCO E:", 1500);
      assert(ctl.texts("ctx-disk")[0] === "DISCO E:" && ctl.texts("ctx-disk")[1] === "51%", `disk muda de unidade pelo inspector (${ctl.texts("ctx-disk").join(" / ")})`);

      // inspector pede listas ao plugin (acao explicita; a tecla nunca varre letras)
      ctl.send({ event: "sendToPlugin", action: `${NS}.disk`, context: "ctx-disk", payload: { pedido: "drives" } });
      ctl.send({ event: "sendToPlugin", action: `${NS}.diskwrite`, context: "ctx-diskwrite", payload: { pedido: "discos" } });
      await waitFor(() => ctl.pi.some((p) => p.drives) && ctl.pi.some((p) => p.discos), 1500);
      const drivesPi = (ctl.pi.find((p) => p.drives) || {}).drives || [];
      const discosPi = (ctl.pi.find((p) => p.discos) || {}).discos || [];
      assert(["C", "D", "E"].every((d) => drivesPi.includes(d)), `inspector: unidades que respondem (${drivesPi.join(",")})`);
      assert(["C", "D", "E"].every((d) => discosPi.includes(d)), `inspector: discos vistos pelo coletor (${discosPi.join(",")})`);
    },
  });

  lhm.srv.close();
  assert(r.exited && r.code === 0, `plugin sai sozinho (exit 0) quando o Stream Deck fecha o socket (${r.code})`);
}

// ================================================================ 2. cenario sem dado

async function scenarioSemDado() {
  console.log("\n== 2. sem dado: nvidia-smi ausente, coletor morto, LHM fora do ar ==");
  const instances = allInstances(EXTRAS);
  const ctxs = instances.map((i) => i.context);

  const r = await session({
    env: { SYSMON_FAKE: "1", SYSMON_FAKE_MISSING: "gpu,io" },
    // porta 1: conexao recusada na hora = "LHM fora do ar"
    global: { refreshCpuSeconds: 1, refreshGpuSeconds: 1, refreshDiskSeconds: 10, refreshIoSeconds: 1, lhmUrl: "http://127.0.0.1:1", drives: ["C", "D", "E"] },
    instances,
    script: async (ctl) => {
      await waitFor(() => /%$/.test(ctl.texts("ctx-cpu")[1] || "") && ctl.texts("ctx-cputemp")[2] === "sem LHM" && ctl.texts("ctx-gpu")[1] === "n/d", 6000);
      await sleep(300);
      console.log("  -- teclas --");
      printTable(ctl, ctxs);
      checkNoBlank(ctl, ctxs, "sem dado");

      const t = (c) => ctl.texts(c);
      for (const a of ["gpu", "gputemp", "vram", "gpupower", "gpufan", "gpuclock"]) {
        assert(t(`ctx-${a}`)[1] === "n/d" && t(`ctx-${a}`)[2] === "sem GPU", `.${a}: n/d (${t(`ctx-${a}`)[2]}) sem GPU`);
      }
      assert(t("ctx-cputemp")[1] === "n/d" && t("ctx-cputemp")[2] === "sem LHM", `cputemp: n/d (${t("ctx-cputemp")[2]}) com LHM fora do ar`);
      for (const a of ["diskwrite", "diskread", "netdown", "netup"]) {
        assert(t(`ctx-${a}`)[1] === "n/d" && t(`ctx-${a}`)[2] === "sem coletor", `.${a}: n/d (${t(`ctx-${a}`)[2]}) com coletor morto`);
      }
      // o que NAO depende das fontes ausentes continua funcionando
      assert(/^\d+%$/.test(t("ctx-cpu")[1]), `cpu segue funcionando (${t("ctx-cpu")[1]})`);
      assert(t("ctx-ram")[1] === "56%", `ram segue funcionando (${t("ctx-ram")[1]})`);
      assert(t("ctx-disk")[1] === "88%", `disk segue funcionando (${t("ctx-disk")[1]})`);

      // nivel offline = cinza (#8b949e), nunca a cor da familia mentindo
      const cor = (c) => (/<rect x="12" y="8"[^>]*fill="(#[0-9a-f]{6})"/i.exec(ctl.image(c)) || [])[1];
      assert(cor("ctx-gpu") === "#8b949e", `sem dado fica cinza offline (${cor("ctx-gpu")})`);

      console.log("  -- dials (girando) --");
      const ESPERADO = { dialcpu: 3, dialmem: 3, dialgpu: 6, dialdisk: 5, dialnet: 3 };
      for (const d of CONTRACT_DIALS) {
        const n = ESPERADO[d];
        const vistos = await rotateAll(ctl, `ctx-${d}`, n);
        console.log(`        ${d}: ${vistos.slice(0, n).map((v) => v.split("|").slice(0, 3).join("=")).join("  ·  ")}`);
        assert(vistos.slice(0, n).every((v) => v.split("|")[0] && v.split("|")[1]), `.${d} sem item em branco (${n} itens)`);
        assert(vistos[n] === vistos[0], `.${d} tem ${n} itens${d === "dialcpu" ? " (temperatura some sem LHM)" : ""}`);
      }
      const gpuItens = [];
      for (let i = 0; i < 6; i++) {
        ctl.send({ event: "dialRotate", action: `${NS}.dialgpu`, context: "ctx-dialgpu", payload: { ticks: 1 } });
        await sleep(60);
        gpuItens.push(ctl.texts("ctx-dialgpu")[1]);
      }
      assert(gpuItens.every((v) => v === "n/d"), `dialgpu: todos os itens n/d sem GPU (${gpuItens.join(",")})`);
    },
  });
  assert(r.exited && r.code === 0, `plugin sai sozinho (exit 0) (${r.code})`);
}

// ================================================================ 2b. placa AMD (sem nvidia-smi)

/** LHM de um PC com Radeon e Intel integrada: os sensores da Radeon tem que vencer. */
const LHM_AMD = {
  Text: "Sensor",
  Children: [
    {
      Text: "ASTRO-PC",
      Children: [
        {
          Text: "Intel Core i7-12700K",
          ImageURL: "images_icon/cpu.png",
          Children: [{ Text: "CPU Package", Value: "52,0 °C", Type: "Temperature", SensorId: "/intelcpu/0/temperature/0" }],
        },
        {
          Text: "Intel(R) UHD Graphics 770",
          Children: [{ Text: "GPU Core", Value: "45,0 °C", SensorId: "/gpu-intel/0/temperature/0" }],
        },
        {
          Text: "AMD Radeon RX 7800 XT",
          Children: [
            { Text: "GPU Core", Value: "61,0 °C", SensorId: "/gpu-amd/0/temperature/0" },
            { Text: "GPU Hot Spot", Value: "74,0 °C", SensorId: "/gpu-amd/0/temperature/1" },
            { Text: "GPU Package", Value: "143,5 W", SensorId: "/gpu-amd/0/power/0" },
            { Text: "GPU Fan", Value: "38 %", SensorId: "/gpu-amd/0/control/0" },
            { Text: "GPU Core", Value: "2310 MHz", SensorId: "/gpu-amd/0/clock/0" },
          ],
        },
      ],
    },
  ],
};

const GPU_KEYS = ["gpu", "gputemp", "vram", "gpupower", "gpufan", "gpuclock"];

async function scenarioAmd() {
  console.log("\n== 2b. placa AMD: uso e memoria pelo Windows, sensores pelo LHM ==");
  const instances = GPU_KEYS.map((a) => ({ action: a, context: `ctx-${a}`, controller: "Keypad", settings: {} }));
  const ctxs = instances.map((i) => i.context);
  const lhm = await startFakeLhm(LHM_AMD);
  const r = await session({
    env: { SYSMON_FAKE: "1", SYSMON_FAKE_MISSING: "nvidia" },
    global: { refreshCpuSeconds: 1, refreshGpuSeconds: 1, refreshDiskSeconds: 10, refreshIoSeconds: 1, lhmUrl: lhm.url, drives: ["C"] },
    instances,
    script: async (ctl) => {
      await waitFor(() => ctl.texts("ctx-gpu")[1] === "41%" && ctl.texts("ctx-gpuclock")[1] === "2310", 6000);
      printTable(ctl, ctxs);
      checkNoBlank(ctl, ctxs, "AMD");
      const t = (c) => ctl.texts(c);
      assert(t("ctx-gpu")[1] === "41%", `gpu: uso do Windows (${t("ctx-gpu")[1]})`);
      assert(t("ctx-gputemp")[1] === "61°C", `gputemp: GPU Core da Radeon, nao da Intel (${t("ctx-gputemp")[1]})`);
      assert(t("ctx-vram")[1] === "20%" && /3\.2\/16 GB/.test(t("ctx-vram")[2]), `vram: dedicada da Radeon (${t("ctx-vram")[1]} ${t("ctx-vram")[2]})`);
      assert(/^144 W$|^143 W$/.test(t("ctx-gpupower")[1]), `gpupower: GPU Package (${t("ctx-gpupower")[1]})`);
      assert(t("ctx-gpufan")[1] === "38%", `gpufan: controle da ventoinha (${t("ctx-gpufan")[1]})`);
    },
  });
  lhm.srv.close();
  assert(r.exited && r.code === 0, `plugin sai sozinho (exit 0) (${r.code})`);

  console.log("\n== 2c. placa AMD sem LHM: uso e memoria seguem, o resto diz sem LHM ==");
  const r2 = await session({
    env: { SYSMON_FAKE: "1", SYSMON_FAKE_MISSING: "nvidia" },
    global: { refreshCpuSeconds: 1, refreshGpuSeconds: 1, refreshDiskSeconds: 10, refreshIoSeconds: 1, lhmUrl: "http://127.0.0.1:1", drives: ["C"] },
    instances,
    script: async (ctl) => {
      await waitFor(() => ctl.texts("ctx-gpu")[1] === "41%" && ctl.texts("ctx-gputemp")[2] === "sem LHM", 6000);
      printTable(ctl, ctxs);
      const t = (c) => ctl.texts(c);
      assert(t("ctx-gpu")[1] === "41%" && t("ctx-vram")[1] === "20%", `uso e VRAM sem LHM (${t("ctx-gpu")[1]}, ${t("ctx-vram")[1]})`);
      for (const a of ["gputemp", "gpupower", "gpufan", "gpuclock"]) {
        assert(t(`ctx-${a}`)[1] === "n/d" && t(`ctx-${a}`)[2] === "sem LHM", `.${a}: n/d (${t(`ctx-${a}`)[2]}) sem LHM`);
      }
    },
  });
  assert(r2.exited && r2.code === 0, `plugin sai sozinho (exit 0) (${r2.code})`);
}

// ================================================================ 3. modo --real

function cpuMs(pids) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $([int]$_.TotalProcessorTime.TotalMilliseconds)" }`],
    { encoding: "utf8" }
  );
  const out = {};
  for (const l of String(r.stdout).split(/\r?\n/)) {
    const m = /^(\d+) (\d+)$/.exec(l.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectorPidFrom(ctl) {
  for (let i = ctl.pluginLog.length - 1; i >= 0; i--) {
    const m = /coletor iniciado pid=(\d+)/.exec(ctl.pluginLog[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

async function scenarioReal() {
  console.log(`\n== 3. REAL: nvidia-smi + coletor PowerShell de verdade, ${SECONDS} s de medicao ==`);
  const instances = allInstances();
  const ctxs = instances.map((i) => i.context);
  let collectorPid = null;
  let pluginPid = null;

  const r = await session({
    env: { SYSMON_FAKE: "", SYSMON_FAKE_MISSING: "" },
    global: { refreshCpuSeconds: 1, refreshGpuSeconds: 3, refreshDiskSeconds: 60, refreshIoSeconds: 2, drives: ["C", "D", "E"] },
    instances,
    script: async (ctl) => {
      pluginPid = ctl.child.pid;
      const aquecido = await waitFor(() => /^\d/.test(ctl.texts("ctx-netdown")[1] || "") && /%$/.test(ctl.texts("ctx-cpu")[1] || ""), 20000);
      assert(aquecido, "coletor real entregou dado de rede/disco em ate 20 s");
      collectorPid = collectorPidFrom(ctl);
      assert(!!collectorPid && alive(collectorPid), `coletor PowerShell vivo (pid ${collectorPid})`);
      await sleep(1500);

      console.log("  -- teclas (leitura real) --");
      printTable(ctl, ctxs.filter((c) => !c.startsWith("ctx-dial")));
      checkNoBlank(ctl, ctxs, "real");
      assert(/^\d+%$/.test(ctl.texts("ctx-cpu")[1]), `cpu real: ${ctl.texts("ctx-cpu")[1]}`);
      assert(/^\d+°C$|^n\/d$/.test(ctl.texts("ctx-cputemp")[1]), `cputemp real: ${ctl.texts("ctx-cputemp")[1]} (${ctl.texts("ctx-cputemp")[2]})`);

      // ---- custo: janela limpa de SECONDS s, sem interferencia
      const pids = [pluginPid, collectorPid];
      const a = cpuMs(pids);
      const t0 = Date.now();
      await sleep(SECONDS * 1000);
      const b = cpuMs(pids);
      const wall = Date.now() - t0;
      const pct = (pid) => (a[pid] !== undefined && b[pid] !== undefined ? ((b[pid] - a[pid]) / wall) * 100 : null);
      const pNode = pct(pluginPid);
      const pCol = pct(collectorPid);
      console.log(`  -- custo em ${(wall / 1000).toFixed(1)} s (media, % de UM nucleo; a maquina tem 16 threads) --`);
      console.log(`        node (plugin.js)        : ${pNode === null ? "?" : pNode.toFixed(2)} %   (cpu total acumulada ${b[pluginPid]} ms)`);
      console.log(`        powershell (coletor)    : ${pCol === null ? "?" : pCol.toFixed(2)} %   (cpu total acumulada ${b[collectorPid]} ms)`);
      assert(pNode !== null && pNode < 5, `node < 5% de um nucleo (${pNode && pNode.toFixed(2)}%)`);
      assert(pCol !== null && pCol < 5, `coletor < 5% de um nucleo (${pCol && pCol.toFixed(2)}%)`);

      // ---- trocar de pagina (todas as teclas somem e voltam) nao pode religar o coletor
      const inicios = () => ctl.pluginLog.filter((l) => /coletor iniciado/.test(l)).length;
      const antes = inicios();
      for (const i of instances) ctl.send({ event: "willDisappear", action: `${NS}.${i.action}`, context: i.context, payload: { controller: i.controller, settings: i.settings } });
      await sleep(300);
      for (const i of instances) ctl.send({ event: "willAppear", action: `${NS}.${i.action}`, context: i.context, payload: { controller: i.controller, settings: i.settings } });
      await sleep(1500);
      assert(inicios() === antes && alive(collectorPid), `troca de pagina nao religa o coletor (folga de 30 s; inicios ${antes} -> ${inicios()})`);
      assert(/^\d+%$/.test(ctl.texts("ctx-cpu")[1]) && /^\d/.test(ctl.texts("ctx-netdown")[1]), `teclas voltam com dado na hora (${ctl.texts("ctx-cpu")[1]}, ${ctl.texts("ctx-netdown")[1]})`);

      // ---- coletor morto de repente: n/d na hora, religa com backoff e volta o dado
      const pidAntigo = collectorPid;
      process.kill(pidAntigo);
      const ficouNd = await waitFor(() => ctl.texts("ctx-netdown")[1] === "n/d", 3000, 50);
      assert(ficouNd, `coletor morto: tecla de rede vira n/d (${ctl.texts("ctx-netdown").join(" / ")})`);
      const religou = await waitFor(() => {
        const p = collectorPidFrom(ctl);
        return p && p !== pidAntigo;
      }, 8000);
      assert(religou, "coletor religado com backoff");
      const voltou = await waitFor(() => /^\d/.test(ctl.texts("ctx-netdown")[1] || ""), 15000);
      assert(voltou, `dado de rede volta depois do restart (${ctl.texts("ctx-netdown").join(" / ")})`);
      collectorPid = collectorPidFrom(ctl);
    },
  });

  assert(r.exited && r.code === 0, `plugin sai sozinho (exit 0) quando o socket fecha (${r.code})`);
  const morreu = await waitFor(() => !alive(collectorPid), 4000, 100);
  assert(morreu, `coletor TERMINA junto com o plugin (pid ${collectorPid} ${morreu ? "encerrado" : "AINDA VIVO"})`);
  if (!morreu) try { process.kill(collectorPid); } catch {}

  // ---- plugin morto na marra (TerminateProcess): o coletor percebe que o pai sumiu
  console.log("  -- plugin morto na marra: o coletor nao pode virar orfao --");
  const k = await session({
    env: { SYSMON_FAKE: "", SYSMON_FAKE_MISSING: "" },
    global: { refreshCpuSeconds: 1, refreshGpuSeconds: 3, refreshDiskSeconds: 60, refreshIoSeconds: 1, drives: ["C"] },
    instances: [{ action: "netdown", context: "ctx-netdown", controller: "Keypad", settings: {} }],
    keepAlive: true,
    script: async (ctl) => {
      await waitFor(() => collectorPidFrom(ctl), 10000);
    },
  });
  const cp = collectorPidFrom(k.ctl);
  assert(!!cp && alive(cp), `segundo plugin com coletor vivo (pid ${cp})`);
  k.child.kill(); // no Windows isto e TerminateProcess: o 'exit' do node nao roda
  await waitFor(() => k.ctl.exitCode() !== null, 3000);
  const orfao = await waitFor(() => !alive(cp), 12000, 200);
  assert(orfao, `coletor sem pai termina sozinho (pid ${cp} ${orfao ? "encerrado" : "ORFAO"})`);
  if (!orfao) try { process.kill(cp); } catch {}
  k.server.close();
}

// ================================================================ main

(async () => {
  const watchdog = setTimeout(() => {
    console.log("\nTIMEOUT do teste");
    process.exit(1);
  }, REAL ? 180000 : 60000);

  try {
    unitTests();
    if (!REAL) {
      await scenarioCompleto();
      await scenarioSemDado();
      await scenarioAmd();
    } else {
      await scenarioReal();
    }
  } catch (err) {
    failures.push(`excecao no teste: ${err && err.stack ? err.stack : err}`);
    console.log(`  FAIL  excecao no teste: ${err && err.stack ? err.stack : err}`);
  }

  clearTimeout(watchdog);
  console.log(`\n== resultado: ${passed} ok, ${failures.length} falha(s) ==`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    console.log("FALHOU");
  } else {
    console.log("TUDO PASSOU");
  }
  process.exit(failures.length ? 1 : 0);
})();
