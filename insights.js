/* =============================================================================
 * insights.js — De los datos calculados a un informe para decidir
 * -----------------------------------------------------------------------------
 *  1. Nombres y explicaciones de los indicadores en lenguaje llano.
 *  2. Catálogo cuantitativo (métricas, diferencias entre grupos, tendencias) — CÓDIGO.
 *  3. Entrada y agregación cualitativa (la IA clasifica, el código calcula porcentajes).
 *  4. Gráficos: cada alerta recibe el gráfico que la IA considera más adecuado; el código lo construye con datos reales.
 *  5. Mapa de atención por grupo y explorador de indicadores (lista desplegable).
 *  6. Ensamblado del informe (alertas con gráfico, plan de acción, aviso de datos faltantes).
 * Ninguna cifra la inventa la IA: todas salen de aquí.
 * ========================================================================== */
import {
  OTHER_LABEL, MIN_GROUP, CATEGORIES, CATEGORY_LABELS, ROLE_TO_CATEGORY, POLARITY, CATEGORY_PRIORITY, THEME_LABELS,
  PRIORITY_LABELS, KIND_LABELS, VISUAL_TYPES, RISK_LABELS,
  pad, fmt, fmtPct, sign, lowerFirst, capFirst, plural, joinList, scrubText, safeLabel,
} from './common.js';

/* ---------------------------------------------------------------------------
 * 1. Nombres y explicaciones en lenguaje llano
 * ------------------------------------------------------------------------ */
const SURVEY_PREFIX = /^[pq]\d{1,2}[\s_.-]+/i;

export function cleanBase(raw) {
  const original = String(raw || '').replace(/[_\s]+/g, ' ').trim();
  let s = original.replace(SURVEY_PREFIX, '').trim();
  if (!s) s = original;
  return capFirst(s);
}

/** Nombre legible del indicador (el que propone la IA si existe; si no, uno derivado del encabezado). */
export function plainName(m) {
  if (!m) return '';
  if (m.friendly) return m.friendly;
  const base = cleanBase(m.base || m.label);
  if (m.kind === 'rate') {
    const flag = String(m.flag_desc || base).trim();
    return /^registros con/i.test(flag) ? `Porcentaje de ${flag}` : `Porcentaje de registros con «${flag}»`;
  }
  if (m.kind === 'favorable') return `${base}: % de respuestas favorables`;
  if (m.scale) return `${base} (promedio, escala ${m.scale.min} a ${m.scale.max})`;
  return `${base} (promedio)`;
}
/** Nombre corto, sin paréntesis, para usar dentro de frases. */
export function shortName(m) {
  return lowerFirst(plainName(m).replace(/\s*\(.*?\)\s*/g, ' ').replace(/:\s*% de respuestas favorables/, ' (respuestas favorables)').replace(/^Porcentaje de /, 'porcentaje de ').replace(/\s+/g, ' ').trim());
}
export const fmtValue = (m, v) => (v === null || v === undefined ? 'n/d' : m.unit === 'pct' ? fmtPct(v, 1) : fmt(v, 2));

const EXPLAIN = {
  rotacion: ['Muestra qué parte de las personas se ha retirado o está saliendo de la organización.', 'Un valor más alto significa más salidas; conviene vigilarlo.'],
  ausentismo: ['Muestra cuánto se ausentan las personas de su trabajo.', 'Un valor más alto significa más ausencias.'],
  desempeno: ['Resume cómo se evalúa el desempeño de las personas.', 'Un valor más alto es mejor.'],
  clima_laboral: ['Resume cómo perciben las personas este aspecto de su ambiente de trabajo.', 'Un valor más alto es mejor.'],
  capacitacion: ['Muestra cuánta formación reciben las personas.', 'Un valor más alto indica más capacitación.'],
  solicitudes_internas: ['Mide cómo se gestionan las solicitudes internas (cantidad o tiempos).', 'Valores más altos suelen indicar más carga o más demoras.'],
  compensacion: ['Muestra el nivel de ingresos o beneficios.', 'Sirve para comparar entre grupos; por sí solo no es «bueno» ni «malo».'],
};
/** Qué mide y cómo leerlo (usa lo que escribió la IA; si no hay, una explicación estándar por tema). */
export function explainIndicator(m) {
  if (m.what || m.how) return { what: m.what || '', how: m.how || '' };
  const e = EXPLAIN[m.category];
  if (e) return { what: e[0], how: e[1] };
  return { what: `Indicador calculado a partir de «${(m.source_columns || [])[0] || 'los datos'}».`, how: 'Compara los grupos para ver cuáles se alejan del conjunto.' };
}

/* ---------------------------------------------------------------------------
 * 2. Catálogo cuantitativo (CÓDIGO)
 * ------------------------------------------------------------------------ */
function categoryOfMeasure(m, mapping) {
  const mapped = mapping?.[m.column];
  if (mapped && CATEGORIES.includes(mapped) && !['identificador', 'comentario_libre', 'fecha'].includes(mapped)) return mapped;
  return ROLE_TO_CATEGORY[m.role_hint] || 'otro';
}

/** Desviación de un grupo respecto al total (prueba z de una muestra + tamaño del efecto). mode: 'main' | 'favorable'. */
export function groupDeviation(m, g, mode = 'main') {
  const ov = m.overall;
  if (!g || g.n < MIN_GROUP || !ov || !ov.n) return null;
  let z, diff, effectOk, value, overallValue;
  if (mode === 'favorable' || m.kind === 'binary') {
    const pOv = mode === 'favorable' ? ov.favorable_pct : ov.rate_pct;
    const pG = mode === 'favorable' ? g.favorable_pct : g.rate_pct;
    if (pOv === null || pOv === undefined || pG === null || pG === undefined) return null;
    const p0 = pOv / 100, p = pG / 100;
    if (!(p0 > 0 && p0 < 1)) return null;
    z = (p - p0) / Math.sqrt((p0 * (1 - p0)) / g.n);
    diff = (p - p0) * 100; effectOk = Math.abs(diff) >= 3; value = pG; overallValue = pOv;
  } else {
    if (!ov.sd) return null;
    z = (g.mean - ov.mean) / (ov.sd / Math.sqrt(g.n));
    diff = g.mean - ov.mean; effectOk = Math.abs(diff) >= 0.2 * ov.sd; value = g.mean; overallValue = ov.mean;
  }
  if (!Number.isFinite(z)) return null;
  return { z, diff, effectOk, value, overallValue };
}

/**
 * Nivel de atención de un valor frente al total:
 *  3 muy desfavorable · 2 desfavorable · 1 algo desfavorable · 0 dentro de lo habitual · -1 / -2 favorable.
 * Con polaridad neutra, cualquier desviación marcada vale 1 ("se aleja del resto").
 */
export function adverseLevel(z, polarity, effectOk = true) {
  if (!effectOk || !Number.isFinite(z) || Math.abs(z) < 2.5) return 0;
  if (!polarity || polarity === 'neutral') return 1;
  const s = polarity === 'higher_worse' ? z : -z;
  if (s >= 6) return 3;
  if (s >= 4) return 2;
  if (s >= 2.5) return 1;
  if (s <= -4) return -2;
  return -1;
}
const strengthOf = (z) => (Math.abs(z) >= 6 ? 'muy marcada' : Math.abs(z) >= 4 ? 'marcada' : 'clara');

export function buildQuantCatalog(summary, mapping = {}) {
  const metrics = [], gaps = [], correlations = [], trends = [];
  const byId = new Map();
  const measureMetric = new Map();
  const add = (list, item) => { list.push(item); byId.set(item.id, item); return item; };
  let mi = 0, gi = 0, ci = 0, ti = 0;

  for (const m of summary.measures || []) {
    const ov = m.overall;
    if (!ov || !ov.n) continue;
    const category = categoryOfMeasure(m, mapping);
    const polarity = POLARITY[category] || 'neutral';
    const common = { measure_id: m.id, category, polarity, base: m.label_base, scale: m.scale || null, flag_desc: m.flag_desc || null, source_columns: [m.column], n: ov.n };
    let main;
    if (m.kind === 'binary') {
      main = add(metrics, {
        ...common, id: `m${pad(++mi)}`, kind: 'rate', label: `% ${m.flag_desc || m.label_base}`,
        value: ov.rate_pct, unit: 'pct', display: fmtPct(ov.rate_pct, 1),
        method: `Porcentaje de registros que cumplen la condición sobre ${fmt(ov.n)} registros válidos de "${m.column}".`,
      });
    } else {
      main = add(metrics, {
        ...common, id: `m${pad(++mi)}`, kind: 'mean',
        label: m.scale ? `Promedio de ${m.label_base} (escala ${m.scale.min}-${m.scale.max})` : `Promedio de ${m.label_base}`,
        value: ov.mean, unit: m.scale ? 'score' : 'units', display: fmt(ov.mean, 2), median_display: fmt(ov.p50, 2), sd_display: fmt(ov.sd, 2),
        method: `Promedio aritmético de "${m.column}" sobre ${fmt(ov.n)} registros válidos.`,
      });
      if (m.scale && ov.favorable_pct !== null && ov.favorable_pct !== undefined) {
        add(metrics, {
          ...common, id: `m${pad(++mi)}`, kind: 'favorable', label: `% favorable en ${m.label_base}`,
          value: ov.favorable_pct, unit: 'pct', display: fmtPct(ov.favorable_pct, 1),
          method: `Porcentaje de respuestas ≥ ${m.scale.favorable_from} en la escala ${m.scale.min}-${m.scale.max} (criterio top-2).`,
        });
      }
    }
    measureMetric.set(m.id, main);
  }

  // Diferencias marcadas entre grupos (se usan como señales; la interfaz las presenta con palabras, no con estadísticos)
  const rawGaps = [];
  for (const m of summary.measures || []) {
    const main = measureMetric.get(m.id);
    if (!main) continue;
    for (const dim of m.by_dimension || []) {
      for (const g of dim.groups) {
        if (g.group === OTHER_LABEL) continue;
        const dev = groupDeviation(m, g, 'main');
        if (!dev || Math.abs(dev.z) < 2.5 || !dev.effectOk) continue;
        rawGaps.push({ main, m, dim: dim.dimension, g, dev });
      }
    }
  }
  rawGaps.sort((a, b) => Math.abs(b.dev.z) - Math.abs(a.dev.z));
  const perKey = new Map();
  for (const r of rawGaps) {
    const key = `${r.main.id}|${r.dim}`;
    const c = perKey.get(key) || 0;
    if (c >= 3 || gaps.length >= 24) continue;
    perKey.set(key, c + 1);
    const { dev, main, m, g } = r;
    const fmtV = (v) => (m.kind === 'binary' ? fmtPct(v, 1) : fmt(v, 2));
    const adverse = main.polarity === 'higher_worse' ? dev.diff > 0 : main.polarity === 'higher_better' ? dev.diff < 0 : null;
    add(gaps, {
      id: `g${pad(++gi)}`, metric_id: main.id, label: main.label, category: main.category, polarity: main.polarity,
      dimension: r.dim, group: g.group, n: g.n, group_value: fmtV(dev.value), overall_value: fmtV(dev.overallValue),
      difference: m.kind === 'binary' ? `${sign(dev.diff)}${fmt(Math.abs(dev.diff), 1)} puntos porcentuales` : `${sign(dev.diff)}${fmt(Math.abs(dev.diff), 2)}`,
      z: Math.round(dev.z * 10) / 10, direction: dev.diff > 0 ? 'above' : 'below', adverse, strength: strengthOf(dev.z),
      level: adverseLevel(dev.z, main.polarity, dev.effectOk),
    });
  }

  // Matriz grupo × indicador de la dimensión principal (insumo para el cruce con los comentarios)
  let matrix = null;
  const primaryDim = (summary.dimensions || [])[0];
  if (primaryDim) {
    const groups = primaryDim.groups.filter((g) => g.label !== OTHER_LABEL && g.n >= MIN_GROUP).slice(0, 12);
    const gapCount = new Map();
    gaps.forEach((g) => gapCount.set(g.metric_id, (gapCount.get(g.metric_id) || 0) + 1));
    const prio = (mt) => { const i = CATEGORY_PRIORITY.indexOf(mt.category); return i === -1 ? 99 : i; };
    const cols = metrics.filter((mt) => mt.kind !== 'favorable')
      .sort((a, b) => (gapCount.get(b.id) || 0) - (gapCount.get(a.id) || 0) || prio(a) - prio(b)).slice(0, 6);
    if (groups.length >= 2 && cols.length) {
      matrix = {
        dimension: primaryDim.column,
        metrics: cols.map((c) => ({ id: c.id, label: c.label })),
        rows: groups.map((g) => ({
          group: g.label, n: g.n,
          cells: Object.fromEntries(cols.map((c) => {
            const meas = summary.measures.find((x) => x.id === c.measure_id);
            const dimData = meas?.by_dimension.find((d) => d.dimension === primaryDim.column);
            const gr = dimData?.groups.find((x) => x.group === g.label);
            const v = gr ? (meas.kind === 'binary' ? gr.rate_pct : gr.mean) : null;
            return [c.id, v === null || v === undefined ? null : { value: v, display: meas.kind === 'binary' ? fmtPct(v, 1) : fmt(v, 2) }];
          })),
        })),
      };
    }
  }

  // Asociaciones entre indicadores (solo como contexto)
  for (const c of summary.correlations || []) {
    if (Math.abs(c.r) < 0.25) continue;
    const a = measureMetric.get(c.a), b = measureMetric.get(c.b);
    if (!a || !b || ci >= 8) continue;
    add(correlations, {
      id: `c${pad(++ci)}`, a: a.id, b: b.id, a_label: a.label, b_label: b.label, r: c.r, n: c.n,
      display: `r = ${fmt(c.r, 2)} (${fmt(c.n)} registros)`,
      strength: Math.abs(c.r) >= 0.6 ? 'fuerte' : Math.abs(c.r) >= 0.4 ? 'moderada' : 'débil',
    });
  }

  // Tendencias (primeros 3 vs últimos 3 meses)
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const trendOf = (label, vals, periods, unit, ref, dateCol) => {
    if (vals.length < 6 || ti >= 8) return;
    const first = avg(vals.slice(0, 3)), last = avg(vals.slice(-3));
    if (!Number.isFinite(first) || first === 0) return;
    const change = ((last - first) / Math.abs(first)) * 100;
    const direction = Math.abs(change) < 8 ? 'estable' : change > 0 ? 'al alza' : 'a la baja';
    const f = (x) => (unit === 'pct' ? fmtPct(x, 1) : fmt(x, 2));
    add(trends, {
      id: `t${pad(++ti)}`, label, date_column: dateCol, periods: [periods[0], periods[periods.length - 1]],
      first_display: f(first), last_display: f(last), change_pct: Math.round(change * 10) / 10, direction, ref_metric: ref || null,
      values: vals.map((v) => Math.round(v * 100) / 100), labels: periods,
    });
  };
  (summary.time_series || []).forEach((ts, idx) => {
    const periods = ts.points.map((p) => p.period);
    trendOf(`Registros por mes (${ts.date_column})`, ts.points.map((p) => p.n), periods, 'units', null, ts.date_column);
    if (idx === 0) {
      for (const mid of ts.series_measures || []) {
        const mt = measureMetric.get(mid);
        if (!mt) continue;
        const vals = ts.points.map((p) => p.values[mid]).filter((v) => v !== undefined);
        if (vals.length === ts.points.length) trendOf(`${mt.label} por mes`, vals, periods, mt.kind === 'rate' ? 'pct' : 'units', mt.id, ts.date_column);
      }
    }
  });

  return { metrics, gaps, correlations, trends, matrix, byId, validIds: new Set(byId.keys()), measureMetric, primaryDimension: primaryDim?.column || null };
}

/** Aplica los nombres y explicaciones que propuso el Agente 2 (en lenguaje llano). */
export function applyIndicatorNotes(quant, notes) {
  if (!quant || !notes?.length) return;
  for (const n of notes) {
    const m = quant.byId.get(n.metric_ref);
    if (!m || m.kind === 'favorable') continue;
    m.friendly = n.friendly_name; m.what = n.what_it_measures; m.how = n.how_to_read;
    const fav = quant.metrics.find((x) => x.measure_id === m.measure_id && x.kind === 'favorable');
    if (fav) { fav.friendly = `${n.friendly_name}: % de respuestas favorables`; fav.what = `Parte de las respuestas que son favorables en «${n.friendly_name}».`; fav.how = 'Un porcentaje más alto es mejor.'; }
  }
}

export function quantInputPayload(cat, summary, sector, userContext) {
  const prio = (m) => { const i = CATEGORY_PRIORITY.indexOf(m.category); return i === -1 ? 99 : i; };
  return {
    user_context: userContext || null,
    sector: sector?.label || null,
    dataset: {
      rows: summary.file.rows, columns: summary.file.columns, dimensions: (summary.dimensions || []).map((d) => ({ column: safeLabel(d.column), groups: d.groups.length })),
      date_range: (summary.columns.find((c) => c.type === 'date' && c.date_range)?.date_range) || null,
    },
    metrics: [...cat.metrics].sort((a, b) => prio(a) - prio(b)).slice(0, 60).map((m) => ({
      id: m.id, label: m.label, category: m.category, polarity: m.polarity, display: m.display, n: m.n, median: m.median_display,
    })),
    group_gaps: cat.gaps.map((g) => ({
      id: g.id, metric: g.label, polarity: g.polarity, dimension: safeLabel(g.dimension), group: safeLabel(g.group), n: g.n,
      group_value: g.group_value, overall_value: g.overall_value, difference: g.difference, strength: g.strength, direction: g.direction, adverse: g.adverse,
    })),
    group_matrix: groupMatrixPayload(cat),
    correlations: cat.correlations.map((c) => ({ id: c.id, a: c.a_label, b: c.b_label, display: c.display, strength: c.strength })),
    trends: cat.trends.map((t) => ({ id: t.id, label: t.label, from: t.first_display, to: t.last_display, change_pct: t.change_pct, direction: t.direction, periods: t.periods })),
    data_quality: {
      missing_overall_pct: summary.quality.missing_overall_pct, duplicate_rows: summary.quality.duplicate_rows, notes: summary.quality.notes.slice(0, 5),
      small_groups_policy: `Los grupos con menos de ${MIN_GROUP} registros se agrupan como "${OTHER_LABEL}" y no se analizan.`,
    },
  };
}
export function groupMatrixPayload(cat) {
  if (!cat.matrix) return null;
  return {
    dimension: safeLabel(cat.matrix.dimension), metrics: cat.matrix.metrics,
    rows: cat.matrix.rows.map((r) => ({ group: safeLabel(r.group), n: r.n, values: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, v ? v.display : null])) })),
  };
}

/* ---------------------------------------------------------------------------
 * 3. Cualitativo: entrada para la IA y agregación (la IA clasifica; el código calcula los porcentajes)
 * ------------------------------------------------------------------------ */
// Reparte el cupo entre grupos (ronda por ronda) para que ningún grupo quede sin comentarios; reajusta los pesos
function balancedSlice(samples, limit) {
  if (samples.length <= limit) return samples;
  const buckets = new Map();
  samples.forEach((s) => { const k = s.group || '\u0000'; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(s); });
  const picked = new Map([...buckets.keys()].map((k) => [k, []]));
  let n = 0;
  for (let round = 0; n < limit; round++) {
    let any = false;
    for (const [k, list] of buckets) {
      if (round < list.length && n < limit) { picked.get(k).push(list[round]); n++; any = true; }
    }
    if (!any) break;
  }
  const out = [];
  for (const [k, list] of picked) {
    const orig = buckets.get(k);
    const factor = list.length ? orig.length / list.length : 1;   // cada comentario conservado representa más comentarios
    list.forEach((s) => out.push({ ...s, weight: Math.round((s.weight || 1) * factor * 100) / 100 }));
  }
  return out;
}

export function buildQualInput(summary, userContext, sector) {
  const cols = (summary.text?.columns || []).filter((c) => c.n_texts > 0 && c.samples.length);
  const perCol = Math.max(30, Math.floor(120 / Math.max(1, cols.length)));
  let sid = 0;
  const sources = cols.map((c, i) => ({
    source_id: `src${i + 1}`, column: safeLabel(c.column), kind: c.kind, n_texts_total: c.n_texts, avg_len: c.avg_len,
    lexicon_overview: {
      pct_with_negative_tone: c.n_texts ? Math.round((1000 * c.lexicon.sentiment.neg) / c.n_texts) / 10 : 0,
      pct_with_positive_tone: c.n_texts ? Math.round((1000 * c.lexicon.sentiment.pos) / c.n_texts) / 10 : 0,
      theme_mentions: Object.fromEntries(Object.entries(c.lexicon.theme_counts).filter(([, v]) => v.n > 0).map(([k, v]) => [k, v.n])),
    },
    top_terms: c.top_terms.slice(0, 15).map((t) => t.term),
    by_group_counts: (c.by_group || []).map((g) => ({ group: safeLabel(g.group), n: g.n_texts })),
    samples: balancedSlice(c.samples, perCol).map((s) => ({
      sid: `s${pad(++sid)}`, text: scrubText(s.text), group: s.group ? safeLabel(s.group) : null, weight: s.weight || 1, lex: s.lex,
    })),
  }));
  const validSids = new Set(sources.flatMap((s) => s.samples.map((x) => x.sid)));
  return { sources, validSids, total: validSids.size, userContext, sector };
}

export function qualPayload(q) {
  return {
    user_context: q.userContext || null, sector: q.sector?.label || null,
    allowed_themes: Object.keys(THEME_LABELS),
    sources: q.sources.map((s) => ({
      source_id: s.source_id, column: s.column, kind: s.kind, n_texts_total: s.n_texts_total, lexicon_overview: s.lexicon_overview, top_terms: s.top_terms,
      // El peso solo es informativo para motivos (frecuencia del texto); en comentarios libres sería ruido para el modelo
      samples: s.samples.map((x) => (s.kind === 'reason_category'
        ? { sid: x.sid, text: x.text, group: x.group, times_mentioned: x.weight }
        : { sid: x.sid, text: x.text, group: x.group })),
    })),
  };
}

export function aggregateQual(q, classifications, themeNotes, voice = '') {
  const bySid = new Map();
  q.sources.forEach((s) => s.samples.forEach((x) => bySid.set(x.sid, x)));
  const themeAgg = new Map();
  const groupAgg = new Map();
  const sent = { positive: 0, neutral: 0, negative: 0 };
  let W = 0, classified = 0;
  for (const c of classifications) {
    const s = bySid.get(c.sid);
    if (!s) continue;
    classified++;
    const w = s.weight || 1;
    W += w; sent[c.sentiment] += w;
    for (const t of c.themes) {
      const e = themeAgg.get(t) || { w: 0, neg: 0, pos: 0, neu: 0, sids: [], groups: new Map() };
      e.w += w;
      if (c.sentiment === 'negative') e.neg += w; else if (c.sentiment === 'positive') e.pos += w; else e.neu += w;
      e.sids.push(c.sid);
      if (s.group) e.groups.set(s.group, (e.groups.get(s.group) || 0) + w);
      themeAgg.set(t, e);
    }
    if (s.group) {
      const g = groupAgg.get(s.group) || { w: 0, cnt: 0, neg: 0, pos: 0, themes: new Map() };
      g.w += w; g.cnt++;
      if (c.sentiment === 'negative') g.neg += w; else if (c.sentiment === 'positive') g.pos += w;
      for (const t of c.themes) g.themes.set(t, (g.themes.get(t) || 0) + w);
      groupAgg.set(s.group, g);
    }
  }
  const notes = new Map(themeNotes.map((n) => [n.theme, n]));
  const pct = (x, tot) => (tot ? Math.round((1000 * x) / tot) / 10 : 0);
  const themes = [...themeAgg.entries()].sort((a, b) => b[1].w - a[1].w).map(([t, e], i) => {
    const note = notes.get(t);
    const quoteSids = (note?.representative_sids?.length ? note.representative_sids : e.sids).filter((s) => bySid.has(s)).slice(0, 2);
    const topGroups = [...e.groups.entries()].map(([g, w]) => ({ group: g, share_of_group_pct: pct(w, groupAgg.get(g)?.w || 0), group_n: groupAgg.get(g)?.cnt || 0 }))
      .filter((x) => x.group_n >= MIN_GROUP).sort((a, b) => b.share_of_group_pct - a.share_of_group_pct).slice(0, 3);
    return {
      id: `q${pad(i + 1)}`, theme: t, label: THEME_LABELS[t] || t, mentions_weight: e.w, pct_of_classified: pct(e.w, W),
      negative_pct: pct(e.neg, e.w), neutral_pct: pct(e.neu, e.w), positive_pct: pct(e.pos, e.w),
      description: note?.description || '', risk_level: note?.risk_level || null,
      quotes: quoteSids.map((sid) => ({ sid, text: bySid.get(sid).text, group: bySid.get(sid).group })), top_groups: topGroups,
      counts: { negative: e.neg, neutral: e.neu, positive: e.pos },
    };
  });
  const sentiment = {
    id: 'qs001', positive_pct: pct(sent.positive, W), neutral_pct: pct(sent.neutral, W), negative_pct: pct(sent.negative, W),
    counts: sent, n_classified: classified, n_sent: q.total, universe_texts: q.sources.reduce((s, x) => s + x.n_texts_total, 0),
  };
  const groupList = [...groupAgg.entries()].filter(([, g]) => g.cnt >= MIN_GROUP).sort((a, b) => b[1].cnt - a[1].cnt).slice(0, 12);
  const groups = groupList.map(([g, e], i) => {
    const shares = [...e.themes.entries()].map(([t, w]) => ({ theme: t, label: THEME_LABELS[t] || t, pct: pct(w, e.w) })).sort((a, b) => b.pct - a.pct);
    const top = shares[0];
    return {
      id: `qg${pad(i + 1)}`, group: g, n_samples: e.cnt, negative_pct: pct(e.neg, e.w), positive_pct: pct(e.pos, e.w),
      top_theme: top ? top.label : null, top_theme_pct: top ? top.pct : 0, shares,
    };
  });
  const groupThemes = Object.fromEntries(groups.map((g) => [g.group, g.shares]));
  const byId = new Map();
  themes.forEach((t) => byId.set(t.id, t)); byId.set(sentiment.id, sentiment); groups.forEach((g) => byId.set(g.id, g));
  return { themes, sentiment, groups, groupThemes, totalWeight: W, voice, byId, validIds: new Set(byId.keys()), coverage: q.total ? classified / q.total : 0 };
}

/* ---------------------------------------------------------------------------
 * 4. Gráficos: construidos por código con los datos reales; la IA solo elige el tipo
 * ------------------------------------------------------------------------ */
export const COLORS = { red3: '#b91c1c', red2: '#dc2626', amber: '#f59e0b', slate: '#94a3b8', green1: '#22c55e', green2: '#16a34a', blue: '#2563eb', teal: '#0d9488' };
const LEVEL_COLORS = { 3: COLORS.red3, 2: COLORS.red2, 1: COLORS.amber, 0: COLORS.slate, '-1': COLORS.green1, '-2': COLORS.green2 };
const levelColor = (level, polarity) => (polarity === 'neutral' ? (level >= 1 ? COLORS.blue : COLORS.slate) : (LEVEL_COLORS[level] || COLORS.slate));
const round2 = (x) => Math.round(x * 100) / 100;

// Tolerancia con los nombres de grupo que escribe el modelo (mayúsculas, tildes, espacios)
const normKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function matchGroup(name, candidates) {
  if (!name) return null;
  if (candidates.includes(name)) return name;
  const k = normKey(name);
  return candidates.find((c) => normKey(c) === k) || null;
}

function barLegend(rows, polarity) {
  const has = (f) => rows.some((r) => f(r.level || 0));
  const out = [];
  if (polarity === 'neutral') {
    if (has((l) => l >= 1)) out.push({ color: COLORS.blue, label: 'Se aleja del resto' });
  } else {
    if (has((l) => l >= 1)) out.push({ color: COLORS.red2, label: 'Se aleja del resto de forma desfavorable' });
    if (has((l) => l <= -1)) out.push({ color: COLORS.green2, label: 'Se destaca de forma favorable' });
  }
  out.push({ color: COLORS.slate, label: 'Dentro de lo habitual' });
  return out;
}
export function sortRows(rows, polarity) {
  // Lo más preocupante primero: valor alto si "más es peor"; valor bajo si "más es mejor"
  return [...rows].sort((a, b) => (polarity === 'higher_better' ? a.value - b.value : b.value - a.value));
}

export function barsSpec({ id, title, subtitle, rows, reference = null, suffix = '', polarity = 'neutral' }) {
  return {
    id, type: 'bar', title, subtitle, labels: rows.map((r) => r.label),
    datasets: [{ label: title, data: rows.map((r) => round2(r.value)), colors: rows.map((r) => levelColor(r.level || 0, polarity)) }],
    reference, suffix, legend: barLegend(rows, polarity),
  };
}
export function lineSpec({ id, title, subtitle, labels, values, suffix = '' }) {
  return { id, type: 'line', title, subtitle, labels, datasets: [{ label: title, data: values, color: COLORS.teal }], suffix, legend: [] };
}

function resolveRef(ref, quant) {
  if (!quant || !ref || typeof ref !== 'string') return null;
  const it = quant.byId.get(ref);
  if (!it) return null;
  if (ref[0] === 'm') return { metric: it };
  if (ref[0] === 'g') return { metric: quant.byId.get(it.metric_id), group: it.group, gap: it };
  if (ref[0] === 't') return { metric: it.ref_metric ? quant.byId.get(it.ref_metric) : null, trend: it };
  if (ref[0] === 'c') return { metric: quant.byId.get(it.a) };
  return null;
}
function groupRowsFor(metric, ctx, dimName) {
  const meas = ctx.summary.measures.find((x) => x.id === metric.measure_id);
  if (!meas) return null;
  const dims = meas.by_dimension || [];
  const dimData = dims.find((d) => d.dimension === dimName) || dims.find((d) => d.groups.filter((g) => g.group !== OTHER_LABEL && g.n >= MIN_GROUP).length >= 2);
  if (!dimData) return null;
  const mode = metric.kind === 'favorable' ? 'favorable' : 'main';
  const rows = dimData.groups.filter((g) => g.group !== OTHER_LABEL && g.n >= MIN_GROUP).map((g) => {
    const dev = groupDeviation(meas, g, mode);
    const value = mode === 'favorable' ? g.favorable_pct : meas.kind === 'binary' ? g.rate_pct : g.mean;
    return { label: g.group, group: g.group, n: g.n, value, display: fmtValue(metric, value), level: dev ? adverseLevel(dev.z, metric.polarity, dev.effectOk) : 0 };
  }).filter((r) => r.value !== null && r.value !== undefined);
  return { dimension: dimData.dimension, rows };
}

function visualGroupBars(vs, ctx) {
  const r = resolveRef(vs.ref, ctx.quant);
  if (!r || !r.metric) return null;
  const metric = r.metric;
  const group = vs.group || r.group || null;
  const data = groupRowsFor(metric, ctx, ctx.quant.primaryDimension);
  if (!data || data.rows.length < 2) return null;
  let rows = sortRows(data.rows, metric.polarity);
  if (rows.length > 12) {
    const top = rows.slice(0, 12);
    const g = group && rows.find((x) => x.group === group);
    rows = g && !top.includes(g) ? [...top.slice(0, 11), g] : top;
  }
  const ref = { label: 'Total', value: round2(metric.value) };
  const gRow = group ? data.rows.find((x) => normKey(x.group) === normKey(group)) : null;
  const best = rows[0];
  const lead = gRow
    ? `${gRow.group}: ${gRow.display}, frente a ${metric.display} en el conjunto.`
    : `${best.label} es el grupo con ${metric.polarity === 'higher_better' ? 'el valor más bajo' : 'el valor más alto'} (${best.display}); en el conjunto es ${metric.display}.`;
  return {
    ...barsSpec({
      id: `v_bars_${metric.id}`, title: `${plainName(metric)} por ${lowerFirst(data.dimension)}`, subtitle: `${lead} La línea punteada marca el total.`,
      rows, reference: ref, suffix: metric.unit === 'pct' ? '%' : '', polarity: metric.polarity,
    }),
    how: 'Cada barra es un grupo. Las barras de color señalan los grupos que se alejan del resto.',
  };
}

// Los registros por mes solo importan al negocio si cuentan eventos relevantes (salidas, ausencias, solicitudes…);
// el volumen de respuestas de una encuesta sería ruido.
const COUNT_TREND_OK = /solicitud|retiro|renuncia|salida|baja|ingreso|ausen|incapac|ticket|caso|queja|reclam|permiso/i;
const trendIsMeaningful = (t) => Boolean(t.ref_metric) || COUNT_TREND_OK.test(t.date_column || '');

function visualTrend(vs, ctx) {
  const r = resolveRef(vs.ref, ctx.quant);
  if (!r) return null;
  const trend = r.trend || (r.metric ? ctx.quant.trends.find((t) => t.ref_metric === r.metric.id) : null);
  if (!trend || !trendIsMeaningful(trend)) return null;
  const metric = trend.ref_metric ? ctx.quant.byId.get(trend.ref_metric) : null;
  const name = metric ? plainName(metric) : 'Registros por mes';
  return {
    ...lineSpec({
      id: `v_trend_${trend.id}`, title: `Evolución mensual: ${name}`,
      subtitle: `Pasó de ${trend.first_display} a ${trend.last_display} entre ${trend.periods[0]} y ${trend.periods[1]} (tendencia ${trend.direction}).`,
      labels: trend.labels, values: trend.values, suffix: metric && metric.unit === 'pct' ? '%' : '',
    }),
    how: 'Cada punto es un mes. Mira si la línea sube, baja o se mantiene.',
  };
}

function visualQuadrant(vs, ctx) {
  const { quant, qual } = ctx;
  const r = resolveRef(vs.ref, quant);
  if (!r || !r.metric || !qual || !qual.groups.length) return null;
  const metric = r.metric;
  const data = groupRowsFor(metric, ctx, quant.primaryDimension);
  if (!data || data.dimension !== quant.primaryDimension) return null;
  const overallY = qual.sentiment.negative_pct;
  const points = [];
  for (const g of qual.groups) {
    const row = data.rows.find((x) => x.group === g.group);
    if (!row) continue;
    const highComments = g.negative_pct >= overallY + 8;
    const bad = row.level >= 1;
    points.push({
      label: g.group, x: round2(row.value), y: g.negative_pct, xDisplay: row.display,
      color: bad && highComments ? COLORS.red2 : (bad || highComments) ? COLORS.amber : COLORS.slate, highlight: normKey(g.group) === normKey(vs.group || r.group),
    });
  }
  if (points.length < 3) return null;
  const reverseX = metric.polarity === 'higher_better';
  const polar = metric.polarity !== 'neutral';
  return {
    id: `v_quad_${metric.id}`, type: 'quadrant', title: `Números y comentarios por ${lowerFirst(data.dimension)}`,
    subtitle: polar
      ? 'Cada punto es un grupo. Cuanto más arriba y más a la derecha, más problemas a la vez: peores resultados en el indicador y más comentarios negativos.'
      : 'Cada punto es un grupo: mira si los grupos con valores más altos también tienen más comentarios negativos.',
    points, xTitle: `${plainName(metric)}${reverseX ? ' (el eje va de mayor a menor)' : ''}`, yTitle: 'Comentarios con tono negativo (%)',
    xRef: round2(metric.value), yRef: overallY, reverseX, xSuffix: metric.unit === 'pct' ? '%' : '', ySuffix: '%',
    legend: [{ color: COLORS.red2, label: 'Indicador y comentarios desfavorables' }, { color: COLORS.amber, label: 'Solo uno de los dos' }, { color: COLORS.slate, label: 'Dentro de lo habitual' }],
    how: 'Las líneas punteadas marcan el promedio general: el grupo que queda arriba a la derecha combina ambos problemas.',
  };
}

function visualThemesTone(ctx) {
  const { qual } = ctx;
  if (!qual || !qual.themes.length) return null;
  let th = qual.themes.filter((t) => t.theme !== 'otro').slice(0, 6);
  if (!th.length) th = qual.themes.slice(0, 4);
  const W = qual.totalWeight || 1;
  const p = (x) => Math.round((1000 * x) / W) / 10;
  return {
    id: 'v_themes_tone', type: 'stackedhbar', title: 'De qué hablan los comentarios',
    subtitle: 'Porcentaje de comentarios que menciona cada tema, separado por su tono. Un tema puede aparecer junto a otros en un mismo comentario.',
    labels: th.map((t) => t.label), suffix: '%', legend: [],
    datasets: [
      { label: 'Tono negativo', data: th.map((t) => p(t.counts.negative)), color: COLORS.red2 },
      { label: 'Neutral', data: th.map((t) => p(t.counts.neutral)), color: COLORS.slate },
      { label: 'Tono positivo', data: th.map((t) => p(t.counts.positive)), color: COLORS.green2 },
    ],
    how: 'Cuanto más larga la barra, más se habla del tema; el rojo indica la parte con tono negativo.',
  };
}

function visualThemesGroup(vs, ctx) {
  const { qual } = ctx;
  const group = matchGroup(vs.group, Object.keys(qual?.groupThemes || {}));
  const all = group && qual.groupThemes[group];
  if (!all || !all.length) return null;
  // «Otros temas» no aporta información de negocio: se excluye salvo que sea lo único que hay
  const shares = all.filter((s) => s.theme !== 'otro');
  const top = (shares.length ? shares : all).slice(0, 5);
  const total = new Map(qual.themes.map((t) => [t.theme, t.pct_of_classified]));
  return {
    id: `v_themes_group_${group}`, type: 'groupedhbar', title: `Qué dicen en ${group} frente al total`,
    subtitle: `Porcentaje de los comentarios de ${group} que menciona cada tema, comparado con todos los comentarios.`,
    labels: top.map((t) => t.label), suffix: '%', legend: [],
    datasets: [
      { label: group, data: top.map((t) => t.pct), color: COLORS.red2 },
      { label: 'Total', data: top.map((t) => total.get(t.theme) || 0), color: COLORS.slate },
    ],
    how: 'Si la barra roja es mucho más larga que la gris, ese tema pesa más en este grupo que en el resto.',
  };
}

function visualDonut(ctx) {
  const { qual } = ctx;
  if (!qual) return null;
  const s = qual.sentiment;
  return {
    id: 'v_donut', type: 'doughnut', title: 'Tono general de los comentarios', subtitle: 'Porcentaje de comentarios con tono negativo, neutral o positivo.',
    labels: ['Negativo', 'Neutral', 'Positivo'], suffix: '%', legend: [],
    datasets: [{ label: 'Tono', data: [s.negative_pct, s.neutral_pct, s.positive_pct], colors: [COLORS.red2, COLORS.slate, COLORS.green2] }],
    how: 'Muestra qué parte de los comentarios es crítica, neutral o positiva.',
  };
}

/** Construye el gráfico pedido (tipo + referencia + grupo). Devuelve null si con los datos reales no se puede dibujar. */
export function buildVisual(vs, ctx) {
  if (!vs || !VISUAL_TYPES.includes(vs.type)) return null;
  try {
    switch (vs.type) {
      case 'group_bars': return visualGroupBars(vs, ctx);
      case 'trend_line': return visualTrend(vs, ctx);
      case 'cross_quadrant': return visualQuadrant(vs, ctx);
      case 'themes_tone': return visualThemesTone(ctx);
      case 'themes_group': return visualThemesGroup(vs, ctx);
      case 'sentiment_donut': return visualDonut(ctx);
      default: return null;
    }
  } catch (_) { return null; }
}

/** Alternativas por reglas cuando la elección de la IA no puede dibujarse con los datos. */
export function fallbackVisuals(sig, ctx) {
  const { quant, qual, availability } = ctx;
  const refs = sig.evidence_refs || [];
  const has = (p) => refs.find((r) => r[0] === p && quant?.byId.has(r));
  const gapRef = has('g'), trendRef = has('t'), metricRef = has('m');
  const group = sig.group || (gapRef ? quant.byId.get(gapRef).group : '') || '';
  const out = [];
  if (sig.kind === 'cross' && availability.cross_analysis_possible) {
    const ref = gapRef || metricRef;
    if (ref) out.push({ type: 'cross_quadrant', ref, group });
  }
  if (gapRef) out.push({ type: 'group_bars', ref: gapRef, group });
  if (trendRef) out.push({ type: 'trend_line', ref: trendRef });
  if (metricRef) out.push({ type: 'group_bars', ref: metricRef, group });
  if (qual) {
    const g = matchGroup(group, Object.keys(qual.groupThemes || {}));
    if (g) out.push({ type: 'themes_group', group: g });
    out.push({ type: 'themes_tone' });
  }
  return out;
}

/** Qué gráficos se pueden dibujar con estos datos (se le informa a la IA para que elija entre opciones reales). */
export function visualOptions(ctx) {
  const { quant, qual, availability } = ctx;
  const opt = { group_bars: [], trend_line: [], cross_quadrant: [], themes_group: [], themes_tone: Boolean(qual), sentiment_donut: Boolean(qual) };
  if (quant) {
    for (const m of quant.metrics.filter((x) => x.kind !== 'favorable').slice(0, 14)) {
      const d = groupRowsFor(m, ctx, quant.primaryDimension);
      if (d && d.rows.length >= 2) opt.group_bars.push(m.id);
      if (availability.cross_analysis_possible && qual && visualQuadrant({ ref: m.id }, ctx)) opt.cross_quadrant.push(m.id);
    }
    opt.trend_line = quant.trends.filter(trendIsMeaningful).map((t) => t.id);
  }
  if (qual) opt.themes_group = Object.keys(qual.groupThemes || {});
  return opt;
}

/* ---------------------------------------------------------------------------
 * 5. Mapa de atención por grupo y explorador de indicadores
 * ------------------------------------------------------------------------ */
export function buildHeatmap(ctx) {
  const { summary, quant, qual } = ctx;
  if (!quant || !quant.primaryDimension) return null;
  const dimName = quant.primaryDimension;
  const dimInfo = (summary.dimensions || []).find((d) => d.column === dimName);
  if (!dimInfo) return null;
  const groups = dimInfo.groups.filter((g) => g.label !== OTHER_LABEL && g.n >= MIN_GROUP).slice(0, 10);
  if (groups.length < 2) return null;

  const cand = [];
  for (const m of quant.metrics.filter((x) => x.kind !== 'favorable')) {
    const data = groupRowsFor(m, ctx, dimName);
    if (!data || data.dimension !== dimName || data.rows.length < 2) continue;
    const cells = groups.map((g) => data.rows.find((r) => r.group === g.label) || null);
    const maxAdverse = Math.max(0, ...cells.map((c) => (c ? c.level : 0)));
    const catRank = CATEGORY_PRIORITY.indexOf(m.category);
    cand.push({ m, cells, maxAdverse, neutral: m.polarity === 'neutral', rank: catRank === -1 ? 99 : catRank });
  }
  cand.sort((a, b) => (a.neutral - b.neutral) || (b.maxAdverse - a.maxAdverse) || (a.rank - b.rank));
  const chosen = cand.slice(0, 5);
  if (!chosen.length) return null;

  const columns = chosen.map((c) => ({ id: c.m.id, label: capFirst(shortName(c.m)), kind: 'metric', polarity: c.m.polarity }));
  const totals = chosen.map((c) => c.m.display);
  const rows = groups.map((g, gi) => ({
    group: g.label, n: g.n,
    cells: chosen.map((c) => (c.cells[gi] ? { display: c.cells[gi].display, level: c.cells[gi].level } : { display: '—', level: 0 })),
  }));
  if (qual && qual.groups.length >= 3) {
    const overall = qual.sentiment.negative_pct;
    columns.push({ id: 'comments', label: 'Comentarios con tono negativo', kind: 'comments', polarity: 'higher_worse' });
    totals.push(fmtPct(overall, 0));
    rows.forEach((r) => {
      const g = qual.groups.find((x) => x.group === r.group);
      if (!g) { r.cells.push({ display: '—', level: 0 }); return; }
      const d = g.negative_pct - overall;
      r.cells.push({ display: fmtPct(g.negative_pct, 0), level: d >= 15 ? 2 : d >= 8 ? 1 : d <= -10 ? -1 : 0 });
    });
  }
  rows.forEach((r) => { r.score = r.cells.reduce((s, c) => s + Math.max(0, c.level), 0); });
  rows.sort((a, b) => b.score - a.score || b.n - a.n);
  return { dimension: dimName, columns, rows, total: totals };
}

function readIndicator(ind, dimRows, qual) {
  if (!dimRows || dimRows.length < 2) return `El valor general es ${ind.value}.`;
  const byValue = [...dimRows].sort((a, b) => b.value - a.value);
  const hi = byValue[0], lo = byValue[byValue.length - 1];
  const parts = [`En conjunto, el valor es ${ind.value}.`, `El más alto está en ${hi.group} (${hi.display}) y el más bajo en ${lo.group} (${lo.display}).`];
  const bad = dimRows.filter((r) => r.level >= 1).map((r) => r.group);
  const good = dimRows.filter((r) => r.level <= -1).map((r) => r.group);
  if (ind.polarity === 'neutral') {
    const far = dimRows.filter((r) => r.level >= 1).map((r) => r.group);
    if (far.length) parts.push(`Se alejan claramente del resto: ${joinList(far)}.`);
  } else {
    if (bad.length) parts.push(`Conviene prestar atención a ${joinList(bad)}: se ${plural(bad.length, 'aleja', 'alejan')} del resto en sentido desfavorable.`);
    if (good.length) parts.push(`${joinList(good)} se ${plural(good.length, 'destaca', 'destacan')} de forma positiva.`);
  }
  if (qual && qual.groups.length && bad.length) {
    const g = qual.groups.find((x) => bad.includes(x.group) && x.negative_pct >= qual.sentiment.negative_pct + 8);
    if (g) parts.push(`En ${g.group}, además, el ${fmtPct(g.negative_pct, 0)} de los comentarios tiene un tono negativo (en el total: ${fmtPct(qual.sentiment.negative_pct, 0)}).`);
  }
  return parts.join(' ');
}

export function buildIndicators(ctx, alerts) {
  const { summary, quant, qual } = ctx;
  const list = [];
  const alertsFor = (id) => alerts.filter((a) => (a.evidence_refs || []).includes(id) || a.metric_ids?.includes(id)).map((a) => ({ id: a.id, title: a.title }));
  if (quant) {
    for (const m of quant.metrics) {
      const meas = summary.measures.find((x) => x.id === m.measure_id);
      if (!meas) continue;
      const byDimension = [];
      for (const dim of meas.by_dimension || []) {
        const data = groupRowsFor(m, ctx, dim.dimension);
        if (!data || data.dimension !== dim.dimension || data.rows.length < 2) continue;
        byDimension.push({ dimension: dim.dimension, rows: sortRows(data.rows, m.polarity) });
      }
      const trend = quant.trends.find((t) => t.ref_metric === m.id && m.kind !== 'favorable') || null;
      const ex = explainIndicator(m);
      const primary = byDimension.find((d) => d.dimension === quant.primaryDimension) || byDimension[0];
      list.push({
        id: m.id, source: 'numbers', name: plainName(m), category: m.category, categoryLabel: CATEGORY_LABELS[m.category] || 'Otros indicadores',
        value: m.display, unit: m.unit, n: m.n, polarity: m.polarity, what: ex.what, how: ex.how, reference: round2(m.value),
        byDimension, trend: trend ? { labels: trend.labels, values: trend.values, text: `Pasó de ${trend.first_display} a ${trend.last_display} (${trend.direction}).` } : null,
        reading: readIndicator({ value: m.display, polarity: m.polarity }, primary?.rows, qual), related: alertsFor(m.id),
      });
    }
  }
  if (qual) {
    const W = qual.totalWeight || 1;
    for (const t of qual.themes.filter((x) => x.theme !== 'otro').slice(0, 6)) {
      const byDimension = [];
      const dimName = quant?.primaryDimension || summary.dimensions?.[0]?.column || null;   // también sin parte numérica
      if (dimName && Object.keys(qual.groupThemes).length >= 2) {
        const rows = [];
        for (const [group, shares] of Object.entries(qual.groupThemes)) {
          const s = shares.find((x) => x.theme === t.theme);
          const v = s ? s.pct : 0;
          rows.push({ label: group, group, n: qual.groups.find((g) => g.group === group)?.n_samples || 0, value: v, display: fmtPct(v, 0), level: v >= t.pct_of_classified + 10 && t.negative_pct >= 40 ? 1 : 0 });
        }
        if (rows.length >= 2) byDimension.push({ dimension: dimName, rows: rows.sort((a, b) => b.value - a.value) });
      }
      const top = byDimension[0]?.rows[0];
      list.push({
        id: t.id, source: 'comments', name: `Comentarios sobre ${t.label.toLowerCase()}`, category: 'comentarios', categoryLabel: 'Lo que cuentan las personas',
        value: fmtPct(t.pct_of_classified, 0), unit: 'pct', n: qual.sentiment.n_classified, polarity: 'neutral',
        what: 'Parte de los comentarios que menciona este tema.',
        how: 'Un porcentaje más alto indica un tema más presente en las conversaciones; mira también el tono.',
        reference: t.pct_of_classified, byDimension, trend: null,
        reading: `El ${fmtPct(t.pct_of_classified, 0)} de los comentarios habla de ${t.label.toLowerCase()}; de ellos, el ${fmtPct(t.negative_pct, 0)} tiene un tono negativo.${top ? ` Se menciona más en ${top.group} (${top.display}).` : ''}${t.description ? ` ${t.description}` : ''}`,
        quotes: t.quotes.map((q) => ({ text: q.text, group: q.group })), related: alertsFor(t.id), W,
      });
    }
  }
  // Orden del selector: primero lo que aparece en alguna alerta, luego por tema de negocio; los "% favorable" van después de su promedio
  const inAlerts = (i) => (i.related.length ? 0 : 1);
  const isFav = (i) => (i.name.includes('% de respuestas favorables') ? 1 : 0);
  const catRank = (i) => { const k = CATEGORY_PRIORITY.indexOf(i.category); return i.source === 'comments' ? 50 : k === -1 ? 90 : k; };
  return list.map((i, idx) => ({ i, idx }))
    .sort((a, b) => inAlerts(a.i) - inAlerts(b.i) || catRank(a.i) - catRank(b.i) || isFav(a.i) - isFav(b.i) || a.idx - b.idx)
    .map((x) => x.i);
}

/* ---------------------------------------------------------------------------
 * 6. Ensamblado del informe
 * ------------------------------------------------------------------------ */
function evidenceLabel(id, ctx) {
  const { quant, qual, a2 } = ctx;
  const q = quant?.byId.get(id);
  if (q) {
    if (id[0] === 'g') return { id, label: `${capFirst(shortName(quant.byId.get(q.metric_id)))} en ${q.group}: ${q.group_value} (en el total: ${q.overall_value})` };
    if (id[0] === 'c') return { id, label: `${capFirst(shortName(quant.byId.get(q.a)))} y ${shortName(quant.byId.get(q.b))} suelen moverse juntos (relación ${q.strength})` };
    if (id[0] === 't') return { id, label: `${q.label}: pasó de ${q.first_display} a ${q.last_display} (${q.direction})` };
    return { id, label: `${plainName(q)}: ${q.display}` };
  }
  const l = qual?.byId.get(id);
  if (l) {
    if (id.startsWith('qs')) return { id, label: `Tono general de los comentarios: ${fmtPct(l.negative_pct, 0)} negativo y ${fmtPct(l.positive_pct, 0)} positivo` };
    if (id.startsWith('qg')) return { id, label: `En ${l.group}, el ${fmtPct(l.negative_pct, 0)} de los comentarios tiene tono negativo${l.top_theme ? ` y el tema más mencionado es ${l.top_theme.toLowerCase()}` : ''}` };
    return { id, label: `Tema «${l.label}»: el ${fmtPct(l.pct_of_classified, 0)} de los comentarios lo menciona (${fmtPct(l.negative_pct, 0)} con tono negativo)` };
  }
  const f = a2?.findings?.find((x) => x.id === id);
  if (f) return { id, label: f.title };
  return { id, label: id };
}

function pluralize(n, one, many) { return `${fmt(n)} ${plural(n, one, many)}`; }

function leadSentence(ctx, alerts, moreCount) {
  const { summary, quant, qual } = ctx;
  const nInd = quant ? quant.metrics.filter((m) => m.kind !== 'favorable').length : 0;
  const nCom = qual ? qual.sentiment.universe_texts : 0;
  let scope;
  if (nInd && nCom) scope = `revisó ${pluralize(nInd, 'indicador', 'indicadores')} y ${pluralize(nCom, 'comentario', 'comentarios')}`;
  else if (nInd) scope = `revisó ${pluralize(nInd, 'indicador', 'indicadores')}`;
  else scope = `revisó ${pluralize(nCom, 'comentario', 'comentarios')}`;
  const all = [...alerts];
  const total = all.length + moreCount;
  const u = all.filter((a) => a.priority === 'urgent').length, im = all.filter((a) => a.priority === 'important').length, w = all.filter((a) => a.priority === 'watch').length + moreCount;
  const bits = [];
  if (u) bits.push(pluralize(u, 'urgente', 'urgentes'));
  if (im) bits.push(pluralize(im, 'importante', 'importantes'));
  if (w) bits.push(`${w} para vigilar`);
  const signalTxt = total
    ? `${plural(total, 'se encontró', 'se encontraron')} ${pluralize(total, 'señal', 'señales')} de atención${bits.length ? `: ${joinList(bits)}` : ''}`
    : 'no se encontraron señales de atención relevantes';
  return `El análisis de los datos de «${summary.file.name}» (${fmt(summary.file.rows)} registros) ${scope}; ${signalTxt}.`;
}

const PRIORITY_ORDER = { urgent: 0, important: 1, watch: 2 };
const MAX_ALERTS = 6;

// Indicadores a los que se refiere una alerta (por sus referencias de evidencia y por el gráfico elegido)
function metricIdsOf(sig, quant) {
  const ids = new Set();
  const add = (ref) => {
    const r = resolveRef(ref, quant);
    if (r?.metric) ids.add(r.metric.id);
    if (ref && ref[0] === 'c') { const c = quant?.byId.get(ref); if (c) { ids.add(c.a); ids.add(c.b); } }
  };
  (sig.evidence_refs || []).forEach(add);
  if (sig.visual?.ref) add(sig.visual.ref);
  return [...ids];
}

/**
 * Ensambla el informe final (alertas con su gráfico, mapa de atención, explorador de indicadores, plan de acción).
 * ctx: { summary, quant, qual, availability, a1, a2, a4, a5 (SALIDAS de cada agente; a2 puede ser null), a2Status, a3Status,
 *        run_id, dataset_id, mode, models, warnings, routing, promptVersions, agentTrace }
 */
export function assembleReport(ctx) {
  const { summary, quant, qual, availability, a1, a2, a4, a5 } = ctx;
  const warnings = [...(ctx.warnings || [])];
  const signalsIn = (a4.signals || []).map((s, idx) => ({ ...s, idx }));
  signalsIn.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.kind === 'cross' ? 0 : 1) - (b.kind === 'cross' ? 0 : 1) || a.idx - b.idx);

  const alerts = [], more = [];
  const vctx = { summary, quant, qual, availability };
  signalsIn.forEach((s) => {
    const evidence = s.evidence_refs.map((r) => evidenceLabel(r, ctx));
    const base = {
      priority: s.priority, priorityLabel: PRIORITY_LABELS[s.priority], kind: s.kind, kindLabel: KIND_LABELS[s.kind], area: s.area,
      areaLabel: CATEGORY_LABELS[s.area] || 'General', title: s.title, found: s.found, why: s.why_it_matters, todo: s.what_to_do,
      group: s.group || null, evidence, evidence_refs: s.evidence_refs, metric_ids: metricIdsOf(s, quant),
    };
    if (alerts.length >= MAX_ALERTS) { more.push({ ...base, chart: null }); return; }
    const id = `a${pad(alerts.length + 1)}`;
    let chart = buildVisual(s.visual, vctx), adjusted = false;
    if (!chart) {
      for (const alt of fallbackVisuals(s, vctx)) { chart = buildVisual(alt, vctx); if (chart) { adjusted = Boolean(s.visual && s.visual.type); break; } }
    }
    if (adjusted) warnings.push({ agent: 'agent4', code: 'grafico_ajustado', message: `El gráfico «${s.visual.type}» no se pudo dibujar con los datos de «${s.title.slice(0, 40)}»; se usó una alternativa.` });
    alerts.push({ id, ...base, chart, chartType: chart ? (chart.type) : null, chartReason: s.visual?.reason || '' });
  });
  more.forEach((m, i) => { m.id = `o${pad(i + 1)}`; });

  const indicators = buildIndicators(ctx, alerts);
  const suggested = (a2?.indicator_notes || []).map((n) => n.metric_ref).filter((id) => indicators.some((i) => i.id === id)).slice(0, 4);
  const fallbackSuggested = indicators.filter((i) => i.related.length).map((i) => i.id).slice(0, 4);
  const heatmap = buildHeatmap(ctx);

  // Plan de acción (los indicadores a monitorear se enlazan con el explorador)
  const plan = a4.action_plan || { urgent: [], monitor: [], prevent: [] };
  const monitor = plan.monitor.map((m) => {
    const metric = m.ref && quant?.byId.get(m.ref);
    const ind = metric ? indicators.find((i) => i.id === m.ref) : null;
    return { ...m, indicator: ind ? { id: ind.id, name: ind.name, value: ind.value } : null };
  });

  const L = a4.limitations || {};
  const notices = [];
  if (!availability.has_quantitative) notices.push({ title: 'Faltan datos numéricos', text: L.missing_quantitative });
  if (!availability.has_qualitative) notices.push({ title: 'Faltan comentarios de las personas', text: L.missing_qualitative });
  if (availability.has_quantitative !== availability.has_qualitative) {
    notices.push({ title: 'El cruce entre números y comentarios no es posible con este archivo', text: availability.has_quantitative
      ? 'Por eso las alertas se basan solo en los números: explican cuánto y dónde, pero no el porqué.'
      : 'Por eso las alertas se basan solo en los comentarios: explican el porqué, pero no cuánto ni dónde pesa el problema.' });
  }

  const risk = a4.diagnosis.overall_risk;
  const moreCount = more.length;
  const paragraphs = a5.executive_summary;
  return {
    meta: {
      title: a5.report_title, subtitle: a5.subtitle, generated_at: new Date().toISOString(), file_name: summary.file.name,
      rows: summary.file.rows, columns: summary.file.columns, sector: a1.sector.label, sector_confidence: a1.sector.confidence,
      data_nature: a1.data_nature, mode: ctx.mode, models: ctx.models, overall_risk: risk, risk_label: RISK_LABELS[risk] || '',
      availability: { ...availability, quantitative_status: ctx.a2Status, qualitative_status: ctx.a3Status },
      quality: { missing_overall_pct: summary.quality.missing_overall_pct, duplicate_rows: summary.quality.duplicate_rows, notes: summary.quality.notes, pii_masked: summary.processing.pii_masked_columns.length },
    },
    summary: { lead: leadSentence(ctx, alerts, moreCount), headline: a4.diagnosis.headline, paragraphs, key_messages: a5.key_messages, risk, risk_label: RISK_LABELS[risk] || '' },
    focus: (a4.focus_areas || []).map((f) => ({ title: f.title, why: f.why, evidence: f.evidence_refs.map((r) => evidenceLabel(r, ctx)) })),
    alerts, more_alerts: more,
    heatmap, indicators, suggested_indicators: suggested.length ? suggested : fallbackSuggested,
    plan: { urgent: plan.urgent, monitor, prevent: plan.prevent },
    intros: a5.section_intros, closing: a5.closing, notices,
    limitations: { other: (L.other || []).slice(0, 8) }, additional_data: a4.additional_data_suggested || [],
    voice: qual?.voice || '',
    warnings,
    annex: {
      quant_findings: (a2?.findings || []).map((f) => ({ ...f, evidence: f.evidence_refs.map((r) => evidenceLabel(r, ctx)) })),
      qual_themes: qual ? qual.themes : [], qual_sentiment: qual ? qual.sentiment : null,
      group_matrix: quant?.matrix || null, metrics: quant ? quant.metrics : [], gaps: quant ? quant.gaps : [],
    },
    traceability: {
      run_id: ctx.run_id, dataset_id: ctx.dataset_id, routing: ctx.routing, prompt_versions: ctx.promptVersions, agents: ctx.agentTrace,
    },
  };
}
