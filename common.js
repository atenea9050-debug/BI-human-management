/* =============================================================================
 * common.js — Constantes, etiquetas y utilidades compartidas (orquestador, insights, interfaz y PDF)
 * ========================================================================== */

export const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const OTHER_LABEL = 'Otros (agrupados)';
export const MIN_GROUP = 5;

/* ---------------------------------------------------------------------------
 * Agentes (nombre oficial + descripción en lenguaje llano para la interfaz)
 * ------------------------------------------------------------------------ */
export const AGENT_INFO = {
  agent1: { n: 1, name: 'Ingesta, mapeo y enrutamiento', short: 'Ingesta', friendly: 'Entiende de qué trata el archivo' },
  agent2: { n: 2, name: 'Analista cuantitativo', short: 'Cuantitativo', friendly: 'Mide los indicadores y compara grupos' },
  agent3: { n: 3, name: 'Analista cualitativo (NLP)', short: 'Cualitativo', friendly: 'Lee lo que cuentan las personas' },
  agent4: { n: 4, name: 'Estratega organizacional', short: 'Estratégico', friendly: 'Cruza todo y define prioridades' },
  agent5: { n: 5, name: 'Redactor ejecutivo', short: 'Redactor', friendly: 'Redacta el informe para decidir' },
};

/* ---------------------------------------------------------------------------
 * Catálogos
 * ------------------------------------------------------------------------ */
export const CATEGORIES = ['rotacion', 'ausentismo', 'desempeno', 'clima_laboral', 'capacitacion', 'solicitudes_internas',
  'compensacion', 'demografia', 'estructura_organizacional', 'identificador', 'comentario_libre', 'fecha', 'otro'];
export const CATEGORY_LABELS = {
  rotacion: 'Rotación', ausentismo: 'Ausentismo', desempeno: 'Desempeño', clima_laboral: 'Clima laboral',
  capacitacion: 'Capacitación', solicitudes_internas: 'Solicitudes internas', compensacion: 'Compensación',
  demografia: 'Demografía', estructura_organizacional: 'Estructura organizacional', identificador: 'Identificador',
  comentario_libre: 'Comentarios', fecha: 'Fecha', otro: 'Otros indicadores', liderazgo: 'Liderazgo', carga_laboral: 'Carga laboral',
  calidad_datos: 'Calidad de los datos',
};
export const ROLE_TO_CATEGORY = {
  rotacion: 'rotacion', ausentismo: 'ausentismo', desempeno: 'desempeno', clima: 'clima_laboral', capacitacion: 'capacitacion',
  solicitudes: 'solicitudes_internas', compensacion: 'compensacion', demografia: 'demografia', organizacion: 'estructura_organizacional',
};
// Polaridad: ¿un valor más alto es peor, mejor o no se juzga?
export const POLARITY = { rotacion: 'higher_worse', ausentismo: 'higher_worse', solicitudes_internas: 'higher_worse', desempeno: 'higher_better', clima_laboral: 'higher_better', capacitacion: 'higher_better' };
export const CATEGORY_PRIORITY = ['rotacion', 'ausentismo', 'clima_laboral', 'desempeno', 'solicitudes_internas', 'capacitacion', 'compensacion', 'demografia', 'otro'];

export const THEMES = ['liderazgo', 'carga_laboral', 'compensacion', 'ambiente', 'comunicacion', 'desarrollo', 'balance_vida_trabajo',
  'reconocimiento', 'recursos_herramientas', 'seguridad_salud', 'otro'];
export const THEME_LABELS = {
  liderazgo: 'Liderazgo', carga_laboral: 'Carga laboral', compensacion: 'Compensación y beneficios', ambiente: 'Ambiente y relaciones',
  comunicacion: 'Comunicación', desarrollo: 'Desarrollo y crecimiento', balance_vida_trabajo: 'Balance vida-trabajo',
  reconocimiento: 'Reconocimiento', recursos_herramientas: 'Recursos y herramientas', seguridad_salud: 'Seguridad y salud', otro: 'Otros temas',
};
export const SENTIMENTS = ['positive', 'neutral', 'negative'];
export const CONF = ['low', 'medium', 'high'];
export const SEVERITY = ['info', 'low', 'medium', 'high', 'critical'];
export const LEVELS = ['critical', 'high', 'medium', 'low'];
export const LEVEL_LABELS = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja' };
export const ALERT_AREAS = ['rotacion', 'ausentismo', 'desempeno', 'clima_laboral', 'capacitacion', 'solicitudes_internas', 'compensacion', 'liderazgo', 'carga_laboral', 'calidad_datos', 'otro'];
export const HORIZONS = ['inmediato', 'corto_plazo', 'mediano_plazo'];
export const HORIZON_LABELS = { inmediato: 'Inmediato', corto_plazo: 'Corto plazo', mediano_plazo: 'Mediano plazo' };
export const ROLES = ['measure', 'dimension', 'date', 'identifier', 'free_text', 'pii', 'other'];

// Alertas unificadas (números + comentarios) y su gráfico
export const PRIORITIES = ['urgent', 'important', 'watch'];
export const PRIORITY_LABELS = { urgent: 'Urgente', important: 'Importante', watch: 'Vigilar' };
export const SIGNAL_KINDS = ['cross', 'quantitative', 'qualitative'];
export const KIND_LABELS = {
  cross: 'Los números y los comentarios coinciden', quantitative: 'Lo que muestran los números', qualitative: 'Lo que cuentan las personas',
};
export const VISUAL_TYPES = ['group_bars', 'trend_line', 'cross_quadrant', 'themes_tone', 'themes_group', 'sentiment_donut'];
export const RISK_LEVELS = ['low', 'moderate', 'high', 'critical'];
export const RISK_LABELS = {
  low: 'Situación estable', moderate: 'Requiere seguimiento', high: 'Requiere atención pronta', critical: 'Requiere acción inmediata',
};

/* ---------------------------------------------------------------------------
 * Utilidades de validación y texto
 * ------------------------------------------------------------------------ */
export const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const isStr = (x) => typeof x === 'string' && x.trim().length > 0;
export const asStr = (x, max = 600) => (typeof x === 'string' ? plainify(x.trim()).slice(0, max) : '');
export const asEnum = (x, list, def) => (list.includes(x) ? x : def);
export const asArr = (x) => (Array.isArray(x) ? x : []);
export const strList = (x, max = 8, len = 400) => asArr(x).filter(isStr).slice(0, max).map((s) => plainify(s.trim()).slice(0, len));
export const pad = (n, w = 3) => String(n).padStart(w, '0');
export const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
export const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const plural = (n, one, many) => (n === 1 ? one : many);
/** "A, B y C" */
export function joinList(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} y ${a[a.length - 1]}`;
}

/**
 * Red de seguridad de estilo: si el modelo se desliza hacia la jerga técnica, se sustituye por lenguaje llano.
 * (Los prompts ya lo prohíben; esto cubre los deslices.)
 */
export function plainify(text) {
  return String(text ?? '')
    // Sustituciones que quedan bien con cualquier artículo delante ("los hallazgos cuantitativos" -> "los resultados numéricos")
    .replace(/problem[aá]tica\s+cualitativa/gi, 'situación que describen los comentarios')
    .replace(/hallazgos\s+cuantitativos/gi, 'resultados numéricos')
    .replace(/hallazgo\s+cuantitativo/gi, 'resultado numérico')
    .replace(/hallazgos\s+cualitativos/gi, 'comentarios de las personas')
    .replace(/hallazgo\s+cualitativo/gi, 'comentario de las personas')
    .replace(/estad[ií]sticamente\s+/gi, '')
    .replace(/\bbrechas\b/gi, 'diferencias')
    .replace(/\bbrecha\b/gi, 'diferencia')
    // Símbolos estadísticos: "(n=909, z=23,6)" -> "(909 registros)"
    .replace(/[,;]?\s*\bz\s*=\s*-?\d[\d.,]*/gi, '')
    .replace(/\(\s*n\s*=\s*(\d[\d.,]*)\s*\)/gi, '($1 registros)')
    .replace(/\bn\s*=\s*(\d[\d.,]*)/gi, '$1 registros')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

export const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(abortError()); }, { once: true });
});
export function abortError() { const e = new Error('Análisis cancelado por el usuario.'); e.aborted = true; e.fatal = true; e.code = 'aborted'; return e; }

/* ---------------------------------------------------------------------------
 * Formato de números (es-CO)
 * ------------------------------------------------------------------------ */
const NF = {};
function nf(d) { return NF[d] || (NF[d] = new Intl.NumberFormat('es-CO', { maximumFractionDigits: d, minimumFractionDigits: 0 })); }
export function fmt(x, d = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/d';
  if (Number.isInteger(x)) return nf(0).format(x);
  const a = Math.abs(x);
  return nf(a >= 1000 ? 0 : a >= 100 ? Math.min(d, 1) : d).format(x);
}
export const fmtPct = (x, d = 1) => `${fmt(x, d)}%`;
export const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '');
export const approxTokens = (o) => Math.ceil(JSON.stringify(o).length / 3.6);

/* ---------------------------------------------------------------------------
 * Privacidad y JSON
 * ------------------------------------------------------------------------ */
// Anonimización defensiva (segunda barrera después del worker) para texto libre del usuario
export function scrubText(s) {
  return String(s ?? '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[URL]')
    .replace(/(?<![\w])\+?\d[\d\s().-]{5,}\d(?![\w])/g, (m) => ((m.match(/\d/g) || []).length >= 7 ? '[NUM_ID]' : m))
    .replace(/\b(?:Sr\.?|Sra\.?|Srta\.?|Don|Doña|Dr\.?|Dra\.?|Ing\.?|Lic\.?)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2}/g, '[NOMBRE]');
}
export const safeLabel = (s) => String(s ?? '').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]').slice(0, 80);

export function extractJSON(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (_) { /* recortar */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { /* nada */ } }
  return null;
}

/* ---------------------------------------------------------------------------
 * Verificación de cifras: los números del texto redactado deben existir en lo calculado por código
 * ------------------------------------------------------------------------ */
function parseLocaleNumber(raw) {
  let s = raw.replace(/%$/, '');
  const ld = s.lastIndexOf('.'), lc = s.lastIndexOf(',');
  if (ld >= 0 && lc >= 0) s = ld > lc ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (lc >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (ld >= 0 && s.split('.').length > 2) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d.,]*\d|\d/g)) {
    const n = parseLocaleNumber(m[0]);
    if (n !== null) out.push({ raw: m[0], n });
  }
  return out;
}
export function collectAllowedNumbers(obj, set = new Set()) {
  if (obj === null || obj === undefined) return set;
  if (typeof obj === 'number') { if (Number.isFinite(obj)) set.add(obj); return set; }
  if (typeof obj === 'string') { numbersIn(obj).forEach((x) => set.add(x.n)); return set; }
  if (Array.isArray(obj)) { obj.forEach((x) => collectAllowedNumbers(x, set)); return set; }
  if (isObj(obj)) Object.values(obj).forEach((x) => collectAllowedNumbers(x, set));
  return set;
}
export function consistencyCheck(texts, allowed) {
  const list = [...allowed];
  const unmatched = new Set();
  let checked = 0;
  for (const t of texts) {
    for (const { raw, n } of numbersIn(t)) {
      if (Number.isInteger(n) && Math.abs(n) <= 12) continue;       // conteos pequeños
      if (/^(19|20)\d{2}$/.test(raw)) continue;                      // años
      checked++;
      const ok = list.some((a) => Math.abs(a - n) <= Math.max(0.051, Math.abs(a) * 0.012) || (Math.round(a) === Math.round(n) && Math.abs(a - n) < 0.6));
      if (!ok) unmatched.add(raw);
    }
  }
  return { numbers_checked: checked, unmatched: [...unmatched].slice(0, 12) };
}
