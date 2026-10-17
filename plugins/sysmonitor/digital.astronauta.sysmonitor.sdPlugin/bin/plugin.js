"use strict";
/**
 * digital.astronauta.sysmonitor v2 — recursos da maquina no Stream Deck.
 *
 * COLETA sozinho (decisao do Eduardo: nao ha painel coletor para CPU/RAM/GPU). Quem le o
 * sistema e o sources.js, com agendamento por fonte; quem decide o que aparece e o views.js
 * (adaptador puro, testavel sem Stream Deck); quem desenha e o render.js (R.clean) — o mesmo
 * sistema visual do plugin de IA.
 *
 * Uma ACAO por metrica (14 teclas + 5 dials). Teclas: keyDown abre o Gerenciador de Tarefas.
 * Dials: girar alterna o item (indice na instancia, `cycleIndex`), apertar abre o
 * Gerenciador, tocar no strip forca leitura.
 *
 * Node puro, zero dependencias (o app embute Node 20).
 */

const { spawn } = require("child_process");
const { MiniWebSocket } = require("./ws");
const R = require("./render");
const V = require("./views");
const { createSources } = require("./sources");

// ---------------------------------------------------------------- argumentos

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) out[a.replace(/^-+/, "")] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port);
const PLUGIN_UUID = args.pluginUUID;
const REGISTER_EVENT = args.registerEvent;

function log(...parts) {
  console.log(`[sysmonitor] ${parts.join(" ")}`);
}

const NS = "digital.astronauta.sysmonitor";

function shortAction(action) {
  return String(action || "").startsWith(`${NS}.`) ? action.slice(NS.length + 1) : String(action || "");
}

// ---------------------------------------------------------------- configuracao global

const DEFAULT_GLOBAL = {
  refreshCpuSeconds: 1,
  refreshGpuSeconds: 3,
  refreshDiskSeconds: 60,
  refreshIoSeconds: 2,
  lhmUrl: "http://127.0.0.1:8085",
  drives: ["C", "D", "E"],
};

let global = { ...DEFAULT_GLOBAL, drives: DEFAULT_GLOBAL.drives.slice() };

function num(v, def, lo, hi) {
  const x = Number(v);
  return v !== "" && v !== null && v !== undefined && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : def;
}

/** Aceita `["C","D"]` ou `"C, D:"`. Letras unicas, maiusculas. */
function parseDrives(v) {
  const lista = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : null;
  if (!lista) return DEFAULT_GLOBAL.drives.slice();
  const out = [];
  for (const d of lista) {
    const m = /[A-Za-z]/.exec(String(d));
    if (m && !out.includes(m[0].toUpperCase())) out.push(m[0].toUpperCase());
  }
  return out;
}

function applyGlobal(raw) {
  const s = raw || {};
  global = {
    refreshCpuSeconds: num(s.refreshCpuSeconds, DEFAULT_GLOBAL.refreshCpuSeconds, 1, 60),
    refreshGpuSeconds: num(s.refreshGpuSeconds, DEFAULT_GLOBAL.refreshGpuSeconds, 1, 60),
    refreshDiskSeconds: num(s.refreshDiskSeconds, DEFAULT_GLOBAL.refreshDiskSeconds, 10, 3600),
    refreshIoSeconds: num(s.refreshIoSeconds, DEFAULT_GLOBAL.refreshIoSeconds, 1, 60),
    lhmUrl: /^https?:\/\//i.test(String(s.lhmUrl || "").trim())
      ? String(s.lhmUrl).trim().replace(/\/+$/, "")
      : DEFAULT_GLOBAL.lhmUrl,
    drives: s.drives === undefined ? DEFAULT_GLOBAL.drives.slice() : parseDrives(s.drives),
  };
}

// ---------------------------------------------------------------- estado

let sd = null;
const contexts = new Map(); // context -> { action, controller, settings }
const lastDrawn = new Map(); // context -> ultimo SVG enviado (nao reenvia o que nao mudou)
const sources = createSources({ log });
let renderTimer = null;

function wrapIdx(i, len) {
  return ((i % len) + len) % len;
}

// ---------------------------------------------------------------- protocolo

function send(payload) {
  if (sd) sd.send(JSON.stringify(payload));
}

function setImage(context, svg) {
  send({ event: "setImage", context, payload: { image: R.toDataUri(svg), target: 0 } });
}

function setTitle(context, title) {
  send({ event: "setTitle", context, payload: { title, target: 0 } });
}

function setFeedback(context, payload) {
  send({ event: "setFeedback", context, payload });
}

function showOk(context) {
  send({ event: "showOk", context });
}

// ---------------------------------------------------------------- render

function viewFor(state, entry) {
  const action = shortAction(entry.action);
  const settings = entry.settings || {};
  if (entry.controller === "Encoder") return V.dialView(state, action, settings, { drives: global.drives });
  return V.view(state, action, settings);
}

function renderOne(context, state) {
  const entry = contexts.get(context);
  if (!entry) return;
  let view;
  try {
    view = viewFor(state, entry);
  } catch (err) {
    // erro inesperado: a tecla diz isso em vez de ficar em branco
    log(`erro ao montar a view de ${entry.action}: ${err.message}`);
    view = { label: shortAction(entry.action).toUpperCase(), value: "n/d", sub: "erro", level: "offline" };
  }

  const dial = entry.controller === "Encoder";
  const svg = R.clean(view, dial);
  if (lastDrawn.get(context) === svg) return;
  lastDrawn.set(context, svg);

  if (dial) {
    setFeedback(context, { canvas: R.toDataUri(svg) });
  } else {
    setImage(context, svg);
    setTitle(context, ""); // o texto fica no SVG; titulo do app apagado
  }
}

function renderAll() {
  const state = sources.snapshot();
  for (const context of contexts.keys()) renderOne(context, state);
}

/** Junta varias atualizacoes de fonte numa so passada de desenho (no maximo ~4/s). */
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, 250);
}

sources.onUpdate(scheduleRender);

// ---------------------------------------------------------------- necessidades

/** O que ligar: fontes e unidades de TODAS as instancias visiveis. Sem tecla, sem coleta. */
function recompute() {
  const needs = { cpu: false, ram: false, gpu: false, cputemp: false, io: false, disk: false };
  const drives = new Set();
  for (const entry of contexts.values()) {
    const n = V.needsOf(shortAction(entry.action), entry.settings, global);
    for (const s of n.sources) needs[s] = true;
    for (const d of n.drives) drives.add(d);
  }
  sources.configure({
    needs,
    drives: [...drives],
    refreshCpuSeconds: global.refreshCpuSeconds,
    refreshGpuSeconds: global.refreshGpuSeconds,
    refreshDiskSeconds: global.refreshDiskSeconds,
    refreshIoSeconds: global.refreshIoSeconds,
    lhmUrl: global.lhmUrl,
  });
}

// ---------------------------------------------------------------- acoes

/**
 * Abre o Gerenciador de Tarefas. `cmd /c start` (ShellExecute) e de proposito: o taskmgr
 * pede elevacao e um CreateProcess direto falha com "requer elevacao"; o ShellExecute deixa
 * o Windows decidir (UAC, se houver). Destacado: nao segura o plugin.
 */
function openTaskManager() {
  if (process.env.SYSMON_FAKE === "1") {
    log("[teste] abriria o Gerenciador de Tarefas (taskmgr)");
    return;
  }
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", "taskmgr"], { detached: true, stdio: "ignore", windowsHide: true })
        : process.platform === "darwin"
        ? spawn("open", ["-a", "Activity Monitor"], { detached: true, stdio: "ignore" })
        : spawn("gnome-system-monitor", [], { detached: true, stdio: "ignore" });
    child.on("error", (err) => log("nao consegui abrir o Gerenciador de Tarefas:", err.message));
    child.unref();
  } catch (err) {
    log("nao consegui abrir o Gerenciador de Tarefas:", err.message);
  }
}

/** Dial: avanca o item. O indice mora nas settings da instancia (cycleIndex), como no plugin de IA. */
function cycleIndex(context, ticks) {
  const entry = contexts.get(context);
  if (!entry) return;
  const state = sources.snapshot();
  const itens = V.dialItems(state, shortAction(entry.action), entry.settings, { drives: global.drives });
  const len = Math.max(1, itens.length);
  const s = entry.settings || {};
  const atual = Number.isInteger(s.cycleIndex) ? s.cycleIndex : 0;
  entry.settings = { ...s, cycleIndex: wrapIdx(atual + ticks, len) };
  send({ event: "setSettings", context, payload: entry.settings });
  renderOne(context, state);
}

/** Inspector pede listas (acao explicita do usuario; a tecla nunca varre letras sozinha). */
function onSendToPlugin(msg) {
  const { action, context, payload } = msg;
  const pedido = payload && payload.pedido;
  const responder = (p) => send({ event: "sendToPropertyInspector", action, context, payload: p });

  if (pedido === "drives") {
    sources.listDrives((letras) => responder({ drives: letras }));
  } else if (pedido === "discos") {
    const st = sources.snapshot();
    const letras = st.io && st.io.status === "ok" ? st.io.diskLetters || [] : [];
    responder({ discos: letras });
  }
}

// ---------------------------------------------------------------- conexao

function connect() {
  sd = new MiniWebSocket(PORT);

  sd.on("open", () => {
    send({ event: REGISTER_EVENT, uuid: PLUGIN_UUID });
    send({ event: "getGlobalSettings", context: PLUGIN_UUID });
    log("registrado");
  });

  sd.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { event, action, context, payload } = msg;

    switch (event) {
      case "didReceiveGlobalSettings":
        applyGlobal(payload && payload.settings);
        recompute();
        renderAll();
        break;

      case "willAppear":
        contexts.set(context, {
          action: action || "",
          controller: (payload && payload.controller) || "Keypad",
          settings: (payload && payload.settings) || {},
        });
        lastDrawn.delete(context);
        recompute();
        renderOne(context, sources.snapshot());
        break;

      case "willDisappear":
        contexts.delete(context);
        lastDrawn.delete(context);
        recompute();
        break;

      case "didReceiveSettings": {
        const entry = contexts.get(context);
        if (entry) {
          entry.settings = (payload && payload.settings) || {};
          recompute();
          renderOne(context, sources.snapshot());
        }
        break;
      }

      case "dialRotate":
        cycleIndex(context, payload && payload.ticks > 0 ? 1 : -1);
        break;

      case "touchTap":
        sources.refreshNow();
        scheduleRender();
        showOk(context);
        break;

      case "keyDown":
      case "dialDown":
        openTaskManager();
        break;

      case "sendToPlugin":
        onSendToPlugin(msg);
        break;

      default:
        break;
    }
  });

  sd.on("error", (err) => log("erro de socket:", err.message));
  sd.on("close", () => {
    log("socket fechado, encerrando");
    sources.stop(); // mata o coletor antes de sair (process 'exit' e a rede de seguranca)
    process.exit(0);
  });
}

if (!PORT || !PLUGIN_UUID || !REGISTER_EVENT) {
  console.error("[sysmonitor] argumentos de registro ausentes; o app do Stream Deck os passa.");
  process.exit(1);
}

connect();
