"use strict";
/**
 * Renderizador compartilhado dos plugins desta pasta (claude-usage e sysmonitor).
 *
 * ESTE E O ARQUIVO CANONICO. Os plugins usam uma COPIA em `bin/render.js`, porque o
 * Stream Deck instala cada `*.sdPlugin` como uma pasta isolada e nao ha como referenciar
 * um arquivo de fora dela. Ao mexer aqui, copie para os dois:
 *
 *   cp assets/lib/render.js plugins/claude-usage/digital.astronauta.claudeusage.sdPlugin/bin/render.js
 *   cp assets/lib/render.js plugins/sysmonitor/digital.astronauta.sysmonitor.sdPlugin/bin/render.js
 *
 * Tudo aqui devolve SVG string de 144x144 (tamanho da tecla). Zero dependencias.
 */

const K = 144; // lado da tecla

const COLORS = {
  safe: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  critical: "#ff2d55",
  offline: "#8b949e",
  bg: "#18181b",
  text: "#f0f6fc",
  track: "#2f3136",
};

/** level -> cor de traço. */
function colorForLevel(level) {
  return COLORS[level] || COLORS.safe;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
}

function svg(inner, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${K}" height="${K}" viewBox="0 0 ${K} ${K}">
  <rect width="${K}" height="${K}" fill="${bg || COLORS.bg}"/>
  ${inner}
</svg>`;
}

function txt(x, y, s, { size = 16, fill = COLORS.text, weight = "normal", anchor = "middle" } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial,Helvetica,sans-serif"
        font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(s)}</text>`;
}

/** Fonte que encolhe conforme o texto cresce, pro numero nunca vazar da tecla. */
function fitSize(text, big = 38) {
  const n = String(text).length;
  if (n <= 3) return big;
  if (n === 4) return big - 6;
  if (n === 5) return big - 12;
  if (n === 6) return big - 17;
  return big - 21;
}

// ---------------------------------------------------------------- historico

/**
 * Converte amostras (0..100) em pontos dentro de uma caixa.
 * Amostras `null` (sem leitura ainda) sao ignoradas, entao o grafico desenha bem
 * com o buffer pela metade — que e o estado logo depois que o plugin sobe.
 */
function pointsFor(hist, x0, y0, w, h) {
  const vals = (hist || []).filter((v) => typeof v === "number");
  if (vals.length < 2) return [];
  const step = w / (vals.length - 1);
  return vals.map((v, i) => [x0 + i * step, y0 + h - (Math.max(0, Math.min(100, v)) / 100) * h]);
}

function polyline(pts, color, width, opacity) {
  if (pts.length < 2) return "";
  const d = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="${width}"
        stroke-linejoin="round" stroke-linecap="round" opacity="${opacity ?? 1}"/>`;
}

function areaPath(pts, x0, y0, w, h, color, opacity) {
  if (pts.length < 2) return "";
  const d = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
  return `<path d="M ${x0},${y0 + h} L ${d} L ${x0 + w},${y0 + h} Z" fill="${color}" opacity="${opacity ?? 0.25}"/>`;
}

function barsFor(hist, x0, y0, w, h, color, opacity) {
  const vals = (hist || []).filter((v) => typeof v === "number");
  if (!vals.length) return "";
  const bw = Math.max(1.5, w / vals.length - 1);
  return vals
    .map((v, i) => {
      const bh = Math.max(1, (Math.max(0, Math.min(100, v)) / 100) * h);
      const x = x0 + (i * w) / vals.length;
      return `<rect x="${x.toFixed(1)}" y="${(y0 + h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="${opacity ?? 0.9}" rx="0.5"/>`;
    })
    .join("");
}

/**
 * Camada de historico desenhada ATRAS do conteudo principal.
 * Estilos espelham as referencias: off | sparkline | minibars | area | line | bargraph | background
 */
function historyLayer(hist, style, color) {
  if (!style || style === "off") return "";
  const vals = (hist || []).filter((v) => typeof v === "number");
  if (vals.length < 2) return "";

  switch (style) {
    case "sparkline": {
      const box = [26, 96, 92, 22];
      return polyline(pointsFor(hist, ...box), "#ffffff", 2, 0.85);
    }
    case "minibars": {
      const box = [26, 96, 92, 22];
      return barsFor(hist, ...box, "#ffffff", 0.75);
    }
    case "area": {
      const box = [22, 70, 100, 50];
      return areaPath(pointsFor(hist, ...box), ...box, color, 0.3);
    }
    case "line": {
      const box = [10, 74, 124, 54];
      return areaPath(pointsFor(hist, ...box), ...box, color, 0.22) + polyline(pointsFor(hist, ...box), color, 2.5);
    }
    case "bargraph": {
      const box = [10, 74, 124, 54];
      return barsFor(hist, ...box, color, 0.9);
    }
    case "background": {
      const box = [0, 24, K, K - 24];
      return areaPath(pointsFor(hist, ...box), ...box, color, 0.35);
    }
    default:
      return "";
  }
}

/** Estilos que substituem o anel por um grafico grande. */
const GRAPH_STYLES = new Set(["line", "bargraph", "background"]);

// ---------------------------------------------------------------- modos

/** Anel + numero grande. Para metricas percentuais. */
function ring({ label, value, sub, level, pct, hist, histStyle, accent }) {
  const color = level === "safe" && accent ? accent : colorForLevel(level);
  const R = 52;
  const CIRC = 2 * Math.PI * R;
  const dash = pct === null || pct === undefined ? 0 : CIRC * (Math.max(0, Math.min(100, pct)) / 100);

  // Nos estilos de grafico grande, o anel sai de cena e o numero sobe.
  if (GRAPH_STYLES.has(histStyle)) {
    return svg(
      historyLayer(hist, histStyle, color) +
        txt(K / 2, 52, value, { size: fitSize(value, 40), weight: "bold", fill: color }) +
        txt(K / 2, 72, label, { size: Math.min(15, 130 / Math.max(1,String(sub).length) * 1.6), fill: COLORS.offline }) +
        (sub ? txt(K / 2, K - 8, sub, { size: 14, fill: COLORS.offline }) : "")
    );
  }

  return svg(
    historyLayer(hist, histStyle, color) +
      `<g transform="rotate(-90 72 72)">
    <circle cx="72" cy="72" r="${R}" fill="none" stroke="${COLORS.track}" stroke-width="12"/>
    <circle cx="72" cy="72" r="${R}" fill="none" stroke="${color}" stroke-width="12"
            stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${CIRC.toFixed(1)}"/>
  </g>` +
      txt(K / 2, 26, label, { size: 17, fill: COLORS.offline }) +
      txt(K / 2, 82, value, { size: fitSize(value), weight: "bold" }) +
      (sub ? txt(K / 2, 108, sub, { size: Math.min(15, 130 / Math.max(1,String(sub).length) * 1.6), fill: COLORS.offline }) : "")
  );
}

/** Numero grande + barra horizontal. */
function bar({ label, value, sub, level, pct, hist, histStyle, accent }) {
  const color = level === "safe" && accent ? accent : colorForLevel(level);
  const w = 108;
  const filled = pct === null || pct === undefined ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * w;

  return svg(
    historyLayer(hist, histStyle, color) +
      txt(K / 2, 30, label, { size: 17, fill: COLORS.offline }) +
      txt(K / 2, 78, value, { size: fitSize(value), weight: "bold" }) +
      `<rect x="18" y="92" width="${w}" height="12" rx="6" fill="${COLORS.track}"/>` +
      (filled > 0 ? `<rect x="18" y="92" width="${filled.toFixed(1)}" height="12" rx="6" fill="${color}"/>` : "") +
      (sub ? txt(K / 2, 124, sub, { size: Math.min(15, 130 / Math.max(1,String(sub).length) * 1.6), fill: COLORS.offline }) : "")
  );
}

/** Duas linhas empilhadas, cada uma com percentual, sigla, reset e barra. */
function dual({ rows }) {
  const w = 92;
  const out = (rows || []).slice(0, 2).map((r, i) => {
    const y = i === 0 ? 8 : 76;
    const color = colorForLevel(r.level);
    const filled = r.pct === null || r.pct === undefined ? 0 : (Math.max(0, Math.min(100, r.pct)) / 100) * w;
    return (
      txt(6, y + 34, r.value, { size: fitSize(r.value, 34), weight: "bold", anchor: "start" }) +
      txt(K - 6, y + 22, r.label, { size: 19, weight: "bold", fill: color, anchor: "end" }) +
      (r.sub ? txt(K - 6, y + 44, r.sub, { size: 16, fill: COLORS.offline, anchor: "end" }) : "") +
      `<rect x="6" y="${y + 48}" width="${w + 40}" height="9" rx="4.5" fill="${COLORS.track}"/>` +
      (filled > 0
        ? `<rect x="6" y="${y + 48}" width="${(filled * ((w + 40) / w)).toFixed(1)}" height="9" rx="4.5" fill="${color}"/>`
        : "")
    );
  });
  return svg(out.join(""));
}

/** Numero/texto + rotulo. Para metricas sem percentual (custo, horario, veredito). */
function plain({ label, value, sub, level, hist, histStyle, accent }) {
  const color = level === "safe" && accent ? accent : colorForLevel(level);
  return svg(
    historyLayer(hist, histStyle, color) +
      txt(K / 2, 34, label, { size: Math.min(18, 130 / Math.max(1,String(label).length) * 1.6), fill: COLORS.offline }) +
      txt(K / 2, 88, value, { size: fitSize(value, 40), weight: "bold", fill: color }) +
      (sub ? txt(K / 2, 118, sub, { size: Math.min(15, 130 / Math.max(1,String(sub).length) * 1.6), fill: COLORS.offline }) : "")
  );
}

/** Tecla apagada — usada pelo flicker no estado critico. */
function blank(level) {
  return svg(txt(K / 2, K / 2 + 6, "", {}), level === "critical" ? "#2a0a12" : COLORS.bg);
}

/** Legibility-first: fixed non-overlapping zones, one number per surface. */
function clean(view, dial = false) {
  const {label = '', value = '--', sub = '', level, accent, pct} = view;
  const color = level === 'safe' ? accent || '#ef985d' : colorForLevel(level);
  const width = dial ? 200 : 144;
  const height = dial ? 100 : 144;
  const font = (text, max, available) => Math.min(max, available / Math.max(1,String(text).length) * 1.65);
  const heading = label.replace(' /H','').replace(' ROI','').replace(' · TOKENS',' TOTAL');
  const detail = sub.replace('tokens/h · 2h','tokens / hora').replace('API / gasto','retorno mensal').replace('sem extras inform.','retorno parcial');
  let content = `<rect width="${width}" height="${height}" fill="#10151c"/>`;
  if (dial) {
    content += txt(12,22,heading,{anchor:'start',size:font(heading,16,176),fill:color,weight:'bold'});
    content += txt(12,62,value,{anchor:'start',size:font(value,34,176),weight:'bold'});
    content += txt(12,86,detail,{anchor:'start',size:font(detail,13,176),fill:'#acb8c8'});
  } else {
    content += `<rect x="12" y="8" width="120" height="4" rx="2" fill="${color}"/>`;
    content += txt(72,34,heading,{size:font(heading,16,122),fill:color,weight:'bold'});
    content += txt(72,88,value,{size:font(value,44,122),weight:'bold'});
    content += txt(72,113,detail,{size:font(detail,14,122),fill:'#acb8c8'});
  }
  if (typeof pct === 'number') {
    const y=dial?96:130;
    content += `<rect x="12" y="${y}" width="${width-24}" height="4" rx="2" fill="#303a47"/><rect x="12" y="${y}" width="${(width-24)*Math.max(0,Math.min(100,pct))/100}" height="4" rx="2" fill="${color}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`;
}

/** Ponto unico de entrada: escolhe o desenho pelo `mode`. */
function draw(mode, view) {
  switch (mode) {
    case "dual":
      return dual(view);
    case "bar":
      return bar(view);
    case "plain":
      return plain(view);
    case "ring":
    default:
      return ring(view);
  }
}

/** SVG -> data URI aceito pelo setImage do Stream Deck. */
function toDataUri(svgString) {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svgString)}`;
}

module.exports = {
  clean,
  COLORS,
  colorForLevel,
  escapeXml,
  draw,
  ring,
  bar,
  dual,
  plain,
  blank,
  toDataUri,
  historyLayer,
  GRAPH_STYLES,
};
