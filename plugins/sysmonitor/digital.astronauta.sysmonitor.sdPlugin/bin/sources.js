"use strict";
/**
 * sources.js — fontes de dado do sysmonitor v2. Cada uma tem custo e ritmo proprios (medidos
 * neste PC em 15/08/2026 e 10/10/2026), entao o agendamento e POR FONTE, nao um intervalo global:
 *
 *   CPU / RAM    ~0 ms     em processo (os.cpus com delta, os.totalmem/freemem)  refreshCpuSeconds
 *   GPU NVIDIA   ~65 ms    subprocesso nvidia-smi (vem com o driver)             refreshGpuSeconds
 *   GPU AMD/Intel  --      sem nvidia-smi: uso e memoria pelo coletor PowerShell (contadores
 *                          GPUPerformanceCounters, os mesmos do Gerenciador de Tarefas);
 *                          temperatura, energia, ventoinha e clock pelo LHM      refreshGpuSeconds
 *   Espaco disco ~2 ms     fs.statfs, SO das unidades configuradas               refreshDiskSeconds
 *   Temp. CPU    http      LibreHardwareMonitor (opcional) em lhmUrl/data.json   refreshGpuSeconds
 *   Disco/rede   ~0,3 s    coletor PowerShell PERSISTENTE (WMI formatado)        refreshIoSeconds
 *
 * Por que um coletor persistente para velocidade de disco e rede: Get-Counter/typeperf exigem
 * o NOME do contador, e o Windows deste PC esta em portugues ("O objeto especificado nao foi
 * encontrado"). As classes WMI formatadas (Win32_PerfFormattedData_*) tem nome fixo em ingles
 * em qualquer idioma. Mas Get-CimInstance custa ~1 s por chamada com processo novo, entao UM
 * PowerShell fica vivo e escreve uma linha JSON por ciclo. CPU medida: ~2,7 s de partida (uma
 * vez) e <1% de um nucleo depois. Sem admin.
 *
 * Ciclo de vida do coletor: religa com backoff (1,2,4...30 s) se morrer; e encerrado quando o
 * plugin sai (process 'exit') e, se o plugin for morto na marra, ele proprio percebe que o pai
 * sumiu (confere o PID a cada ciclo) e termina — sem processo orfao.
 *
 * Modo de teste: SYSMON_FAKE=1 devolve dados sinteticos deterministicos, sem spawn de
 * nvidia-smi nem PowerShell. SYSMON_FAKE_MISSING=gpu,io,lhm simula fontes ausentes;
 * SYSMON_FAKE_MISSING=nvidia simula placa AMD (caminho do Windows + LHM).
 *
 * Validacao neste PC:  node bin/sources.js --probe   (UMA leitura real, somente leitura)
 */

const os = require("os");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");

const GB = 1073741824;
const HIST_SIZE = 30;
/** Quanto tempo uma fonte continua ligada depois que a ultima tecla que a usava sumiu. */
const GRACE_MS = 30000;

const DEFAULTS = Object.freeze({
  refreshCpuSeconds: 1,
  refreshGpuSeconds: 3,
  refreshDiskSeconds: 60,
  refreshIoSeconds: 2,
  lhmUrl: "http://127.0.0.1:8085",
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ================================================================ GPU (nvidia-smi)

/**
 * Os mesmos numeros do app da NVIDIA (Sistema > Desempenho): o app e uma interface sobre o NVML
 * e o nvidia-smi le o NVML direto. Fora do alcance: tensao da GPU (so via NVAPI).
 * `name` vai por ultimo porque e texto livre e pode (raramente) ter virgula.
 */
const CAMPOS_GPU = [
  "utilization.gpu",
  "temperature.gpu",
  "memory.used",
  "memory.total",
  "power.draw",
  "power.limit",
  "fan.speed",
  "clocks.current.graphics",
  "clocks.max.graphics",
  "clocks.current.memory",
  "clocks.max.memory",
  "utilization.memory",
  "name",
];

/** Uma linha CSV do nvidia-smi -> objeto. Campo `[N/A]` ou vazio vira null, nunca 0. */
function parseGpuLine(line) {
  const parts = String(line || "")
    .trim()
    .split(",")
    .map((s) => s.trim());
  if (parts.length < CAMPOS_GPU.length) return null;
  const n = (i) => {
    const x = Number(parts[i]);
    return parts[i] !== "" && Number.isFinite(x) ? x : null;
  };
  return {
    util: n(0),
    temp: n(1),
    memUsedMB: n(2),
    memTotalMB: n(3),
    watts: n(4),
    wattsLimit: n(5),
    fan: n(6),
    clockMHz: n(7),
    clockMaxMHz: n(8),
    vramClockMHz: n(9),
    vramClockMaxMHz: n(10),
    memUtil: n(11),
    name: parts.slice(12).join(",") || null,
  };
}

// ================================================================ temperatura de CPU (LHM)

/**
 * O Windows nao expoe temperatura de CPU para software em modo usuario (testado:
 * MSAcpi_ThermalZoneTemperature = "Sem suporte"). A saida honesta e o LibreHardwareMonitor,
 * que carrega o driver e tem servidor HTTP. Sem ele: `n/d`, sem barulho.
 *
 * Parse tolerante: a arvore do /data.json varia entre versoes e idiomas ("45,3 °C" ou
 * "45.3 °C"). Acha o hardware que e CPU (SensorId /amdcpu|/intelcpu, icone cpu.png ou nome de
 * processador, sem nome de placa de video) e escolhe o sensor por prioridade.
 */
function sensorScore(text) {
  const t = String(text || "");
  if (/package/i.test(t)) return 100; // Intel: "CPU Package"
  if (/tctl|tdie/i.test(t)) return 90; // AMD: "Core (Tctl/Tdie)"
  if (/core.*max|max.*core/i.test(t)) return 80;
  if (/^cpu$|cpu total|total/i.test(t)) return 60;
  if (/core/i.test(t)) return 50;
  return 10;
}

function isCpuHardware(n) {
  const id = String(n.SensorId || "");
  if (/^\/(amd|intel)cpu\//i.test(id)) return true;
  const img = String(n.ImageURL || "");
  if (/cpu/i.test(img)) return true;
  const t = String(n.Text || "");
  if (/radeon|geforce|nvidia|\bgpu\b|\brtx\b|\bgtx\b|arc\s?a\d/i.test(t)) return false;
  return /\bcpu\b|ryzen|core\s?i\d|core\s?ultra|xeon|threadripper|pentium|celeron|athlon|epyc/i.test(t);
}

function isTempSensor(n) {
  const v = String(n.Value || "");
  if (String(n.Type || "").toLowerCase() === "temperature") return true;
  if (/\/temperature\//i.test(String(n.SensorId || ""))) return true;
  return /°\s*[CF]\s*$/i.test(v.trim());
}

function parseTemp(value) {
  const s = String(value || "");
  const x = parseFloat(s.replace(",", "."));
  if (!Number.isFinite(x)) return null;
  return /°\s*F/i.test(s) ? (x - 32) / 1.8 : x;
}

/** Varre a arvore do LHM e devolve `{temp, sensor}` ou null. */
function findCpuTemp(root) {
  let best = null;
  const consider = (score, temp, sensor) => {
    if (!best || score > best.score || (score === best.score && temp > best.temp)) best = { score, temp, sensor };
  };

  function visit(n, inCpu, depth) {
    if (!n || typeof n !== "object" || depth > 12) return;
    const cpu = inCpu || isCpuHardware(n);
    if (isTempSensor(n) && Object.prototype.hasOwnProperty.call(n, "Value")) {
      const temp = parseTemp(n.Value);
      if (temp !== null && temp > 0 && temp < 150) {
        if (cpu) consider(sensorScore(n.Text), temp, String(n.Text || ""));
        else if (/^cpu( socket)?$/i.test(String(n.Text || ""))) consider(5, temp, String(n.Text)); // placa-mae
      }
    }
    const filhos = Array.isArray(n.Children) ? n.Children : [];
    for (const f of filhos) visit(f, cpu, depth + 1);
  }

  visit(root, false, 0);
  return best ? { temp: best.temp, sensor: best.sensor } : null;
}

// ================================================================ GPU sem nvidia-smi (AMD e Intel)

/**
 * Sensores de GPU no /data.json do LHM: SensorId "/gpu-amd/0/temperature/0", "/gpu-intel/0/...".
 * Placa AMD tem prioridade sobre Intel (num PC com as duas, a AMD e a dedicada). NVIDIA so entra
 * aqui se o nvidia-smi faltar. Devolve `{name, temp, watts, fan, clockMHz}` (campo sem sensor =
 * null) ou null se nao houver GPU no LHM.
 */
function findGpuSensors(root) {
  const grupos = new Map(); // "amd/0" -> { vendor, name, sensores: [{type, text, value}] }
  function visit(n, hwName, depth) {
    if (!n || typeof n !== "object" || depth > 12) return;
    const id = String(n.SensorId || "");
    const m = id.match(/^\/gpu-(amd|intel|nvidia)\/(\d+)\/([a-z]+)\//i);
    if (m && Object.prototype.hasOwnProperty.call(n, "Value")) {
      const k = `${m[1].toLowerCase()}/${m[2]}`;
      const g = grupos.get(k) || { vendor: m[1].toLowerCase(), name: hwName || null, sensores: [] };
      g.sensores.push({ type: m[3].toLowerCase(), text: String(n.Text || ""), value: String(n.Value || "") });
      grupos.set(k, g);
    }
    // o nome da placa e o no de hardware acima dos sensores (Text sem SensorId)
    const nome = !id && /radeon|amd|intel|arc|iris|uhd|nvidia|geforce|graphics/i.test(String(n.Text || "")) ? String(n.Text) : hwName;
    for (const f of Array.isArray(n.Children) ? n.Children : []) visit(f, nome, depth + 1);
  }
  visit(root, null, 0);
  if (!grupos.size) return null;
  const ordem = { amd: 0, intel: 1, nvidia: 2 };
  const g = [...grupos.values()].sort((a, b) => ordem[a.vendor] - ordem[b.vendor])[0];
  const num = (v) => {
    const x = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(x) ? x : null;
  };
  const pick = (type, prefer) => {
    const lista = g.sensores.filter((x) => x.type === type && num(x.value) !== null);
    for (const re of prefer) {
      const achou = lista.find((x) => re.test(x.text));
      if (achou) return num(achou.value);
    }
    return lista.length ? num(lista[0].value) : null;
  };
  const temp = pick("temperature", [/core|edge|^gpu$/i, /hot ?spot/i]);
  const watts = pick("power", [/package|total|board|ppt/i, /core/i]);
  const fanList = g.sensores.filter((x) => x.type === "control" && /fan/i.test(x.text) && num(x.value) !== null);
  const fan = fanList.length ? num(fanList[0].value) : null;
  const clockMHz = pick("clock", [/core|^gpu$|graphics|shader/i]);
  return {
    vendor: g.vendor,
    name: g.name,
    temp: temp !== null && temp > 0 && temp < 150 ? temp : null,
    watts: watts !== null && watts >= 0 ? watts : null,
    fan: fan !== null ? clamp(fan, 0, 100) : null,
    clockMHz: clockMHz !== null && clockMHz > 0 ? clockMHz : null,
  };
}

/** Placas que nao sao GPU de verdade (adaptador basico, area de trabalho remota, monitor virtual). */
const GPU_FALSA = /microsoft basic|remote display|remotefx|virtual|parsec|displaylink|indirect display|\bidd\b|meta virtual|spacedesk|citrix|vmware|virtualbox|hyper-v/i;

/**
 * Parte de GPU da linha do coletor -> `{name, util, memUsedMB, memTotalMB, integrada}` ou null.
 *   gpuEng: [{l: luid, u: % (maior motor da placa, como no Gerenciador de Tarefas)}]
 *   gpuMem: [{l: luid, d: bytes dedicados em uso, s: bytes compartilhados em uso}]
 *   gpuAdapters: [{n: nome do driver, v: bytes de VRAM pelo registro}]
 * O contador nao diz o nome da placa e o registro nao diz o luid, entao: o nome e a VRAM total sao
 * da placa com mais VRAM (a dedicada, se houver), e uso e memoria vem do luid que mais usa memoria
 * dedicada. Placa integrada (menos de 1 GB de VRAM propria) usa memoria compartilhada: o total e
 * metade da RAM, que e o teto que o Windows reserva para ela.
 */
function summarizeGpu(msg, totalRamBytes) {
  const adapters = (Array.isArray(msg.gpuAdapters) ? msg.gpuAdapters : []).filter(
    (a) => a && typeof a.n === "string" && !GPU_FALSA.test(a.n)
  );
  const mem = (Array.isArray(msg.gpuMem) ? msg.gpuMem : []).filter((m) => m && typeof m.l === "string");
  const eng = (Array.isArray(msg.gpuEng) ? msg.gpuEng : []).filter((e) => e && typeof e.l === "string");
  if (!adapters.length || (!mem.length && !eng.length)) return null;

  const placa = adapters.slice().sort((a, b) => (Number(b.v) || 0) - (Number(a.v) || 0))[0];
  const vramBytes = Number(placa.v) || 0;
  const integrada = vramBytes < GB;

  let luid = null;
  if (mem.length) {
    const campo = integrada ? "s" : "d";
    luid = mem.slice().sort((a, b) => (Number(b[campo]) || 0) - (Number(a[campo]) || 0))[0].l;
  } else {
    luid = eng.slice().sort((a, b) => (Number(b.u) || 0) - (Number(a.u) || 0))[0].l;
  }
  const e = eng.find((x) => x.l === luid);
  const m = mem.find((x) => x.l === luid);
  const MB = 1048576;
  const util = e && isNum(e.u) ? clamp(e.u, 0, 100) : null;
  let memUsedMB = null;
  let memTotalMB = null;
  if (m) {
    if (integrada) {
      memUsedMB = isNum(m.s) ? m.s / MB : null;
      memTotalMB = isNum(totalRamBytes) && totalRamBytes > 0 ? totalRamBytes / 2 / MB : null;
    } else {
      memUsedMB = isNum(m.d) ? m.d / MB : null;
      memTotalMB = vramBytes / MB;
    }
  }
  return { name: placa.n, util, memUsedMB, memTotalMB, integrada };
}

// ================================================================ coletor PowerShell

/** Interfaces que nao sao trafego real: somar duplicaria ou inflaria o numero. */
const NET_VIRTUAL = /loopback|isatap|teredo|6to4|pseudo|virtual|vmware|vethernet|hyper-v|virtualbox|wan miniport|bluetooth|tailscale|wireguard|\bvpn\b|npcap|\btap\b|tunnel|docker|\bwsl\b|kernel debug|ras async|microsoft kernel/i;

/**
 * Script do coletor. Roda em PowerShell 5.1 (o que vem no Windows). Passado por
 * -EncodedCommand: nao depende da ExecutionPolicy (que neste PC bloqueia .ps1) nem de
 * escapar aspas na linha de comando.
 */
function collectorScript(parentPid, intervalMs, withGpu) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$parent = ${Number(parentPid) | 0}
$interval = ${Math.max(500, Number(intervalMs) | 0)}
$withGpu = $${withGpu ? "true" : "false"}
$adapters = $null
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$out = [Console]::Out
$cim = New-CimSession
while ($true) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { [void][Diagnostics.Process]::GetProcessById($parent) } catch { break }
  $o = [ordered]@{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $o.disks = @(Get-CimInstance -CimSession $cim -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk | ForEach-Object { @{ n = [string]$_.Name; w = [double]$_.DiskWriteBytesPersec; r = [double]$_.DiskReadBytesPersec } })
  $o.net = @(Get-CimInstance -CimSession $cim -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface | ForEach-Object { @{ n = [string]$_.Name; rx = [double]$_.BytesReceivedPersec; tx = [double]$_.BytesSentPersec } })
  $p = Get-CimInstance -CimSession $cim -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" | Select-Object -First 1
  if ($p) { $o.cpu = @{ baseMHz = [double]$p.ProcessorFrequency; perf = [double]$p.PercentProcessorPerformance } }
  if ($withGpu) {
    # uso por placa = maior motor (soma dos processos em cada motor), como no Gerenciador de Tarefas
    $per = @{}
    foreach ($e in (Get-CimInstance -CimSession $cim -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)) {
      if ([string]$e.Name -match 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\\d+_eng_(\\d+)') {
        $k = $matches[1] + '|' + $matches[2]
        $per[$k] = [double]$per[$k] + [double]$e.UtilizationPercentage
      }
    }
    $util = @{}
    foreach ($k in $per.Keys) { $l = $k.Split('|')[0]; if (-not $util.ContainsKey($l) -or $per[$k] -gt $util[$l]) { $util[$l] = $per[$k] } }
    $o.gpuEng = @($util.Keys | ForEach-Object { @{ l = $_; u = $util[$_] } })
    $o.gpuMem = @(Get-CimInstance -CimSession $cim -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ForEach-Object {
      if ([string]$_.Name -match 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { @{ l = $matches[1]; d = [double]$_.DedicatedUsage; s = [double]$_.SharedUsage } } })
    if ($adapters -eq $null) {
      # nome e VRAM total pelo registro (Win32_VideoController.AdapterRAM para em 4 GB); lido uma vez
      $cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
      $adapters = @(Get-ChildItem $cls | ForEach-Object {
        $r = Get-ItemProperty $_.PSPath
        if ($r.DriverDesc) {
          $q = $r.'HardwareInformation.qwMemorySize'
          if (-not $q) { $mm = $r.'HardwareInformation.MemorySize'; if ($mm -is [byte[]]) { $q = [BitConverter]::ToUInt32($mm, 0) } else { $q = $mm } }
          @{ n = [string]$r.DriverDesc; v = [double]$q }
        } })
    }
    $o.gpuAdapters = $adapters
  }
  try { $out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); $out.Flush() } catch { break }
  $rest = $interval - $sw.ElapsedMilliseconds
  if ($rest -lt 100) { $rest = 100 }
  Start-Sleep -Milliseconds $rest
}
`;
}

/** Uma linha do coletor -> objeto, ou null se for lixo (aviso do PowerShell, linha cortada...). */
function parseCollectorLine(line) {
  const s = String(line || "")
    .replace(/^﻿/, "")
    .trim();
  if (!s || s[0] !== "{") return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/**
 * Reduz a mensagem bruta do coletor ao que o plugin usa.
 * Discos: "_Total" -> total; "2 C:" -> C; "0 C: D:" (varias particoes) -> C e D.
 * Rede: soma das interfaces reais.
 */
function summarizeIo(msg) {
  const disk = {};
  const letters = [];
  for (const d of Array.isArray(msg.disks) ? msg.disks : []) {
    if (!d || typeof d.n !== "string") continue;
    const v = { w: isNum(d.w) ? d.w : null, r: isNum(d.r) ? d.r : null };
    if (d.n === "_Total") {
      disk.total = v;
      continue;
    }
    for (const m of d.n.matchAll(/([A-Za-z]):/g)) {
      const L = m[1].toUpperCase();
      disk[L] = v;
      if (!letters.includes(L)) letters.push(L);
    }
  }

  let rx = 0;
  let tx = 0;
  let nets = 0;
  const ifaces = [];
  for (const i of Array.isArray(msg.net) ? msg.net : []) {
    if (!i || typeof i.n !== "string") continue;
    const counted = !NET_VIRTUAL.test(i.n);
    ifaces.push({ name: i.n, rx: i.rx, tx: i.tx, counted });
    if (counted && isNum(i.rx) && isNum(i.tx)) {
      rx += i.rx;
      tx += i.tx;
      nets++;
    }
  }

  const c = msg.cpu;
  const mhz = c && isNum(c.baseMHz) && isNum(c.perf) && c.baseMHz > 0 ? (c.baseMHz * c.perf) / 100 : null;

  return {
    disk,
    letters,
    hasDisks: disk.total !== undefined,
    hasNet: nets > 0,
    netDown: nets > 0 ? rx : null,
    netUp: nets > 0 ? tx : null,
    ifaces,
    cpufreq: mhz === null ? null : { mhz, baseMHz: c.baseMHz },
  };
}

// ================================================================ fabrica

/**
 * Cria o conjunto de fontes. Nada roda ate `configure({needs})` pedir: so liga o que esta
 * visivel no Stream Deck.
 *
 *   const src = createSources({ log });
 *   src.configure({ needs: {cpu:true, gpu:true}, drives:["C"], refreshGpuSeconds: 3 });
 *   src.onUpdate((nome) => ...);   // "cpu"|"ram"|"gpu"|"cputemp"|"disk"|"io"
 *   src.snapshot();                // objeto no formato do views.js
 */
function createSources(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const fake = opts.fake !== undefined ? !!opts.fake : process.env.SYSMON_FAKE === "1";
  const fakeMissing = new Set(
    String(opts.fakeMissing !== undefined ? opts.fakeMissing : process.env.SYSMON_FAKE_MISSING || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const cfg = { ...DEFAULTS };
  const need = { cpu: false, ram: false, gpu: false, cputemp: false, io: false, disk: false };
  // Trocar de pagina no Stream Deck faz todas as teclas sumirem e reaparecerem. Sem folga, cada
  // swipe desligaria e religaria as fontes (o coletor custa ~2,7 s de CPU para subir e o CPU
  // perderia a base do delta). Por isso uma fonte so desliga GRACE_MS depois de ficar sem uso.
  const needUntil = {};
  let graceTimer = null;
  const want = (k) => need[k] || Date.now() < (needUntil[k] || 0);
  let drives = [];
  let drivesKey = "";

  const data = {
    cpu: { status: "aguardando" },
    cpufreq: { status: "aguardando" },
    ram: { status: "aguardando" },
    gpu: { status: "aguardando" },
    cputemp: { status: "aguardando" },
    disks: {},
    io: { status: "aguardando" },
  };
  const stamp = {}; // fonte -> ms da ultima leitura boa
  const hist = {}; // metrica -> number[] (circular, HIST_SIZE)
  const timers = {}; // nome -> { id, ms }
  const listeners = [];
  let tick = 0;
  let stopped = false;

  // ---------------------------------------------------------------- utilidades

  function pushHist(key, v) {
    if (!isNum(v)) return;
    const a = hist[key] || (hist[key] = []);
    a.push(v);
    if (a.length > HIST_SIZE) a.shift();
  }

  function emit(nome) {
    for (const fn of listeners) {
      try {
        fn(nome);
      } catch (err) {
        log(`erro no ouvinte: ${err.message}`);
      }
    }
  }

  function onUpdate(fn) {
    listeners.push(fn);
  }

  function staleMs(nome) {
    switch (nome) {
      case "cpu":
      case "ram":
        return Math.max(6000, cfg.refreshCpuSeconds * 4000);
      case "gpu":
        return Math.max(8000, cfg.refreshGpuSeconds * 4000);
      case "cputemp":
        return Math.max(10000, cfg.refreshGpuSeconds * 4000);
      case "io":
        return Math.max(10000, cfg.refreshIoSeconds * 5000);
      default:
        return cfg.refreshDiskSeconds * 3000 + 5000;
    }
  }

  /** Leitura boa que envelheceu demais vira `obsoleto` (n/d), nunca numero parado fingindo vida. */
  function fresh(nome, v, now) {
    if (v && v.status === "ok" && stamp[nome] && now - stamp[nome] > staleMs(nome)) return { status: "obsoleto" };
    return v;
  }

  function snapshot() {
    const now = Date.now();
    const disks = {};
    for (const L of Object.keys(data.disks)) disks[L] = fresh(`disk:${L}`, data.disks[L], now);
    const histCopy = {};
    for (const k of Object.keys(hist)) histCopy[k] = hist[k].slice();
    return {
      t: now,
      cpu: fresh("cpu", data.cpu, now),
      cpufreq: fresh("io", data.cpufreq, now),
      ram: fresh("ram", data.ram, now),
      gpu: fresh("gpu", data.gpu, now),
      cputemp: fresh("cputemp", data.cputemp, now),
      disks,
      io: fresh("io", data.io, now),
      hist: histCopy,
    };
  }

  // ---------------------------------------------------------------- CPU e RAM

  let prevCpu = null;
  let prevCpuAt = 0;

  /**
   * os.cpus() devolve contadores ACUMULADOS desde o boot. O uso e a diferenca entre duas
   * amostras: a primeira nao tem base e fica `aguardando` (a tecla mostra "..." em vez de
   * mentir 0%). Duas leituras com menos de 400 ms de distancia (toque no strip em rajada) nao
   * atualizam a base.
   */
  function sampleCpu() {
    const now = Date.now();
    if (fake) {
      tick++;
      const pct = 28 + 12 * Math.sin(tick / 4);
      data.cpu = { status: "ok", pct, threads: 16, busy: 3 };
      stamp.cpu = now;
      pushHist("cpu", pct);
      emit("cpu");
      return;
    }
    if (prevCpu && now - prevCpuAt < 400) return;
    const cur = os.cpus().map((c) => {
      let total = 0;
      for (const k of Object.keys(c.times)) total += c.times[k];
      return { idle: c.times.idle, total };
    });
    if (prevCpu && prevCpu.length === cur.length) {
      let dT = 0;
      let dI = 0;
      let busy = 0;
      cur.forEach((c, i) => {
        const t = c.total - prevCpu[i].total;
        const idle = c.idle - prevCpu[i].idle;
        dT += t;
        dI += idle;
        if (t > 0 && (100 * (t - idle)) / t > 50) busy++;
      });
      if (dT > 0) {
        const pct = clamp((100 * (dT - dI)) / dT, 0, 100);
        data.cpu = { status: "ok", pct, threads: cur.length, busy };
        stamp.cpu = now;
        pushHist("cpu", pct);
        emit("cpu");
      }
    } else {
      data.cpu = { status: "aguardando", threads: cur.length };
    }
    prevCpu = cur;
    prevCpuAt = now;
  }

  function sampleRam() {
    const now = Date.now();
    let total;
    let livre;
    if (fake) {
      total = 31.9 * GB;
      livre = total - 18.0 * GB;
    } else {
      total = os.totalmem();
      livre = os.freemem();
    }
    const usado = total - livre;
    const pct = (100 * usado) / total;
    data.ram = { status: "ok", pct, usedGB: usado / GB, freeGB: livre / GB, totalGB: total / GB };
    stamp.ram = now;
    pushHist("ram", pct);
    emit("ram");
  }

  // ---------------------------------------------------------------- GPU

  let gpuBusy = false;
  let gpuFails = 0;
  let gpuRetryAt = 0; // depois de ENOENT, so tenta de novo daqui a 60 s
  // "nvidia" ate o nvidia-smi faltar; ai "windows": uso e memoria pelo coletor, o resto pelo LHM
  let gpuMode = "nvidia";
  let winGpu = null; // ultima leitura de GPU do coletor: { at, ...summarizeGpu }

  function setGpu(v) {
    data.gpu = v;
    if (v.status === "ok") {
      stamp.gpu = Date.now();
      pushHist("gpu", v.util);
      pushHist("gputemp", v.temp);
      pushHist("vram", isNum(v.memUsedMB) && v.memTotalMB > 0 ? (100 * v.memUsedMB) / v.memTotalMB : null);
      pushHist("gpupower", v.watts);
      pushHist("gpufan", v.fan);
      pushHist("gpuclock", v.clockMHz);
    }
    emit("gpu");
  }

  /** Caminho do Windows: junta a ultima leitura do coletor com os sensores do LHM. */
  function sampleWinGpu() {
    if (fake) {
      if (!winGpu) return;
    } else if (!winGpu) {
      if (data.gpu.status === "aguardando" && col) return; // coletor subindo
      return setGpu({ status: col ? "ausente" : "coletor" });
    }
    if (Date.now() - winGpu.at > staleMs("gpu")) return setGpu({ status: "falha" });
    fetchLhm((root) => {
      if (stopped || !winGpu) return;
      const sens = root ? findGpuSensors(root) : null;
      setGpu({
        status: "ok",
        fonte: "windows",
        lhm: !!root,
        name: winGpu.name,
        integrada: winGpu.integrada,
        util: winGpu.util,
        memUsedMB: winGpu.memUsedMB,
        memTotalMB: winGpu.memTotalMB,
        temp: sens ? sens.temp : null,
        watts: sens ? sens.watts : null,
        wattsLimit: null,
        fan: sens ? sens.fan : null,
        clockMHz: sens ? sens.clockMHz : null,
        clockMaxMHz: null,
        vramClockMHz: null,
        vramClockMaxMHz: null,
        memUtil: null,
      });
    });
  }

  function gpuFromMessage(msg) {
    if (!("gpuAdapters" in msg) && !("gpuEng" in msg)) return;
    const g = summarizeGpu(msg, fake ? 31.9 * GB : os.totalmem());
    winGpu = g ? { at: Date.now(), ...g } : null;
    if (!g && gpuMode === "windows" && data.gpu.status !== "ausente") setGpu({ status: "ausente" });
  }

  function useWindowsGpu() {
    if (gpuMode === "windows") return;
    gpuMode = "windows";
    log("nvidia-smi nao encontrado; GPU pelos contadores do Windows e pelo LHM");
    apply(); // religa o coletor com a parte de GPU
  }

  function sampleGpu() {
    if (gpuMode === "windows") return sampleWinGpu();
    if (fake) {
      if (fakeMissing.has("gpu")) return setGpu({ status: "ausente" });
      if (fakeMissing.has("nvidia")) {
        useWindowsGpu();
        return sampleWinGpu();
      }
      return setGpu({
        status: "ok",
        util: 26,
        temp: 36,
        memUsedMB: 2145,
        memTotalMB: 12288,
        watts: 28.09,
        wattsLimit: 168.3,
        fan: 30,
        clockMHz: 210,
        clockMaxMHz: 2100,
        vramClockMHz: 405,
        vramClockMaxMHz: 7501,
        memUtil: 6,
        name: "NVIDIA GeForce RTX 3060",
      });
    }
    if (gpuBusy || Date.now() < gpuRetryAt) return;
    gpuBusy = true;
    execFile(
      "nvidia-smi",
      [`--query-gpu=${CAMPOS_GPU.join(",")}`, "--format=csv,noheader,nounits"],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        gpuBusy = false;
        if (stopped) return;
        if (err) {
          if (err.code === "ENOENT") {
            gpuRetryAt = Date.now() + 60000;
            if (process.platform === "win32") return useWindowsGpu();
            if (data.gpu.status !== "ausente") log("nvidia-smi nao encontrado; GPU = n/d");
            return setGpu({ status: "ausente" });
          }
          // falha transitoria: uma tolerada (mantem a ultima leitura), duas viram n/d
          gpuFails++;
          if (gpuFails >= 2) setGpu({ status: "falha" });
          return;
        }
        const g = parseGpuLine(String(stdout).split(/\r?\n/)[0]);
        if (!g) {
          gpuFails++;
          if (gpuFails >= 2) setGpu({ status: "falha" });
          return;
        }
        gpuFails = 0;
        setGpu({ status: "ok", ...g });
      }
    );
  }

  // ---------------------------------------------------------------- temperatura de CPU (LHM)

  // Uma leitura do /data.json serve a temperatura da CPU e os sensores da GPU no mesmo ciclo
  let lhmCache = { at: 0, root: null };
  let lhmWaiting = null; // callbacks esperando a leitura em andamento

  /** cb(root) com a arvore do LHM, ou cb(null) se ele nao respondeu. Cache de 1 s. */
  function fetchLhm(cb) {
    if (fake && fakeMissing.has("lhm")) return cb(null);
    if (Date.now() - lhmCache.at < 1000) return cb(lhmCache.root);
    if (lhmWaiting) return lhmWaiting.push(cb);
    lhmWaiting = [cb];
    let done = false;
    const fim = (root) => {
      if (done) return;
      done = true;
      lhmCache = { at: Date.now(), root };
      const fila = lhmWaiting;
      lhmWaiting = null;
      for (const f of fila) f(root);
    };
    let req;
    try {
      req = http.get(`${cfg.lhmUrl}/data.json`, { timeout: 2500 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return fim(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 4e6) req.destroy();
        });
        res.on("end", () => {
          try {
            fim(JSON.parse(body));
          } catch {
            fim(null);
          }
        });
        res.on("error", () => fim(null));
      });
    } catch {
      return fim(null);
    }
    req.on("timeout", () => req.destroy());
    req.on("error", () => fim(null));
  }

  function setCpuTemp(v) {
    data.cputemp = v;
    if (v.status === "ok") {
      stamp.cputemp = Date.now();
      pushHist("cputemp", v.temp);
    }
    emit("cputemp");
  }

  function sampleCpuTemp() {
    if (fake && fakeMissing.has("lhm")) return setCpuTemp({ status: "sem-lhm" });
    fetchLhm((root) => {
      if (stopped) return;
      if (!root) return setCpuTemp({ status: "sem-lhm" });
      const t = findCpuTemp(root);
      setCpuTemp(t ? { status: "ok", temp: t.temp, sensor: t.sensor } : { status: "sem-sensor" });
    });
  }

  // ---------------------------------------------------------------- espaco de disco

  /**
   * SO as unidades em `drives` (configuradas por tecla/global). Nunca varre letras: G: e I:
   * sao montagens do Google Drive e reportam numeros sem sentido. fs.statfs assincrono: se uma
   * unidade de rede travar, nao congela o plugin.
   */
  function sampleDisks() {
    const FAKE_DISKS = { C: [476.2, 88], D: [931.5, 46.4], E: [931.5, 50.6] };
    for (const L of drives) {
      if (fake) {
        const f = FAKE_DISKS[L];
        if (!f) data.disks[L] = { status: "sem-unidade" };
        else {
          data.disks[L] = { status: "ok", pct: f[1], totalGB: f[0], freeGB: (f[0] * (100 - f[1])) / 100 };
          stamp[`disk:${L}`] = Date.now();
          pushHist(`disk:${L}`, f[1]);
        }
        continue;
      }
      const alvo = process.platform === "win32" ? `${L}:\\` : "/";
      try {
        fs.statfs(alvo, (err, s) => {
          if (stopped) return;
          const total = s ? s.blocks * s.bsize : 0;
          if (err || !total) {
            data.disks[L] = { status: "sem-unidade" };
          } else {
            const livre = s.bavail * s.bsize;
            const pct = (100 * (total - livre)) / total;
            data.disks[L] = { status: "ok", pct, freeGB: livre / GB, totalGB: total / GB };
            stamp[`disk:${L}`] = Date.now();
            pushHist(`disk:${L}`, pct);
          }
          emit("disk");
        });
      } catch {
        data.disks[L] = { status: "sem-unidade" };
      }
    }
    emit("disk");
  }

  /** Letras que respondem — so para o inspector (acao explicita do usuario). */
  function listDrives(cb) {
    if (fake) return cb(["C", "D", "E"]);
    if (process.platform !== "win32") return cb(["/"]);
    const letras = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const ok = [];
    let pend = letras.length;
    for (const L of letras) {
      fs.statfs(`${L}:\\`, (err, s) => {
        if (!err && s && s.blocks) ok.push(L);
        if (--pend === 0) cb(ok.sort());
      });
    }
  }

  // ---------------------------------------------------------------- io: coletor PowerShell

  let col = null; // { child, buf }
  let colWanted = false;
  let colRestartTimer = null;
  let colBackoff = 0;
  let colIntervalSec = null;
  let colGpu = false; // o coletor em andamento tambem le a GPU?
  let colPid = null;
  let colLastLineAt = 0;
  let colWatchdog = null;
  let lastIoTs = null;
  let totalDown = 0;
  let totalUp = 0;

  function ioFromMessage(msg) {
    gpuFromMessage(msg);
    if (!want("io")) return; // coletor ligado so pela GPU
    const sum = summarizeIo(msg);
    const now = Date.now();
    const ts = isNum(msg.ts) ? msg.ts : now;
    const dt = lastIoTs === null ? 0 : clamp((ts - lastIoTs) / 1000, 0, cfg.refreshIoSeconds * 3 + 2);
    lastIoTs = ts;
    if (sum.hasNet) {
      totalDown += sum.netDown * dt;
      totalUp += sum.netUp * dt;
    }

    if (!sum.hasDisks && !sum.hasNet) {
      data.io = { status: "sem-dado" };
      data.cpufreq = { status: "sem-dado" };
    } else {
      data.io = {
        status: "ok",
        disk: sum.disk,
        diskLetters: sum.letters,
        netDown: sum.netDown,
        netUp: sum.netUp,
        totalDown,
        totalUp,
        ifaces: sum.ifaces,
      };
      data.cpufreq = sum.cpufreq ? { status: "ok", ...sum.cpufreq } : { status: "sem-dado" };
      stamp.io = now;
      pushHist("diskwrite", sum.disk.total && sum.disk.total.w);
      pushHist("diskread", sum.disk.total && sum.disk.total.r);
      for (const L of sum.letters) {
        pushHist(`diskwrite:${L}`, sum.disk[L].w);
        pushHist(`diskread:${L}`, sum.disk[L].r);
      }
      pushHist("netdown", sum.netDown);
      pushHist("netup", sum.netUp);
      if (sum.cpufreq) pushHist("cpufreq", sum.cpufreq.mhz);
    }
    emit("io");
  }

  function sampleFakeIo() {
    if (gpuMode === "windows") {
      gpuFromMessage({
        gpuEng: [{ l: "0x0_0xA1", u: 41 }, { l: "0x0_0xB2", u: 3 }],
        gpuMem: [
          { l: "0x0_0xA1", d: 3.2 * GB, s: 0.1 * GB },
          { l: "0x0_0xB2", d: 0.05 * GB, s: 0.6 * GB },
        ],
        gpuAdapters: [
          { n: "AMD Radeon RX 7800 XT", v: 16 * GB },
          { n: "Intel(R) UHD Graphics 770", v: 128 * 1048576 },
          { n: "Microsoft Basic Display Adapter", v: 0 },
        ],
      });
    }
    if (!want("io")) return;
    if (fakeMissing.has("io")) {
      data.io = { status: "coletor" };
      data.cpufreq = { status: "coletor" };
      return emit("io");
    }
    ioFromMessage({
      ts: Date.now(),
      disks: [
        { n: "0 D:", w: 0, r: 0 },
        { n: "1 E:", w: 0, r: 0 },
        { n: "2 C:", w: 352228, r: 96062 },
        { n: "_Total", w: 352228, r: 96062 },
      ],
      net: [
        { n: "Realtek 8852BE Wireless LAN WiFi 6 PCI-E NIC", rx: 37134698, tx: 762561 },
        { n: "Realtek Gaming 2.5GbE Family Controller", rx: 0, tx: 0 },
        { n: "Loopback Pseudo-Interface 1", rx: 99999999, tx: 99999999 },
      ],
      cpu: { baseMHz: 3401, perf: 129 },
    });
  }

  function scheduleColRestart() {
    if (!colWanted || colRestartTimer || stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(colBackoff, 5));
    colBackoff++;
    log(`coletor encerrou; reiniciando em ${delay} ms`);
    colRestartTimer = setTimeout(() => {
      colRestartTimer = null;
      if (colWanted) spawnCollector();
    }, delay);
  }

  function spawnCollector() {
    if (col || stopped) return;
    if (process.platform !== "win32") {
      data.io = { status: "coletor" };
      data.cpufreq = { status: "coletor" };
      return emit("io");
    }
    const script = collectorScript(process.pid, cfg.refreshIoSeconds * 1000, colGpu);
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      log(`falha ao iniciar o coletor: ${err.message}`);
      data.io = { status: "coletor" };
      data.cpufreq = { status: "coletor" };
      emit("io");
      return scheduleColRestart();
    }
    const mine = { child, buf: "" };
    col = mine;
    colPid = child.pid;
    colLastLineAt = Date.now();
    lastIoTs = null;
    log(`coletor iniciado pid=${child.pid}`);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      mine.buf += chunk;
      let i;
      while ((i = mine.buf.indexOf("\n")) >= 0) {
        const line = mine.buf.slice(0, i);
        mine.buf = mine.buf.slice(i + 1);
        const msg = parseCollectorLine(line);
        if (!msg) continue; // lixo tolerado
        colBackoff = 0;
        colLastLineAt = Date.now();
        ioFromMessage(msg);
      }
      if (mine.buf.length > 65536) mine.buf = ""; // linha sem fim: descarta
    });
    child.on("error", (err) => log(`coletor: ${err.message}`));
    child.on("exit", () => {
      if (col === mine) col = null;
      if (mine.intentional) return; // encerrado por nos (parada ou troca de intervalo)
      colPid = null;
      if (stopped) return;
      data.io = { status: "coletor" };
      data.cpufreq = { status: "coletor" };
      emit("io");
      scheduleColRestart();
    });
  }

  function startCollector() {
    colWanted = true;
    if (!colWatchdog) {
      // coletor vivo mas mudo (travou no WMI): mata, e o 'exit' religa com backoff
      colWatchdog = setInterval(() => {
        if (col && Date.now() - colLastLineAt > Math.max(15000, cfg.refreshIoSeconds * 6000)) {
          log("coletor sem resposta; matando para religar");
          try {
            col.child.kill();
          } catch {}
        }
      }, 5000);
    }
    if (!col && !colRestartTimer) spawnCollector();
  }

  function stopCollector() {
    colWanted = false;
    if (colWatchdog) {
      clearInterval(colWatchdog);
      colWatchdog = null;
    }
    if (colRestartTimer) {
      clearTimeout(colRestartTimer);
      colRestartTimer = null;
    }
    if (col) {
      const c = col.child;
      col.intentional = true;
      col = null;
      colPid = null;
      try {
        c.kill();
      } catch {}
    }
    colBackoff = 0;
  }

  // ---------------------------------------------------------------- agendador POR FONTE

  /** Liga/desliga/reagenda o timer de uma fonte. Devolve true se acabou de ser ligado. */
  function ensure(nome, wanted, ms, fn) {
    const cur = timers[nome];
    if (!wanted) {
      if (cur) {
        clearInterval(cur.id);
        delete timers[nome];
      }
      return false;
    }
    if (cur && cur.ms === ms) return false;
    if (cur) clearInterval(cur.id);
    timers[nome] = { id: setInterval(fn, ms), ms };
    return !cur;
  }

  function apply() {
    if (stopped) return;
    const cpuMs = cfg.refreshCpuSeconds * 1000;

    if (ensure("cpu", want("cpu"), cpuMs, sampleCpu)) {
      prevCpu = null;
      data.cpu = { status: "aguardando" };
      sampleCpu();
    }
    if (ensure("ram", want("ram"), cpuMs, sampleRam)) sampleRam();
    if (ensure("gpu", want("gpu"), cfg.refreshGpuSeconds * 1000, sampleGpu)) {
      data.gpu = { status: "aguardando" };
      gpuRetryAt = 0;
      sampleGpu();
    }
    if (ensure("cputemp", want("cputemp"), cfg.refreshGpuSeconds * 1000, sampleCpuTemp)) {
      data.cputemp = { status: "aguardando" };
      sampleCpuTemp();
    }

    const key = drives.join(",");
    const mudouDrives = key !== drivesKey;
    drivesKey = key;
    const ligouDisk = ensure("disk", want("disk"), cfg.refreshDiskSeconds * 1000, sampleDisks);
    if (want("disk") && (ligouDisk || mudouDrives)) sampleDisks();

    const gpuWin = gpuMode === "windows" && want("gpu");
    if (fake) {
      if (ensure("io", want("io") || gpuWin, cfg.refreshIoSeconds * 1000, sampleFakeIo)) {
        data.io = { status: "aguardando" };
        data.cpufreq = { status: "aguardando" };
        sampleFakeIo();
      }
    } else if (want("io") || gpuWin) {
      // intervalo mudou, ou a GPU entrou/saiu do coletor: religa
      if (col && (colIntervalSec !== cfg.refreshIoSeconds || colGpu !== gpuWin)) stopCollector();
      colIntervalSec = cfg.refreshIoSeconds;
      colGpu = gpuWin;
      startCollector();
    } else if (colWanted || col) {
      stopCollector();
      data.io = { status: "aguardando" };
      data.cpufreq = { status: "aguardando" };
    }
  }

  /**
   * `p`: { needs:{cpu,ram,gpu,cputemp,io,disk}, drives:["C"], refreshCpuSeconds,
   *        refreshGpuSeconds, refreshDiskSeconds, refreshIoSeconds, lhmUrl }
   */
  function configure(p = {}) {
    const num = (v, def, lo, hi) => (isNum(Number(v)) && v !== "" && v !== null ? clamp(Number(v), lo, hi) : def);
    if (p.refreshCpuSeconds !== undefined) cfg.refreshCpuSeconds = num(p.refreshCpuSeconds, DEFAULTS.refreshCpuSeconds, 1, 60);
    if (p.refreshGpuSeconds !== undefined) cfg.refreshGpuSeconds = num(p.refreshGpuSeconds, DEFAULTS.refreshGpuSeconds, 1, 60);
    if (p.refreshDiskSeconds !== undefined) cfg.refreshDiskSeconds = num(p.refreshDiskSeconds, DEFAULTS.refreshDiskSeconds, 10, 3600);
    if (p.refreshIoSeconds !== undefined) cfg.refreshIoSeconds = num(p.refreshIoSeconds, DEFAULTS.refreshIoSeconds, 1, 60);
    if (typeof p.lhmUrl === "string" && /^https?:\/\//i.test(p.lhmUrl.trim())) {
      cfg.lhmUrl = p.lhmUrl.trim().replace(/\/+$/, "");
    }
    if (Array.isArray(p.drives)) {
      drives = [...new Set(p.drives.map((d) => String(d).replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase()).filter(Boolean))];
    }
    if (p.needs) {
      for (const k of Object.keys(need)) {
        if (!(k in p.needs)) continue;
        const v = !!p.needs[k];
        if (need[k] && !v) needUntil[k] = Date.now() + GRACE_MS;
        need[k] = v;
      }
      if (!graceTimer && Object.keys(need).some((k) => !need[k] && Date.now() < (needUntil[k] || 0))) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          apply(); // a folga acabou: desliga o que ninguem mais usa
        }, GRACE_MS + 250);
      }
    }
    apply();
  }

  /** Forca uma leitura agora (toque no strip). O coletor segue o ritmo dele. */
  function refreshNow() {
    if (want("cpu")) sampleCpu();
    if (want("ram")) sampleRam();
    if (want("gpu")) sampleGpu();
    if (want("cputemp")) sampleCpuTemp();
    if (want("disk")) sampleDisks();
    if (fake && want("io")) sampleFakeIo();
  }

  function stop() {
    stopped = true;
    if (graceTimer) clearTimeout(graceTimer);
    for (const k of Object.keys(timers)) {
      if (timers[k] && timers[k].id) clearInterval(timers[k].id);
    }
    stopCollector();
  }

  process.on("exit", () => {
    // sincrono por definicao: so o kill. O coletor ainda confere o PID do pai a cada ciclo.
    if (col) {
      try {
        col.child.kill();
      } catch {}
    }
  });

  return {
    configure,
    snapshot,
    refreshNow,
    onUpdate,
    listDrives,
    stop,
    collectorPid: () => colPid,
    isFake: () => fake,
    config: () => ({ ...cfg, drives: drives.slice() }),
  };
}

// ================================================================ --probe

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Leitura REAL unica (somente leitura) de todas as fontes, em forma legivel. */
async function probe(argv) {
  const lhmArg = argv.find((a) => a.startsWith("--lhm="));
  const drivesArg = argv.find((a) => a.startsWith("--drives="));
  const drivesList = drivesArg ? drivesArg.slice(9).split(",") : ["C", "D", "E"];
  const src = createSources({
    fake: argv.includes("--fake"),
    log: (m) => process.stderr.write(`[probe] ${m}\n`),
  });
  src.configure({
    needs: { cpu: true, ram: true, gpu: true, cputemp: true, io: true, disk: true },
    drives: drivesList,
    refreshCpuSeconds: 1,
    refreshGpuSeconds: 1,
    refreshDiskSeconds: 10,
    refreshIoSeconds: 1,
    lhmUrl: lhmArg ? lhmArg.slice(6) : DEFAULTS.lhmUrl,
  });

  // espera ter o que medir: CPU precisa de 2 amostras, o coletor de ~1,5-3 s para subir
  const t0 = Date.now();
  let st;
  for (;;) {
    await sleep(500);
    st = src.snapshot();
    const pronto =
      st.cpu.status === "ok" &&
      st.io.status !== "aguardando" &&
      st.gpu.status !== "aguardando" &&
      st.cputemp.status !== "aguardando" &&
      drivesList.every((d) => st.disks[String(d).toUpperCase()]);
    if (pronto || Date.now() - t0 > 15000) break;
  }
  // uma segunda leitura do coletor deixa a taxa mais estavel que o primeiro ciclo
  if (st.io.status === "ok") {
    await sleep(1200);
    st = src.snapshot();
  }
  src.stop();

  const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
  const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
  const nd = (s, motivo) => (s && s.status === "ok" ? null : `n/d (${motivo || (s && s.status) || "sem dado"})`);

  const out = {
    maquina: { cpu: (os.cpus()[0] || {}).model || null, threads: os.cpus().length, so: `${os.type()} ${os.release()}` },
    cpu: nd(st.cpu) || { uso_pct: r1(st.cpu.pct), threads: st.cpu.threads, threads_acima_50pct: st.cpu.busy },
    cpu_freq: nd(st.cpufreq) || { mhz: Math.round(st.cpufreq.mhz), base_mhz: st.cpufreq.baseMHz },
    cpu_temp: nd(st.cputemp, st.cputemp.status === "sem-lhm" ? `LHM fora do ar em ${src.config().lhmUrl}` : null) || {
      graus_c: r1(st.cputemp.temp),
      sensor: st.cputemp.sensor,
    },
    ram: nd(st.ram) || {
      uso_pct: r1(st.ram.pct),
      usado_gb: r1(st.ram.usedGB),
      livre_gb: r1(st.ram.freeGB),
      total_gb: r1(st.ram.totalGB),
    },
    gpu:
      nd(st.gpu) ||
      {
        nome: st.gpu.name,
        uso_pct: st.gpu.util,
        temp_c: st.gpu.temp,
        vram_usada_mb: st.gpu.memUsedMB,
        vram_total_mb: st.gpu.memTotalMB,
        energia_w: r1(st.gpu.watts),
        limite_energia_w: r1(st.gpu.wattsLimit),
        ventoinha_pct: st.gpu.fan,
        clock_mhz: st.gpu.clockMHz,
        clock_max_mhz: st.gpu.clockMaxMHz,
        clock_vram_mhz: st.gpu.vramClockMHz,
      },
    discos_espaco: {},
    disco_io: nd(st.io, "coletor") || {},
    rede: nd(st.io, "coletor") || {},
  };

  for (const d of drivesList) {
    const L = String(d).toUpperCase();
    const x = st.disks[L];
    out.discos_espaco[`${L}:`] = !x
      ? "n/d (sem leitura)"
      : x.status !== "ok"
      ? `n/d (${x.status})`
      : { usado_pct: r1(x.pct), livre_gb: r1(x.freeGB), total_gb: r1(x.totalGB) };
  }

  if (st.io.status === "ok") {
    const MB = 1048576;
    for (const k of Object.keys(st.io.disk)) {
      const v = st.io.disk[k];
      out.disco_io[k === "total" ? "total" : `${k}:`] = {
        gravacao_MBps: r2(v.w / MB),
        leitura_MBps: r2(v.r / MB),
      };
    }
    out.rede = {
      download_Mbps: r2((st.io.netDown * 8) / 1e6),
      upload_Mbps: r2((st.io.netUp * 8) / 1e6),
      interfaces: st.io.ifaces.map((i) => ({
        nome: i.name,
        contada: i.counted,
        down_Mbps: r2((i.rx * 8) / 1e6),
        up_Mbps: r2((i.tx * 8) / 1e6),
      })),
    };
  }

  console.log(JSON.stringify(out, null, 2));
}

module.exports = {
  createSources,
  parseGpuLine,
  findCpuTemp,
  findGpuSensors,
  summarizeGpu,
  parseCollectorLine,
  summarizeIo,
  collectorScript,
  DEFAULTS,
  HIST_SIZE,
  CAMPOS_GPU,
};

if (require.main === module) {
  if (process.argv.includes("--probe")) {
    probe(process.argv.slice(2)).then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      }
    );
  } else {
    console.log("uso: node sources.js --probe [--drives=C,D,E] [--lhm=http://127.0.0.1:8085] [--fake]");
  }
}
