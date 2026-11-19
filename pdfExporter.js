/* =============================================================================
 * pdfExporter.js — Informe para decidir (PDF) + definición de gráficos compartida con el dashboard
 * -----------------------------------------------------------------------------
 * El PDF NO es un documento estadístico: responde a cuatro preguntas de gestión
 *   · ¿En qué enfocarse?            · ¿Qué resolver con urgencia?
 *   · ¿Qué monitorear?              · ¿Qué medidas preventivas o estratégicas conviene tomar?
 * Cada alerta lleva su gráfico (el que eligió la IA y construyó el código con datos reales), hay un mapa de atención por
 * grupo y un plan de acción. No incluye tablas técnicas ni trazabilidad de agentes.
 * Entrada: el objeto `report` de insights.assembleReport(). Requiere (globales vía CDN): window.jspdf.jsPDF y window.Chart.
 * ========================================================================== */

const PRIORITY_COLORS = { urgent: [185, 28, 28], important: [234, 88, 12], watch: [2, 132, 199] };
const RISK_COLORS = { low: [22, 163, 74], moderate: [202, 138, 4], high: [234, 88, 12], critical: [185, 28, 28] };
const HORIZON_TEXT = { inmediato: 'Inmediato', corto_plazo: 'Corto plazo', mediano_plazo: 'Mediano plazo' };
const MODE_TEXT = { ia: 'Análisis con inteligencia artificial (Gemini)', reglas: 'Análisis con reglas automáticas (sin IA)', mixto: 'Análisis con inteligencia artificial y reglas de respaldo' };
// Color de fondo del mapa de atención según el nivel (3 muy desfavorable … -2 muy favorable)
const HEAT_FILL = { 3: [248, 150, 150], 2: [252, 190, 190], 1: [253, 224, 160], 0: null, '-1': [187, 247, 208], '-2': [134, 239, 172] };

const INK = [30, 41, 59], MUTED = [100, 116, 139], BRAND = [37, 99, 235], BORDER = [226, 232, 240], SOFT = [241, 245, 249], WHITE = [255, 255, 255];

/* ---------------------------------------------------------------------------
 * Gráficos compartidos (dashboard + PDF)
 * ------------------------------------------------------------------------ */
export const LIGHT_THEME = { text: '#1e293b', muted: '#64748b', grid: '#e2e8f0', bg: '#ffffff' };
const fmtN = (v, d = 2) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: d }).format(v);

const refLinePlugin = {
  id: 'refLine',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || opts.value === undefined) return;
    const horizontal = chart.options.indexAxis === 'y';
    const scale = horizontal ? chart.scales.x : chart.scales.y;
    if (!scale) return;
    const pos = scale.getPixelForValue(opts.value);
    const a = chart.chartArea, ctx = chart.ctx;
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = opts.color || '#64748b';
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(pos, a.top); ctx.lineTo(pos, a.bottom); } else { ctx.moveTo(a.left, pos); ctx.lineTo(a.right, pos); }
    ctx.stroke();
    ctx.restore();
  },
};
const valueLabelPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.enabled) return;
    const ctx = chart.ctx, horizontal = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.fillStyle = opts.color || '#1e293b'; ctx.font = '600 11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    chart.data.datasets.forEach((ds, di) => {
      chart.getDatasetMeta(di).data.forEach((el, i) => {
        const v = ds.data[i];
        if (v === null || v === undefined) return;
        const t = `${fmtN(v, opts.suffix === '%' ? 1 : 2)}${opts.suffix || ''}`;
        if (horizontal) { ctx.textAlign = 'left'; ctx.fillText(t, el.x + 6, el.y); } else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(t, el.x, el.y - 4); }
      });
    });
    ctx.restore();
  },
};
const whiteBgPlugin = {
  id: 'whiteBg',
  beforeDraw(chart, _args, opts) {
    if (!opts || !opts.color) return;
    const { ctx, width, height } = chart;
    ctx.save(); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = opts.color; ctx.fillRect(0, 0, width, height); ctx.restore();
  },
};
// Cuadrante: líneas con el promedio general (x e y)
const quadLinesPlugin = {
  id: 'quadLines',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || opts.xRef === undefined) return;
    const a = chart.chartArea, ctx = chart.ctx;
    const x = chart.scales.x.getPixelForValue(opts.xRef), y = chart.scales.y.getPixelForValue(opts.yRef);
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = opts.color || '#64748b';
    ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = opts.color || '#64748b'; ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left'; ctx.fillText('promedio general', Math.min(a.right - 82, Math.max(a.left + 2, x + 4)), a.top + 11);
    ctx.restore();
  },
};
// Cuadrante: nombre del grupo junto a cada punto
const pointLabelPlugin = {
  id: 'pointLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.labels) return;
    const meta = chart.getDatasetMeta(0), ctx = chart.ctx, a = chart.chartArea;
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif'; ctx.fillStyle = opts.color || '#1e293b'; ctx.textBaseline = 'middle';
    meta.data.forEach((el, i) => {
      const t = opts.labels[i];
      if (!t) return;
      const right = el.x < a.right - 95;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(t, el.x + (right ? 11 : -11), el.y);
    });
    ctx.restore();
  },
};

/** Configuración Chart.js para una especificación de gráfico (bar | line | stackedhbar | groupedhbar | quadrant | doughnut). */
export function chartConfig(spec, theme = LIGHT_THEME, { forExport = false } = {}) {
  const suffix = spec.suffix || '';
  const axis = (extra = {}) => ({
    grid: { color: theme.grid }, border: { color: theme.grid }, ...extra,
    ticks: { color: theme.muted, font: { size: 11 }, ...(extra.ticks || {}) },
  });
  const legendOn = ['doughnut', 'stackedhbar', 'groupedhbar'].includes(spec.type);
  const base = {
    responsive: !forExport, maintainAspectRatio: false, animation: forExport ? false : { duration: 300 },
    devicePixelRatio: forExport ? 2 : undefined,
    layout: { padding: { top: 8, right: 10, bottom: 4, left: 4 } },
    plugins: {
      legend: { display: legendOn, position: 'bottom', labels: { color: theme.text, boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: (c) => ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${fmtN(c.parsed.y ?? c.parsed.x ?? c.parsed)}${suffix}` } },
      whiteBg: forExport ? { color: theme.bg } : {},
      refLine: spec.reference ? { value: spec.reference.value, color: theme.muted } : {},
      valueLabels: { enabled: spec.type === 'bar' || spec.type === 'groupedhbar', suffix, color: theme.text },
      quadLines: {}, pointLabels: {},
    },
  };
  if (spec.type === 'doughnut') {
    return {
      type: 'doughnut',
      data: { labels: spec.labels, datasets: [{ data: spec.datasets[0].data, backgroundColor: spec.datasets[0].colors, borderColor: theme.bg, borderWidth: 2 }] },
      options: { ...base, cutout: '58%', plugins: { ...base.plugins, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtN(c.parsed, 1)}%` } } } },
      plugins: [whiteBgPlugin],
    };
  }
  if (spec.type === 'line') {
    return {
      type: 'line',
      data: { labels: spec.labels, datasets: spec.datasets.map((d) => ({ label: d.label, data: d.data, borderColor: d.color, backgroundColor: `${d.color}22`, fill: true, tension: 0.25, pointRadius: 3, borderWidth: 2 })) },
      options: { ...base, plugins: { ...base.plugins, legend: { display: false } }, scales: { x: axis(), y: axis({ beginAtZero: false, ticks: { callback: (v) => `${fmtN(v, suffix === '%' ? 1 : Math.abs(v) < 10 ? 2 : 1)}${suffix}` } }) } },
      plugins: [whiteBgPlugin],
    };
  }
  if (spec.type === 'stackedhbar') {
    return {
      type: 'bar',
      data: { labels: spec.labels, datasets: spec.datasets.map((d) => ({ label: d.label, data: d.data, backgroundColor: d.color, borderWidth: 0 })) },
      options: { ...base, indexAxis: 'y', scales: { x: axis({ stacked: true, ticks: { callback: (v) => `${v}${suffix}` } }), y: axis({ stacked: true }) } },
      plugins: [whiteBgPlugin],
    };
  }
  if (spec.type === 'groupedhbar') {
    return {
      type: 'bar',
      data: { labels: spec.labels, datasets: spec.datasets.map((d) => ({ label: d.label, data: d.data, backgroundColor: d.color, borderRadius: 3, maxBarThickness: 18 })) },
      options: { ...base, indexAxis: 'y', layout: { padding: { top: 8, right: 44, bottom: 4, left: 4 } }, scales: { x: axis({ beginAtZero: true, ticks: { callback: (v) => `${v}${suffix}` } }), y: axis() } },
      plugins: [whiteBgPlugin, valueLabelPlugin],
    };
  }
  if (spec.type === 'quadrant') {
    const pts = spec.points;
    return {
      type: 'scatter',
      data: { datasets: [{
        data: pts.map((p) => ({ x: p.x, y: p.y })), pointBackgroundColor: pts.map((p) => p.color), pointBorderColor: pts.map((p) => (p.highlight ? theme.text : 'transparent')),
        pointBorderWidth: 2, pointRadius: pts.map((p) => (p.highlight ? 9 : 7)), pointHoverRadius: 10,
      }] },
      options: {
        ...base, layout: { padding: { top: 10, right: 12, bottom: 4, left: 4 } },
        plugins: {
          ...base.plugins, legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${pts[c.dataIndex].label}: ${pts[c.dataIndex].xDisplay || fmtN(c.parsed.x)}; ${fmtN(c.parsed.y, 0)}% de comentarios negativos` } },
          quadLines: { xRef: spec.xRef, yRef: spec.yRef, color: theme.muted }, pointLabels: { labels: pts.map((p) => p.label), color: theme.text },
        },
        scales: {
          x: axis({ reverse: Boolean(spec.reverseX), title: { display: true, text: spec.xTitle, color: theme.muted, font: { size: 11 } }, ticks: { callback: (v) => `${fmtN(v, 1)}${spec.xSuffix || ''}` } }),
          y: axis({ beginAtZero: true, title: { display: true, text: spec.yTitle, color: theme.muted, font: { size: 11 } }, ticks: { callback: (v) => `${v}${spec.ySuffix || ''}` } }),
        },
      },
      plugins: [whiteBgPlugin, quadLinesPlugin, pointLabelPlugin],
    };
  }
  // bar (comparación entre grupos): colores por barra; horizontal si hay muchos grupos o nombres largos
  const horizontal = spec.labels.length > 5 || spec.labels.some((l) => String(l).length > 14);
  return {
    type: 'bar',
    data: { labels: spec.labels, datasets: spec.datasets.map((d) => ({ label: d.label, data: d.data, backgroundColor: d.colors || d.color, borderRadius: 4, maxBarThickness: 34 })) },
    options: {
      ...base, indexAxis: horizontal ? 'y' : 'x', layout: { padding: horizontal ? { top: 8, right: 48, bottom: 4, left: 4 } : { top: 20, right: 10, bottom: 4, left: 4 } },
      plugins: { ...base.plugins, legend: { display: false } }, scales: { x: axis(), y: axis({ beginAtZero: true }) },
    },
    plugins: [whiteBgPlugin, refLinePlugin, valueLabelPlugin],
  };
}

/** Renderiza un gráfico fuera de pantalla (tema claro) y devuelve su imagen JPEG. */
export async function chartToImage(spec, width = 900, height = 600) {
  const Chart = window.Chart;
  if (!Chart) throw new Error('Chart.js no está cargado.');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.appendChild(canvas);
  let chart;
  try {
    chart = new Chart(canvas, chartConfig(spec, LIGHT_THEME, { forExport: true }));
    chart.resize(width / 2, height / 2);
    chart.update('none');
    // JPEG (fondo blanco ya pintado por el plugin): jsPDF lo incrusta sin recomprimir => exportación mucho más rápida que con PNG
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), width: canvas.width, height: canvas.height };
  } finally {
    if (chart) chart.destroy();
    canvas.remove();
  }
}

/* ---------------------------------------------------------------------------
 * Utilidades de texto para jsPDF (fuentes estándar: Latin-1/WinAnsi)
 * ------------------------------------------------------------------------ */
function pdfSafe(s) {
  return String(s ?? '')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—−]/g, '-')
    .replace(/…/g, '...').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->').replace(/↔/g, '<->')
    .replace(/≈/g, '~').replace(/•/g, '-').replace(/ /g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}☀-➿]/gu, '')
    .replace(/[^\x09\x0A\x20-\x7E¡-ÿ]/g, '');
}

/* ---------------------------------------------------------------------------
 * Motor de maquetación sencillo con saltos de página automáticos
 * ------------------------------------------------------------------------ */
class Layout {
  constructor(doc) {
    this.doc = doc;
    this.W = 210; this.H = 297; this.M = 16; this.B = 18; // márgenes (mm); B = margen inferior (pie)
    this.cw = this.W - 2 * this.M;
    this.y = this.M;
  }
  get bottom() { return this.H - this.B; }
  newPage() { this.doc.addPage(); this.y = this.M; }
  ensure(h) { if (this.y + h > this.bottom) this.newPage(); }
  setFont(size, bold = false, color = INK, italic = false) {
    this.doc.setFont('helvetica', bold ? (italic ? 'bolditalic' : 'bold') : (italic ? 'italic' : 'normal'));
    this.doc.setFontSize(size); this.doc.setTextColor(...color);
  }
  lineH(size) { return size * 0.46; }
  lines(text, width, size, bold = false) {
    this.setFont(size, bold);
    return this.doc.splitTextToSize(pdfSafe(text), width);
  }
  /** Párrafo con saltos de página. */
  paragraph(text, { size = 10, bold = false, color = INK, indent = 0, gap = 2, width = null, italic = false } = {}) {
    const w = (width ?? this.cw) - indent;
    this.setFont(size, bold, color, italic);
    const ls = this.doc.splitTextToSize(pdfSafe(text), w);
    const lh = this.lineH(size);
    for (const l of ls) {
      this.ensure(lh);
      this.setFont(size, bold, color, italic);
      this.doc.text(l, this.M + indent, this.y + lh * 0.8);
      this.y += lh;
    }
    this.y += gap;
  }
  bullets(items, { size = 10, indent = 4, gap = 1.2 } = {}) {
    for (const it of items) {
      const lh = this.lineH(size);
      const ls = this.lines(it, this.cw - indent - 3, size);
      this.ensure(lh * Math.min(ls.length, 2));
      this.doc.setFillColor(...BRAND);
      this.doc.circle(this.M + 1.5, this.y + lh * 0.55, 0.7, 'F');
      for (const l of ls) {
        this.ensure(lh);
        this.setFont(size, false);
        this.doc.text(l, this.M + indent, this.y + lh * 0.8);
        this.y += lh;
      }
      this.y += gap;
    }
    this.y += 1;
  }
  heading(text, level = 1, color = null) {
    const size = level === 1 ? 14 : 11.5;
    this.ensure(16);
    this.y += level === 1 ? 4 : 2;
    this.setFont(size, true, color || (level === 1 ? BRAND : INK));
    this.doc.text(pdfSafe(text), this.M, this.y + this.lineH(size) * 0.8);
    this.y += this.lineH(size) + 1;
    if (level === 1) {
      this.doc.setDrawColor(...BORDER); this.doc.setLineWidth(0.4);
      this.doc.line(this.M, this.y, this.W - this.M, this.y);
      this.y += 3;
    }
  }
  box(h, fill = SOFT, stroke = BORDER) {
    this.doc.setFillColor(...fill); this.doc.setDrawColor(...stroke); this.doc.setLineWidth(0.3);
    this.doc.roundedRect(this.M, this.y, this.cw, h, 1.5, 1.5, 'FD');
  }
  /** Cuadro de texto con fondo (aviso, titular). */
  callout(text, { size = 9.5, bold = false, fill = SOFT, stroke = BORDER, color = INK, title = null } = {}) {
    const lh = this.lineH(size);
    const tl = title ? this.lines(title, this.cw - 8, size, true) : [];
    const ls = this.lines(text, this.cw - 8, size, bold);
    const h = (tl.length + ls.length) * lh + 6 + (tl.length ? 1 : 0);
    this.ensure(h + 2);
    this.box(h, fill, stroke);
    let y = this.y + 3.2;
    tl.forEach((l) => { this.setFont(size, true, color); this.doc.text(l, this.M + 4, y + lh * 0.8); y += lh; });
    if (tl.length) y += 1;
    ls.forEach((l) => { this.setFont(size, bold, color); this.doc.text(l, this.M + 4, y + lh * 0.8); y += lh; });
    this.y += h + 3;
  }
  /** Tabla con encabezado repetido y celdas con salto de línea. */
  table(headers, rows, widths, { size = 8.5, headFill = BRAND } = {}) {
    const total = widths.reduce((a, b) => a + b, 0);
    const ws = widths.map((w) => (w / total) * this.cw);
    const lh = this.lineH(size);
    const headLines = headers.map((h, i) => this.lines(String(h), ws[i] - 3, size, true));
    const hh = Math.max(...headLines.map((l) => l.length)) * lh + 3;
    const drawHeader = () => {
      this.ensure(hh + lh * 2);
      this.doc.setFillColor(...headFill); this.doc.rect(this.M, this.y, this.cw, hh, 'F');
      let x = this.M;
      headLines.forEach((ls, i) => {
        this.setFont(size, true, WHITE);
        ls.forEach((l, k) => this.doc.text(l, x + 1.5, this.y + 1.5 + lh * (k + 0.8)));
        x += ws[i];
      });
      this.y += hh;
    };
    drawHeader();
    rows.forEach((r, ri) => {
      const cellLines = r.map((c, i) => this.lines(String(c ?? ''), ws[i] - 3, size));
      const h = Math.max(...cellLines.map((l) => l.length)) * lh + 2.4;
      if (this.y + h > this.bottom) { this.newPage(); drawHeader(); }
      if (ri % 2 === 0) { this.doc.setFillColor(...SOFT); this.doc.rect(this.M, this.y, this.cw, h, 'F'); }
      let x = this.M;
      cellLines.forEach((ls, i) => {
        this.setFont(size, false);
        ls.forEach((l, k) => this.doc.text(l, x + 1.5, this.y + 1.2 + lh * (k + 0.8)));
        x += ws[i];
      });
      this.y += h;
    });
    this.doc.setDrawColor(...BORDER); this.doc.line(this.M, this.y, this.W - this.M, this.y);
    this.y += 3;
  }
}

/* ---------------------------------------------------------------------------
 * Secciones del informe
 * ------------------------------------------------------------------------ */
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' }); } catch (_) { return String(iso); }
}
const fmtInt = (n) => new Intl.NumberFormat('es-CO').format(n);

function drawCover(L, report) {
  const { doc } = L;
  const m = report.meta;
  doc.setFillColor(...BRAND); doc.rect(0, 0, L.W, 46, 'F');
  L.setFont(8.5, true, [191, 219, 254]); doc.text('INFORME PARA DECIDIR · TALENTO HUMANO', L.M, 14);
  L.setFont(19, true, WHITE);
  const tl = doc.splitTextToSize(pdfSafe(m.title || 'Informe ejecutivo de Talento Humano'), L.cw);
  doc.text(tl.slice(0, 2), L.M, 24);
  if (m.subtitle) { L.setFont(10.5, false, [219, 234, 254]); doc.text(doc.splitTextToSize(pdfSafe(m.subtitle), L.cw).slice(0, 2), L.M, 24 + tl.slice(0, 2).length * 7.5); }
  L.y = 52;
  L.paragraph(`Archivo: ${m.file_name}  ·  ${fmtInt(m.rows)} registros  ·  Generado el ${fmtDate(m.generated_at)}`, { size: 8.5, color: MUTED, gap: 0.8 });
  const a = m.availability;
  const used = [a.has_quantitative ? 'indicadores numéricos' : null, a.has_qualitative ? 'comentarios de las personas' : null].filter(Boolean).join(' y ');
  L.paragraph(`Se analizaron: ${used || 'datos del archivo'}  ·  ${MODE_TEXT[m.mode] || ''}`, { size: 8.5, color: MUTED, gap: 2.5 });
  // Situación general
  const col = RISK_COLORS[m.overall_risk] || MUTED;
  const label = `Situación general: ${m.risk_label || ''}`;
  L.setFont(9.5, true, WHITE);
  const w = doc.getTextWidth(pdfSafe(label)) + 8;
  doc.setFillColor(...col); doc.roundedRect(L.M, L.y, w, 7, 3.5, 3.5, 'F');
  doc.text(pdfSafe(label), L.M + 4, L.y + 4.8);
  L.y += 11;
}

function drawSummary(L, report) {
  const s = report.summary;
  L.heading('Lo que revelan los datos');
  L.paragraph(s.lead, { size: 10, bold: true, gap: 2.5 });
  if (s.headline) L.callout(s.headline, { size: 10, bold: true, fill: [239, 246, 255], stroke: [191, 219, 254], color: BRAND });
  (s.paragraphs || []).forEach((p) => L.paragraph(p, { size: 10, gap: 2.5 }));
  if (s.key_messages?.length) { L.heading('Mensajes clave', 2); L.bullets(s.key_messages); }
}

function drawFocus(L, report) {
  if (!report.focus.length) return;
  L.ensure(45);
  L.heading('En qué enfocarse');
  report.focus.forEach((f, i) => {
    const tl = L.lines(f.title, L.cw - 16, 10.5, true), wl = L.lines(f.why || '', L.cw - 16, 9);
    const h = tl.length * L.lineH(10.5) + wl.length * L.lineH(9) + 6;
    L.ensure(h + 2);
    L.box(h);
    L.doc.setFillColor(...BRAND); L.doc.circle(L.M + 6, L.y + h / 2, 3.4, 'F');
    L.setFont(10, true, WHITE); L.doc.text(String(i + 1), L.M + 6, L.y + h / 2 + 1.3, { align: 'center' });
    let y = L.y + 3;
    tl.forEach((l) => { L.setFont(10.5, true, INK); L.doc.text(l, L.M + 13, y + L.lineH(10.5) * 0.8); y += L.lineH(10.5); });
    wl.forEach((l) => { L.setFont(9, false, INK); L.doc.text(l, L.M + 13, y + L.lineH(9) * 0.8); y += L.lineH(9); });
    L.y += h + 3;
  });
}

function drawLegend(L, legend, x, y, maxW) {
  if (!legend?.length) return 0;
  let cx = x, cy = y;
  const rowH = 4;
  legend.forEach((it) => {
    L.setFont(7, false, MUTED);
    const tw = L.doc.getTextWidth(pdfSafe(it.label)) + 7;
    if (cx + tw > x + maxW && cx > x) { cx = x; cy += rowH; }
    const hex = it.color.replace('#', '');
    L.doc.setFillColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
    L.doc.rect(cx, cy - 2.1, 2.6, 2.6, 'F');
    L.doc.text(pdfSafe(it.label), cx + 3.6, cy);
    cx += tw + 2;
  });
  return cy - y + rowH;
}

async function drawAlerts(L, report) {
  if (!report.alerts.length) {
    L.heading('Alertas');
    L.callout('No se encontraron señales de atención relevantes con los datos disponibles. Conviene repetir el análisis periódicamente para detectar cambios a tiempo.', { fill: [236, 253, 245], stroke: [167, 243, 208] });
    return;
  }
  L.ensure(105);   // el título no debe quedar solo al final de una página: se mueve junto con la primera alerta
  L.heading('Alertas: qué atender y por qué');
  if (report.intros.alerts) L.paragraph(report.intros.alerts, { size: 9.5, color: MUTED, gap: 3 });
  const textW = 80, gapX = 5;
  for (const a of report.alerts) {
    const color = PRIORITY_COLORS[a.priority] || MUTED;
    let img = null;
    if (a.chart) { try { img = await chartToImage(a.chart, 900, 600); } catch (e) { console.warn('Gráfico omitido en PDF:', a.id, e); } }
    const hasChart = Boolean(img);
    const tw = hasChart ? textW : L.cw - 10;
    const lh9 = L.lineH(9), lh75 = L.lineH(7.5), lh105 = L.lineH(10.5);
    const head = L.lines(`${a.priorityLabel.toUpperCase()}  ·  ${a.kindLabel}${a.group ? '  ·  ' + a.group : ''}`, tw, 7.5, true);
    const title = L.lines(a.title, tw, 10.5, true);
    const found = L.lines(a.found, tw, 9);
    const whyL = L.lines(a.why || '', tw, 9);
    const todoL = L.lines(a.todo || '', tw, 9);
    const textH = head.length * lh75 + title.length * lh105 + found.length * lh9 + (a.why ? lh75 + whyL.length * lh9 + 1 : 0) + (a.todo ? lh75 + todoL.length * lh9 + 1 : 0) + 7;
    let chartH = 0, capLines = [], legendH = 0;
    const chartW = L.cw - 10 - textW - gapX;
    if (hasChart) {
      chartH = (img.height / img.width) * chartW;
      capLines = L.lines(a.chart.subtitle || '', chartW, 7.5);
      legendH = (a.chart.legend?.length ? 6 : 0);
    }
    const blockH = Math.max(textH, hasChart ? chartH + capLines.length * lh75 + legendH + 6 : 0) + 3;
    L.ensure(Math.min(blockH + 2, L.bottom - L.M));
    const y0 = L.y;
    L.doc.setFillColor(...SOFT); L.doc.setDrawColor(...BORDER); L.doc.setLineWidth(0.3);
    L.doc.roundedRect(L.M, y0, L.cw, blockH, 1.5, 1.5, 'FD');
    L.doc.setFillColor(...color); L.doc.rect(L.M, y0, 2.2, blockH, 'F');
    const x0 = L.M + 5;
    let y = y0 + 3.2;
    head.forEach((l) => { L.setFont(7.5, true, color); L.doc.text(l, x0, y + lh75 * 0.8); y += lh75; });
    title.forEach((l) => { L.setFont(10.5, true, INK); L.doc.text(l, x0, y + lh105 * 0.8); y += lh105; });
    y += 0.8;
    found.forEach((l) => { L.setFont(9, false, INK); L.doc.text(l, x0, y + lh9 * 0.8); y += lh9; });
    if (a.why) {
      y += 1; L.setFont(7.5, true, MUTED); L.doc.text('POR QUÉ IMPORTA', x0, y + lh75 * 0.8); y += lh75;
      whyL.forEach((l) => { L.setFont(9, false, INK); L.doc.text(l, x0, y + lh9 * 0.8); y += lh9; });
    }
    if (a.todo) {
      y += 1; L.setFont(7.5, true, color); L.doc.text('QUÉ HACER', x0, y + lh75 * 0.8); y += lh75;
      todoL.forEach((l) => { L.setFont(9, true, INK); L.doc.text(l, x0, y + lh9 * 0.8); y += lh9; });
    }
    if (hasChart) {
      const cx = x0 + textW + gapX;
      L.doc.addImage(img.dataUrl, 'JPEG', cx, y0 + 3, chartW, chartH);
      let cy = y0 + 3 + chartH + 1.5;
      capLines.forEach((l) => { L.setFont(7.5, false, MUTED); L.doc.text(l, cx, cy + lh75 * 0.8); cy += lh75; });
      if (a.chart.legend?.length) drawLegend(L, a.chart.legend, cx, cy + 3.2, chartW);
    }
    L.y = y0 + blockH + 3;
  }
}

function drawHeatmap(L, report) {
  const h = report.heatmap;
  if (!h) return;
  L.ensure(80);
  L.heading(`Mapa de atención por ${h.dimension.toLowerCase()}`);
  L.paragraph('Cada fila es un grupo y cada columna un indicador. El color muestra qué tan lejos está el grupo del resto: rojo si se aleja de forma desfavorable, verde si se destaca de forma favorable y sin color si está dentro de lo habitual. Los grupos que requieren más atención aparecen primero.', { size: 9, color: MUTED, gap: 3 });
  const size = 8, lh = L.lineH(size);
  const nameW = 32, nW = 17, colW = (L.cw - nameW - nW) / h.columns.length;
  const widths = [nameW, nW, ...h.columns.map(() => colW)];
  const headLines = [['Grupo'], ['Registros'], ...h.columns.map(() => null)].map((x, i) => (i < 2 ? L.lines(x[0], widths[i] - 2, size, true) : L.lines(h.columns[i - 2].label, widths[i] - 2, size, true)));
  const hh = Math.max(...headLines.map((l) => l.length)) * lh + 3;
  const drawHead = () => {
    L.ensure(hh + 8);
    L.doc.setFillColor(...BRAND); L.doc.rect(L.M, L.y, L.cw, hh, 'F');
    let x = L.M;
    headLines.forEach((ls, i) => { L.setFont(size, true, WHITE); ls.forEach((l, k) => L.doc.text(l, x + 1.2, L.y + 1.5 + lh * (k + 0.8))); x += widths[i]; });
    L.y += hh;
  };
  drawHead();
  const drawRow = (cells, bold, fills) => {
    const rh = 6.4;
    if (L.y + rh > L.bottom) { L.newPage(); drawHead(); }
    let x = L.M;
    cells.forEach((c, i) => {
      if (fills[i]) { L.doc.setFillColor(...fills[i]); L.doc.rect(x, L.y, widths[i], rh, 'F'); }
      L.setFont(size, bold, INK);
      const txt = pdfSafe(String(c));
      const tw = L.doc.getTextWidth(txt);
      const clipped = i === 0 && tw > widths[i] - 2 ? txt.slice(0, Math.max(3, Math.floor(txt.length * (widths[i] - 2) / tw) - 1)) + '.' : txt;
      if (i <= 0) L.doc.text(clipped, x + 1.2, L.y + 4.4); else L.doc.text(clipped, x + widths[i] / 2, L.y + 4.4, { align: 'center' });
      x += widths[i];
    });
    L.doc.setDrawColor(...BORDER); L.doc.setLineWidth(0.2); L.doc.line(L.M, L.y + rh, L.M + L.cw, L.y + rh);
    L.y += rh;
  };
  h.rows.forEach((r) => drawRow([r.group, fmtInt(r.n), ...r.cells.map((c) => c.display)], false, [null, null, ...r.cells.map((c) => HEAT_FILL[c.level] || null)]));
  drawRow(['Total', '', ...h.total], true, [SOFT, SOFT, ...h.total.map(() => SOFT)]);
  L.y += 3;
}

function drawPlan(L, report) {
  const p = report.plan;
  if (!p.urgent.length && !p.monitor.length && !p.prevent.length) return;
  L.ensure(75);
  L.heading('Plan de acción');
  if (p.urgent.length) {
    L.heading('Resolver con urgencia', 2, PRIORITY_COLORS.urgent);
    if (report.intros.urgent) L.paragraph(report.intros.urgent, { size: 9, color: MUTED, gap: 1.5 });
    L.table(['Qué hacer', 'Por qué', 'Quién', 'Cuándo'], p.urgent.map((x) => [x.action, x.why, x.owner || '-', x.when || '-']), [44, 30, 17, 13], { headFill: PRIORITY_COLORS.urgent });
  }
  if (p.monitor.length) {
    L.heading('Qué monitorear', 2, PRIORITY_COLORS.important);
    if (report.intros.monitor) L.paragraph(report.intros.monitor, { size: 9, color: MUTED, gap: 1.5 });
    L.table(['Qué vigilar', 'Valor hoy', 'Cuándo actuar', 'Cada cuánto'], p.monitor.map((x) => [x.what, x.indicator ? x.indicator.value : '-', x.react_if || '-', x.how_often || '-']), [38, 14, 36, 16], { headFill: PRIORITY_COLORS.important });
  }
  if (p.prevent.length) {
    L.heading('Medidas preventivas y estratégicas', 2, [22, 163, 74]);
    if (report.intros.prevent) L.paragraph(report.intros.prevent, { size: 9, color: MUTED, gap: 1.5 });
    L.table(['Medida', 'Por qué conviene', 'Horizonte'], p.prevent.map((x) => [x.measure, x.why, HORIZON_TEXT[x.horizon] || x.horizon]), [52, 36, 14], { headFill: [22, 163, 74] });
  }
}

function drawNotes(L, report) {
  const q = report.meta.quality;
  L.ensure(60);
  L.heading('Sobre estos datos y sus límites');
  report.notices.forEach((n) => L.callout(n.text, { title: n.title, fill: [254, 249, 195], stroke: [250, 204, 21], color: [113, 63, 18] }));
  const lines = [
    `Se analizaron ${fmtInt(report.meta.rows)} registros del archivo «${report.meta.file_name}».`,
    q.missing_overall_pct > 0 ? `Alrededor del ${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(q.missing_overall_pct)}% de las celdas del archivo estaba vacío; esos datos no se inventaron ni se completaron.` : null,
    q.pii_masked ? `Se protegieron ${q.pii_masked} ${q.pii_masked === 1 ? 'columna' : 'columnas'} con datos personales y los comentarios se anonimizaron antes de analizarlos.` : 'Los comentarios se anonimizaron antes de analizarlos.',
    'Los grupos con menos de 5 registros se agrupan para proteger la privacidad de las personas.',
    ...(report.limitations.other || []),
  ].filter(Boolean);
  L.bullets(lines, { size: 9 });
  if (report.additional_data?.length) {
    L.heading('Datos que conviene recolectar', 2);
    L.bullets(report.additional_data.map((d) => `${d.data}${d.purpose ? ` — ${d.purpose}` : ''}`), { size: 9 });
  }
  if (report.closing) L.paragraph(report.closing, { size: 9.5, italic: true, color: MUTED, gap: 3 });
}

/**
 * Genera y descarga el informe en PDF.
 * @param {object} report  Objeto `report` de AgentsOrchestrator.run()
 * @param {{filename?:string}} [opts]
 */
export async function exportReportPDF(report, opts = {}) {
  if (!report || !report.meta) throw new Error('No hay un informe para exportar. Ejecuta primero el análisis.');
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) throw new Error('La librería jsPDF no se cargó (verifica tu conexión a internet).');
  const doc = new jsPDFCtor({ unit: 'mm', format: 'a4', compress: true });
  doc.setProperties({ title: report.meta.title || 'Informe ejecutivo de Talento Humano', subject: 'Informe para decidir: enfoque, urgencias, monitoreo y prevención', creator: 'Talento Humano IA' });
  const L = new Layout(doc);

  drawCover(L, report);
  drawSummary(L, report);
  drawFocus(L, report);
  await drawAlerts(L, report);
  drawHeatmap(L, report);
  drawPlan(L, report);
  drawNotes(L, report);

  // Pie de página con numeración
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(...BORDER); doc.setLineWidth(0.3); doc.line(L.M, L.H - 12, L.W - L.M, L.H - 12);
    L.setFont(7.5, false, MUTED);
    doc.text(pdfSafe('Informe generado automáticamente. Valide lo encontrado con los líderes de cada área antes de tomar decisiones.'), L.M, L.H - 8);
    doc.text(`Página ${i} de ${total}`, L.W - L.M, L.H - 8, { align: 'right' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = opts.filename || `Informe_Talento_Humano_${stamp}.pdf`;
  doc.save(filename);
  return filename;
}
