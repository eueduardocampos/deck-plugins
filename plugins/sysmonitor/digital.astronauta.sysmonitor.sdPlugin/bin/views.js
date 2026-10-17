"use strict";
/**
 * views.js — adaptador PURO: estado das fontes -> `view` do R.clean.
 *
 * Nao toca em disco, rede, processo nem relogio: recebe o `estado` que o sources.js monta
 * (snapshot) e devolve objetos `{label, value, sub, level, accent, pct, ...}`. E por isso que
 * da para testar sem Stream Deck e sem a maquina (ver test/fake_sd_sysmonitor.js).
 *
 * ---------------------------------------------------------------- LIMIARES
 *
 * Por METRICA, nao um numero unico: CPU a 90% durante um build e normal, disco a 90% e problema.
 * `aviso` vira nivel "warn" (amarelo); `critico` vira "danger" (vermelho). Abaixo do aviso
 * a tecla fica `safe` e usa a cor da familia (accent).
 *
 *   metrica     aviso  critico  o que mede
 *   cpu           80     95     uso total, %
 *   ram           80     95     memoria em uso, %
 *   gpu           85     95     uso da GPU, %
 *   vram          85     95     VRAM usada / total, %
 *   gputemp       75     85     temperatura da GPU, C
 *   cputemp       80     90     temperatura da CPU (LHM), C
 *   disk          85     95     espaco usado da unidade, %
 *   gpufan        80     95     ventoinha, % da rotacao maxima
 *   gpupower      --     --     energia: informativa (GPU no limite de energia e normal em jogo/render)
 *   gpuclock      --     --     clock: informativo
 *   diskwrite     --     --     gravacao em disco: informativa
 *   diskread      --     --     leitura em disco: informativa
 *   netdown/up    --     --     rede: informativa
 *
 * "--" = sem limiar: nivel sempre `safe`. Sem dado, o nivel e `offline` e o valor diz o motivo
 * (`n/d`, `...`): a tecla nunca fica em branco e nunca mostra numero inventado.
 *
 * ---------------------------------------------------------------- FORMA DO ESTADO
 *
 *   {
 *     t,
 *     cpu:     { status, pct, threads, busy }               // busy = threads acima de 50%
 *     cpufreq: { status, mhz, baseMHz }                     // vem do coletor PowerShell
 *     ram:     { status, pct, usedGB, freeGB, totalGB }
 *     gpu:     { status, fonte?, lhm?, integrada?, util, temp, memUsedMB, memTotalMB, watts, wattsLimit, fan,
 *                clockMHz, clockMaxMHz, name, ... }
 *     cputemp: { status, temp, sensor }
 *     disks:   { C: { status, pct, freeGB, totalGB }, ... }
 *     io:      { status, disk: { total: {w,r}, C: {w,r} }, netDown, netUp (bytes/s),
 *                totalDown, totalUp (bytes na sessao) }
 *     hist:    { cpu: [..], gpu: [..], netdown: [..], "diskwrite:C": [..], ... }
 *   }
 *
 * `status`: "ok" | "aguardando" | "ausente" | "falha" | "obsoleto" | "sem-lhm" | "sem-sensor"
 *           | "coletor" | "sem-dado" | "sem-unidade".
 */

const ACCENT = {
  cpu: "#5aa9ff",
  ram: "#b48cff",
  gpu: "#76b900",
  disk: "#ffb454",
  net: "#4dd0e1",
};

const LIMIARES = {
  cpu: { aviso: 80, critico: 95 },
  ram: { aviso: 80, critico: 95 },
  gpu: { aviso: 85, critico: 95 },
  vram: { aviso: 85, critico: 95 },
  gputemp: { aviso: 75, critico: 85 },
  cputemp: { aviso: 80, critico: 90 },
  disk: { aviso: 85, critico: 95 },
  gpufan: { aviso: 80, critico: 95 },
};

/**
 * Catalogo (CONTRATO com o gerador de perfil — docs/00-convencoes.md). `needs` diz quais fontes
 * a acao consome; o plugin so liga a coleta do que esta visivel.
 */
const ACTIONS = {
  cpu: { kind: "key", needs: ["cpu"] },
  cputemp: { kind: "key", needs: ["cputemp"] },
  ram: { kind: "key", needs: ["ram"] },
  gpu: { kind: "key", needs: ["gpu"] },
  gputemp: { kind: "key", needs: ["gpu"] },
  vram: { kind: "key", needs: ["gpu"] },
  gpupower: { kind: "key", needs: ["gpu"] },
  gpufan: { kind: "key", needs: ["gpu"] },
  gpuclock: { kind: "key", needs: ["gpu"] },
  disk: { kind: "key", needs: ["disk"] },
  diskwrite: { kind: "key", needs: ["io"] },
  diskread: { kind: "key", needs: ["io"] },
  netdown: { kind: "key", needs: ["io"] },
  netup: { kind: "key", needs: ["io"] },
  dialcpu: { kind: "dial", needs: ["cpu", "cputemp", "io"] },
  dialmem: { kind: "dial", needs: ["ram"] },
  dialgpu: { kind: "dial", needs: ["gpu"] },
  dialdisk: { kind: "dial", needs: ["disk", "io"] },
  dialnet: { kind: "dial", needs: ["io"] },
};

const KEY_ACTIONS = Object.keys(ACTIONS).filter((a) => ACTIONS[a].kind === "key");
const DIAL_ACTIONS = Object.keys(ACTIONS).filter((a) => ACTIONS[a].kind === "dial");

// ---------------------------------------------------------------- utilitarios

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Nivel de alerta de uma metrica. Sem limiar: `safe`. Sem numero: `offline`. */
function levelFor(metric, value) {
  if (!isNum(value)) return "offline";
  const t = LIMIARES[metric];
  if (!t) return "safe";
  if (value >= t.critico) return "danger";
  if (value >= t.aviso) return "warn";
  return "safe";
}

/** "C", "c:", "C:\\" -> "C". */
function driveLetter(v, def = "C") {
  const m = /[A-Za-z]/.exec(String(v == null ? "" : v));
  return m ? m[0].toUpperCase() : def;
}

/** Alvo de disco de uma tecla de velocidade: "total" ou uma letra. */
function diskTarget(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^total$/i.test(s)) return "total";
  return driveLetter(s, "total");
}

function pctClamp(v) {
  return Math.max(0, Math.min(100, v));
}

/** Uma casa decimal abaixo de 10, inteiro daqui para cima. 0 vira "0". */
function fmtNum(n) {
  if (!isNum(n)) return "--";
  const r = Math.round(n * 10) / 10;
  if (r === 0) return "0";
  if (r >= 10) return String(Math.round(r));
  return r.toFixed(1);
}

const rd = (v) => String(Math.round(v));

/** Bytes/s -> {n, unit} em KB/s, MB/s ou GB/s (base 1024, como o Windows). */
function fmtByteRate(bps) {
  const v = Math.max(0, bps);
  const G = 1024 ** 3;
  const M = 1024 ** 2;
  if (v >= G * 0.995) return { n: fmtNum(v / G), unit: "GB/s" };
  if (v >= M * 0.995) return { n: fmtNum(v / M), unit: "MB/s" };
  return { n: fmtNum(v / 1024), unit: "KB/s" };
}

/** Bytes/s -> {n, unit} em kb/s, Mb/s ou Gb/s (bits, base 1000: e assim que se vende banda). */
function fmtBitRate(bps) {
  const bits = Math.max(0, bps) * 8;
  if (bits >= 1e9 * 0.995) return { n: fmtNum(bits / 1e9), unit: "Gb/s" };
  if (bits >= 1e6 * 0.995) return { n: fmtNum(bits / 1e6), unit: "Mb/s" };
  return { n: fmtNum(bits / 1e3), unit: "kb/s" };
}

/** Bytes -> "840 MB", "1.2 GB". */
function fmtBytes(b) {
  if (!isNum(b)) return "--";
  const T = 1024 ** 4;
  const G = 1024 ** 3;
  const M = 1024 ** 2;
  if (b >= T * 0.995) return `${fmtNum(b / T)} TB`;
  if (b >= G * 0.995) return `${fmtNum(b / G)} GB`;
  if (b >= M * 0.995) return `${fmtNum(b / M)} MB`;
  return `${fmtNum(b / 1024)} KB`;
}

function histOf(st, key) {
  return (st && st.hist && st.hist[key]) || [];
}

/** Base de toda view: o que e fixo da metrica. */
function base(st, metric, label, family, histKey) {
  return { kind: "plain", metric, label, accent: ACCENT[family], hist: histOf(st, histKey || metric) };
}

/** Sem dado: diz o motivo no `sub`. `n/d` = nao ha como saber; `...` = ainda lendo. */
function reason(src) {
  const s = src && src.status;
  switch (s) {
    case "aguardando":
      return { value: "...", sub: "lendo" };
    case "ausente":
      return { value: "n/d", sub: "sem GPU" };
    case "sem-lhm":
      return { value: "n/d", sub: "sem LHM" };
    case "sem-sensor":
      return { value: "n/d", sub: "sem sensor" };
    case "coletor":
      return { value: "n/d", sub: "sem coletor" };
    case "sem-dado":
      return { value: "n/d", sub: "sem contador" };
    case "sem-unidade":
      return { value: "n/d", sub: "sem unidade" };
    case "falha":
    case "obsoleto":
      return { value: "n/d", sub: "sem leitura" };
    default:
      return { value: "n/d", sub: "sem dado" };
  }
}

function semDado(b, src, subOverride) {
  const r = reason(src);
  return { ...b, value: r.value, sub: subOverride || r.sub, level: "offline", pct: null };
}

function pronto(b, fields) {
  return { ...b, ...fields };
}

// ---------------------------------------------------------------- views por metrica

function cpuView(st, o = {}) {
  const b = base(st, "cpu", o.label || "CPU", "cpu");
  const c = st && st.cpu;
  if (!c || c.status !== "ok" || !isNum(c.pct)) return semDado(b, c);
  return pronto(b, {
    value: `${rd(c.pct)}%`,
    sub: isNum(c.threads) ? `${c.threads} threads` : "",
    level: levelFor("cpu", c.pct),
    pct: pctClamp(c.pct),
  });
}

function cpuFreqView(st, o = {}) {
  const b = base(st, "cpufreq", o.label || "CPU · FREQ", "cpu", "cpufreq");
  const f = st && st.cpufreq;
  if (!f || f.status !== "ok") return semDado(b, f || (st && st.io));
  if (!isNum(f.mhz)) return semDado(b, { status: "sem-dado" });
  const baseTxt = isNum(f.baseMHz) ? `GHz · base ${(f.baseMHz / 1000).toFixed(1)}` : "GHz";
  return pronto(b, {
    value: (f.mhz / 1000).toFixed(2),
    sub: baseTxt,
    level: "safe",
    pct: isNum(f.baseMHz) && f.baseMHz > 0 ? pctClamp((100 * f.mhz) / (f.baseMHz * 1.5)) : null,
  });
}

function cpuTempView(st, o = {}) {
  const b = base(st, "cputemp", o.label || "CPU TEMP", "cpu");
  const t = st && st.cputemp;
  if (!t || t.status !== "ok" || !isNum(t.temp)) return semDado(b, t);
  return pronto(b, {
    value: `${rd(t.temp)}°C`,
    sub: "via LHM",
    level: levelFor("cputemp", t.temp),
    pct: null,
  });
}

function threadsView(st, o = {}) {
  const b = base(st, "threads", o.label || "CPU · THREADS", "cpu", "cpu");
  const c = st && st.cpu;
  if (!c || c.status !== "ok" || !isNum(c.threads)) return semDado(b, c);
  return pronto(b, {
    value: String(c.threads),
    sub: isNum(c.busy) ? `${c.busy} acima de 50%` : "lógicas",
    level: "safe",
    pct: isNum(c.busy) && c.threads > 0 ? pctClamp((100 * c.busy) / c.threads) : null,
  });
}

function ramView(st, o = {}) {
  const b = base(st, "ram", o.label || "RAM", "ram");
  const r = st && st.ram;
  if (!r || r.status !== "ok" || !isNum(r.pct)) return semDado(b, r);
  return pronto(b, {
    value: `${rd(r.pct)}%`,
    sub: `${rd(r.usedGB)}/${rd(r.totalGB)} GB`,
    level: levelFor("ram", r.pct),
    pct: pctClamp(r.pct),
  });
}

/** `quanto` = "used" | "free": os dois itens do dial de memoria que mostram GB. */
function ramGbView(st, quanto, o = {}) {
  const used = quanto === "used";
  const b = base(st, used ? "ramused" : "ramfree", o.label || (used ? "RAM · USADA" : "RAM · LIVRE"), "ram", "ram");
  const r = st && st.ram;
  if (!r || r.status !== "ok" || !isNum(r.totalGB)) return semDado(b, r);
  const gb = used ? r.usedGB : r.freeGB;
  return pronto(b, {
    value: `${fmtNum(gb)} GB`,
    sub: `de ${rd(r.totalGB)} GB`,
    level: used ? levelFor("ram", r.pct) : "safe",
    pct: pctClamp((100 * gb) / r.totalGB),
  });
}

/**
 * Constroi a view de uma metrica da GPU; `fn` devolve null se o campo veio vazio (`[N/A]`).
 * Placa AMD/Intel (fonte "windows"): temperatura, energia, ventoinha e clock so existem com o
 * LHM ligado, entao o motivo do n/d e "sem LHM", nao "sem sensor".
 */
function gpuView(st, metric, label, fn) {
  const b = base(st, metric, label, "gpu");
  const g = st && st.gpu;
  if (!g || g.status !== "ok") return semDado(b, g);
  return fn(g, b) || semDado(b, { status: g.fonte === "windows" && !g.lhm ? "sem-lhm" : "sem-sensor" });
}

function gpuUsoView(st, o = {}) {
  return gpuView(st, "gpu", o.label || "GPU", (g, b) =>
    isNum(g.util)
      ? pronto(b, {
          value: `${rd(g.util)}%`,
          sub: isNum(g.temp) ? `${rd(g.temp)}°C` : "",
          level: levelFor("gpu", g.util),
          pct: pctClamp(g.util),
        })
      : null
  );
}

function gpuTempView(st, o = {}) {
  return gpuView(st, "gputemp", o.label || "GPU TEMP", (g, b) =>
    isNum(g.temp)
      ? pronto(b, {
          value: `${rd(g.temp)}°C`,
          sub: isNum(g.watts) ? `${rd(g.watts)} W` : "",
          level: levelFor("gputemp", g.temp),
          pct: null,
        })
      : null
  );
}

function vramView(st, o = {}) {
  return gpuView(st, "vram", o.label || "VRAM", (g, b) => {
    if (!isNum(g.memUsedMB) || !isNum(g.memTotalMB) || g.memTotalMB <= 0) return null;
    const pct = (100 * g.memUsedMB) / g.memTotalMB;
    return pronto(b, {
      value: `${rd(pct)}%`,
      sub: `${fmtNum(g.memUsedMB / 1024)}/${rd(g.memTotalMB / 1024)} GB${g.integrada ? " comp." : ""}`,
      level: levelFor("vram", pct),
      pct: pctClamp(pct),
    });
  });
}

function gpuPowerView(st, o = {}) {
  return gpuView(st, "gpupower", o.label || "ENERGIA", (g, b) => {
    if (!isNum(g.watts)) return null;
    const pct = isNum(g.wattsLimit) && g.wattsLimit > 0 ? (100 * g.watts) / g.wattsLimit : null;
    return pronto(b, {
      value: `${rd(g.watts)} W`,
      sub: pct === null ? "" : `${rd(pct)}% do limite`,
      level: "safe",
      pct: pct === null ? null : pctClamp(pct),
    });
  });
}

function gpuFanView(st, o = {}) {
  return gpuView(st, "gpufan", o.label || "VENTOINHA", (g, b) =>
    isNum(g.fan)
      ? pronto(b, {
          value: `${rd(g.fan)}%`,
          sub: "da rotação máx.",
          level: levelFor("gpufan", g.fan),
          pct: pctClamp(g.fan),
        })
      : null
  );
}

function gpuClockView(st, o = {}) {
  return gpuView(st, "gpuclock", o.label || "CLOCK GPU", (g, b) => {
    if (!isNum(g.clockMHz)) return null;
    const pct = isNum(g.clockMaxMHz) && g.clockMaxMHz > 0 ? (100 * g.clockMHz) / g.clockMaxMHz : null;
    return pronto(b, {
      value: rd(g.clockMHz),
      sub: pct === null ? "MHz" : `MHz · ${rd(pct)}% máx`,
      level: "safe",
      pct: pct === null ? null : pctClamp(pct),
    });
  });
}

function diskView(st, drive, o = {}) {
  const L = driveLetter(drive);
  const b = base(st, "disk", o.label || `DISCO ${L}:`, "disk", `disk:${L}`);
  const d = st && st.disks && st.disks[L];
  if (!d) return semDado(b, { status: "sem-unidade" });
  if (d.status !== "ok" || !isNum(d.pct)) return semDado(b, d);
  const livre = d.freeGB >= 1024 ? `${fmtNum(d.freeGB / 1024)} TB` : `${fmtNum(d.freeGB)} GB`;
  return pronto(b, {
    value: `${rd(d.pct)}%`,
    sub: `${livre} livres`,
    level: levelFor("disk", d.pct),
    pct: pctClamp(d.pct),
  });
}

/** Velocidade de disco. `dir` = "w" (gravacao) | "r" (leitura); `target` = "total" | letra. */
function diskIoView(st, dir, target, o = {}) {
  const write = dir === "w";
  const T = diskTarget(target);
  const metric = write ? "diskwrite" : "diskread";
  const nome = write ? (T === "total" ? "GRAVAÇÃO" : `GRAV. ${T}:`) : T === "total" ? "LEITURA" : `LEIT. ${T}:`;
  const b = base(st, metric, o.label || nome, "disk", T === "total" ? metric : `${metric}:${T}`);
  const io = st && st.io;
  if (!io || io.status !== "ok") return semDado(b, io);
  const d = io.disk && io.disk[T];
  if (!d) return semDado(b, { status: "sem-unidade" }, "sem disco");
  const v = d[dir];
  if (!isNum(v)) return semDado(b, { status: "sem-dado" });
  const r = fmtByteRate(v);
  return pronto(b, { value: r.n, sub: r.unit, level: "safe", pct: null });
}

function netView(st, dir, o = {}) {
  const down = dir === "down";
  const metric = down ? "netdown" : "netup";
  const b = base(st, metric, o.label || (down ? "DOWNLOAD" : "UPLOAD"), "net");
  const io = st && st.io;
  if (!io || io.status !== "ok") return semDado(b, io);
  const v = down ? io.netDown : io.netUp;
  if (!isNum(v)) return semDado(b, { status: "sem-dado" });
  const r = fmtBitRate(v);
  return pronto(b, { value: r.n, sub: r.unit, level: "safe", pct: null });
}

function netTotalView(st, o = {}) {
  const b = base(st, "nettotal", o.label || "REDE · SESSÃO", "net", "netdown");
  const io = st && st.io;
  if (!io || io.status !== "ok") return semDado(b, io);
  if (!isNum(io.totalDown) || !isNum(io.totalUp)) return semDado(b, { status: "sem-dado" });
  return pronto(b, {
    value: fmtBytes(io.totalDown + io.totalUp),
    sub: `↓${fmtBytes(io.totalDown)} ↑${fmtBytes(io.totalUp)}`,
    level: "safe",
    pct: null,
  });
}

// ---------------------------------------------------------------- teclas

/**
 * View de uma tecla. `action` e o nome curto (`cpu`, `diskwrite`...). `settings` e o da instancia:
 * `{drive}` para `disk`, `{disk}` para `diskwrite`/`diskread`.
 */
function view(st, action, settings) {
  const s = settings || {};
  switch (action) {
    case "cpu":
      return cpuView(st);
    case "cputemp":
      return cpuTempView(st);
    case "ram":
      return ramView(st);
    case "gpu":
      return gpuUsoView(st);
    case "gputemp":
      return gpuTempView(st);
    case "vram":
      return vramView(st);
    case "gpupower":
      return gpuPowerView(st);
    case "gpufan":
      return gpuFanView(st);
    case "gpuclock":
      return gpuClockView(st);
    case "disk":
      return diskView(st, s.drive);
    case "diskwrite":
      return diskIoView(st, "w", s.disk);
    case "diskread":
      return diskIoView(st, "r", s.disk);
    case "netdown":
      return netView(st, "down");
    case "netup":
      return netView(st, "up");
    default:
      return { kind: "plain", metric: action, label: "?", value: "n/d", sub: "ação desconhecida", level: "offline", pct: null, hist: [] };
  }
}

// ---------------------------------------------------------------- dials

/**
 * Itens pelos quais um dial gira. `opts.drives` = unidades configuradas (global) — so entram as
 * que respondem. A lista pode mudar de tamanho (temperatura some sem LHM); o indice e sempre
 * reduzido por modulo.
 */
function dialItems(st, action, settings, opts) {
  const o = opts || {};
  switch (action) {
    case "dialcpu": {
      const itens = [cpuView(st, { label: "CPU · USO" }), cpuFreqView(st, { label: "CPU · FREQ" })];
      if (st && st.cputemp && st.cputemp.status === "ok") itens.push(cpuTempView(st, { label: "CPU · TEMP" }));
      itens.push(threadsView(st, { label: "CPU · THREADS" }));
      return itens;
    }
    case "dialmem":
      return [ramView(st, { label: "RAM · USO" }), ramGbView(st, "used"), ramGbView(st, "free")];
    case "dialgpu":
      return [
        gpuUsoView(st, { label: "GPU · USO" }),
        gpuTempView(st, { label: "GPU · TEMP" }),
        vramView(st, { label: "GPU · VRAM" }),
        gpuPowerView(st, { label: "GPU · ENERGIA" }),
        gpuFanView(st, { label: "GPU · FAN" }),
        gpuClockView(st, { label: "GPU · CLOCK" }),
      ];
    case "dialdisk": {
      const letras = (Array.isArray(o.drives) ? o.drives : ["C", "D", "E"]).map((d) => driveLetter(d));
      const unicas = [...new Set(letras)];
      const itens = [];
      for (const L of unicas) {
        const d = st && st.disks && st.disks[L];
        if (d && d.status === "ok") itens.push(diskView(st, L));
      }
      itens.push(diskIoView(st, "w", "total", { label: "DISCO · GRAVAÇÃO" }));
      itens.push(diskIoView(st, "r", "total", { label: "DISCO · LEITURA" }));
      return itens;
    }
    case "dialnet":
      return [
        netView(st, "down", { label: "REDE · DOWNLOAD" }),
        netView(st, "up", { label: "REDE · UPLOAD" }),
        netTotalView(st),
      ];
    default:
      return [view(st, action, settings)];
  }
}

/** O item atual do dial: `settings.cycleIndex` (guardado na instancia) reduzido por modulo. */
function dialView(st, action, settings, opts) {
  const itens = dialItems(st, action, settings, opts);
  const n = itens.length || 1;
  const i = Number.isInteger((settings || {}).cycleIndex) ? settings.cycleIndex : 0;
  return itens[((i % n) + n) % n];
}

// ---------------------------------------------------------------- necessidades

/**
 * O que a acao precisa: fontes e unidades. O plugin junta as de todas as instancias visiveis
 * e so entao liga cada coleta.
 */
function needsOf(action, settings, global) {
  const a = ACTIONS[action];
  if (!a) return { sources: [], drives: [] };
  const s = settings || {};
  const g = global || {};
  let drives = [];
  if (action === "disk") drives = [driveLetter(s.drive)];
  if (action === "dialdisk") drives = (Array.isArray(g.drives) ? g.drives : ["C", "D", "E"]).map((d) => driveLetter(d));
  return { sources: a.needs.slice(), drives };
}

module.exports = {
  ACTIONS,
  KEY_ACTIONS,
  DIAL_ACTIONS,
  LIMIARES,
  ACCENT,
  view,
  dialItems,
  dialView,
  needsOf,
  levelFor,
  driveLetter,
  diskTarget,
  fmtNum,
  fmtByteRate,
  fmtBitRate,
  fmtBytes,
};
