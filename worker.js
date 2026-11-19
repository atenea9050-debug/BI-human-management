/* =============================================================================
 * worker.js — Procesamiento local pesado (Web Worker)
 * -----------------------------------------------------------------------------
 * Responsabilidades (TODO ocurre en el navegador del usuario, fuera del hilo UI):
 *   1. Leer archivos CSV/Excel de 20-50 MB en streaming (PapaParse) en 2 pasadas.
 *   2. Detectar encabezados, delimitador, codificación y tipos de columna.
 *   3. Detectar y ENMASCARAR datos personales (PII): nombres, correos, cédulas,
 *      teléfonos, direcciones. Los valores PII nunca salen del worker.
 *   4. Calcular métricas estadísticas base (promedios, tasas, brechas por grupo,
 *      series mensuales, correlaciones) con código determinista.
 *   5. Extraer muestras de texto cualitativo ANONIMIZADAS + conteos por léxico.
 *   6. Devolver un JSON de resumen compacto (decenas de KB) para los agentes IA.
 *
 * Protocolo de mensajes
 *   UI -> worker : { type:'process', file:File, options?:{} }
 *   worker -> UI : { type:'progress', phase, pct, message }
 *                  { type:'result', summary }
 *                  { type:'error', message, code, detail }
 * ========================================================================== */
'use strict';

const PAPA_URL = 'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js';
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

let papaError = null;
try { importScripts(PAPA_URL); } catch (e) { papaError = e; }

/* ---------------------------------------------------------------------------
 * Configuración
 * ------------------------------------------------------------------------ */
const CFG = {
  CSV_CHUNK: 4 * 1024 * 1024,   // tamaño de bloque de lectura de PapaParse
  RESERVOIR: 2000,              // muestra para cuantiles por columna numérica
  MAX_DISTINCT: 3000,           // valores distintos rastreados por columna de texto corto
  HEADER_SCAN_ROWS: 12,         // filas inspeccionadas para localizar el encabezado
  MIN_GROUP: 5,                 // k-anonimato: grupos con menos registros se agrupan en "Otros"
  MAX_GROUPS: 20,               // grupos máximos por dimensión
  MAX_DIMS: 3,                  // dimensiones (departamento, sede, etc.) analizadas
  MAX_NUM_MEASURES: 20,         // medidas numéricas / escalas
  MAX_BIN_MEASURES: 8,          // medidas binarias (tasas)
  CORR_VARS: 10,                // variables para matriz de correlaciones
  MAX_TEXT_COLS: 4,             // columnas cualitativas analizadas
  TEXT_SAMPLES_PER_COL: 120,    // comentarios muestreados por columna
  TEXT_SAMPLE_MAX_CHARS: 280,   // longitud máxima de cada comentario enviado
  MAX_NAME_TOKENS: 40000,       // tokens de nombres propios recolectados para anonimizar texto
  MAX_SERIES_POINTS: 36,        // meses máximos en las series temporales
  MAX_DUP_TRACK: 2000000,       // filas rastreadas para duplicados
  MAX_COLUMNS: 400,
  OTHER_LABEL: 'Otros (agrupados)',
};

const NOW_Y = new Date().getUTCFullYear();

/* ---------------------------------------------------------------------------
 * Utilidades generales
 * ------------------------------------------------------------------------ */
const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => strip(s).toLowerCase();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const pretty = (name) => String(name).replace(/[_\s]+/g, ' ').trim();

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260607); // semilla fija => resultados reproducibles

// Hash de 53 bits (cyrb53) para detectar duplicados sin guardar las filas
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function coded(code, message) { const e = new Error(message); e.code = code; return e; }

let lastProgressAt = 0;
function progress(phase, pct, message, force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 120) return;
  lastProgressAt = now;
  self.postMessage({ type: 'progress', phase, pct: Math.max(0, Math.min(100, Math.round(pct))), message });
}

/* ---------------------------------------------------------------------------
 * Celdas: normalización, valores faltantes, números, fechas y booleanos
 * ------------------------------------------------------------------------ */
const MISSING = new Set(['', 'na', 'n/a', 'n.a.', 'nan', 'null', 'none', 'nulo', '-', '--', '---', 's/d', 'sd', 'nd',
  'n/d', '#n/a', '#n/d', '#valor!', '#div/0!', '#ref!', 'sin dato', 'sin datos', 'sin informacion', 'sin información',
  'no aplica', '?', '.', 'undefined']);

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return v;
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).trim();
}
function isMissingCell(v) {
  if (v === '') return true;
  if (typeof v === 'number') return !Number.isFinite(v);
  return v.length <= 16 && MISSING.has(v.toLowerCase());
}

function parseNum(s) {
  s = s.replace(/[\s$€£]|COP|USD|EUR|%/gi, '');
  if (s === '' || !/^[-+]?(\d[\d.,']*|[.,]\d+)$/.test(s)) return null;
  s = s.replace(/'/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Ambos separadores: el último es el decimal ("1.234,56" o "1,234.56")
    s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    const milesES = parts.length > 2 || (parts.length === 2 && /^\d{3}$/.test(parts[1]) && /^[-+]?\d{1,3}$/.test(parts[0]));
    s = milesES ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    if (s.split('.').length > 2) s = s.replace(/\./g, ''); // 1.234.567
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function mkDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  if (dt.getUTCMonth() !== mo - 1) return null;
  return { y, mo, d, ts };
}
function parseDate(s) {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return mkDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    // Convención latinoamericana DD/MM/AAAA; si el 2.º campo > 12 es MM/DD/AAAA
    if (b > 12 && a <= 12) return mkDate(y, a, b);
    return mkDate(y, b, a);
  }
  return null;
}
const isDateAnomaly = (d) => d.y < 1950 || d.y > NOW_Y + 1;

const BOOL_T = new Set(['si', 'sí', 's', 'yes', 'y', 'true', 'verdadero', 'v']);
const BOOL_F = new Set(['no', 'n', 'false', 'falso', 'f']);
function parseBool(s) {
  if (s.length > 9) return null;
  const k = s.toLowerCase();
  if (BOOL_T.has(k)) return true;
  if (BOOL_F.has(k)) return false;
  return null;
}

// Clasificación de una celda de texto sin crear objetos (variables compartidas)
const T_NUM = 1, T_DATE = 2, T_BOOL = 3, T_STR = 4;
let CL_N = 0, CL_D = null, CL_B = false;
function classify(s) {
  const c0 = s.charCodeAt(0);
  if ((c0 >= 48 && c0 <= 57) || c0 === 45 || c0 === 43 || c0 === 36 || c0 === 46 || c0 === 44 || c0 === 8364) {
    if (s.length >= 6 && s.length <= 30) { const d = parseDate(s); if (d) { CL_D = d; return T_DATE; } }
    const n = parseNum(s);
    if (n !== null) { CL_N = n; return T_NUM; }
  }
  const b = parseBool(s);
  if (b !== null) { CL_B = b; return T_BOOL; }
  return T_STR;
}

/* ---------------------------------------------------------------------------
 * Pistas por encabezado (rol HR, PII, identificadores)
 * ------------------------------------------------------------------------ */
const PII_HEADER = [
  ['email', /(^|_)(correo|email|e_?mail|mail)(_|$)/],
  ['documento', /(^|_)(cedula|documento|dni|identificacion|nit|pasaporte|curp|rut|nuip|ssn|nss|num_?doc)(_|$)/],
  ['telefono', /(^|_)(telefono|tel|celular|movil|phone|whatsapp)(_|$)/],
  ['direccion', /(^|_)(direccion|address|domicilio)(_|$)/],
  ['nombre', /(^|_)(nombre|nombres|apellido|apellidos|name|fullname|firstname|lastname|nombre_completo)(_|$)/],
  ['jefe', /(^|_)(jefe|supervisor|lider|manager|evaluador|coordinador)(_|$)/],
];
const NOT_PERSON_NAME = /cargo|departamento|area|sede|empresa|proceso|curso|capacitacion|unidad|centro|puesto|ciudad|encuesta|archivo|campana|programa|sucursal|region|equipo|turno/;
const ID_HEADER = /(^|_)(id|codigo|cod|legajo|matricula|ticket|caso|radicado|folio|consecutivo)(_|$)/;
const REASON_HEADER = /motivo|razon|causa|comentario|observacion|sugerencia|opinion|queja|feedback|descripcion|detalle|respuesta_abierta|texto|mensaje/;

const ROLE_HEADER = [
  ['rotacion', /rotacion|retiro|renuncia|salida|baja|desvincul|terminacion|attrition|turnover|egreso|despido|liquidacion|fecha_?fin|exit/],
  ['ausentismo', /ausent|falta|inasist|incapacidad|permiso|licencia|dias_?perdid|absent|ausencia|sick/],
  ['desempeno', /desempen|evaluacion|calificacion|performance|rating|puntaje|score|cumplimiento|productiv|objetivo|meta/],
  ['capacitacion', /capacit|formacion|entrenamiento|training|curso|horas_?form|certific|taller/],
  ['clima', /clima|satisfaccion|engagement|compromiso|enps|nps|bienestar|liderazgo|ambiente|comunicacion|motivacion|reconocimiento|estres|likert|encuesta|pregunta|^p\d+|^q\d+|recomendaria|orgullo/],
  ['solicitudes', /solicitud|ticket|requerimiento|peticion|pqr|request|incidencia|sla|tiempo_?(respuesta|resolucion|atencion)|resolucion/],
  ['compensacion', /salario|sueldo|compensacion|bono|nomina|pago|salary|remuneracion|incentivo/],
  ['demografia', /(^|_)(edad|genero|sexo|antiguedad|escolaridad|estado_?civil|nivel_?educativo|generacion)(_|$)/],
  ['organizacion', /departamento|area|gerencia|direccion|unidad|sede|ciudad|sucursal|region|cargo|puesto|equipo|proceso|turno|nivel_?jerarquico|centro_?costo|division|planta/],
];

function hintsFor(name) {
  const k = slug(name);
  const h = { key: k, piiKind: null, idLike: ID_HEADER.test(k), reason: REASON_HEADER.test(k), role: null };
  for (const [kind, re] of PII_HEADER) {
    if (re.test(k)) {
      if (kind === 'nombre' && NOT_PERSON_NAME.test(k)) continue;
      if (kind === 'jefe' && /(clima|liderazgo|satisfaccion|evaluacion|calificacion|apoyo|relacion|tipo|nivel|cargo|^es_|^tiene_)/.test(k)) continue;
      h.piiKind = kind; break;
    }
  }
  for (const [role, re] of ROLE_HEADER) { if (re.test(k)) { h.role = role; break; } }
  return h;
}

/* ---------------------------------------------------------------------------
 * Léxico cualitativo (código): temas y sentimiento base
 * ------------------------------------------------------------------------ */
const THEME_LEXICON = {
  liderazgo: /\b(jefe|jefa|jefes|lider\w*|supervis\w*|gerent\w*|directiv\w*|coordinador\w*|mando|mandos|autoritar\w*|microgestion\w*|favoritis\w*)\b/,
  carga_laboral: /\b(carga|sobrecarga|exceso|horas extra|extras|turnos?|presion|estres\w*|agotad\w*|agotamiento|burnout|cansanc\w*|plazos|saturad\w*|demasiado trabajo|trabajo excesivo|sin descanso|multiples funciones)\b/,
  compensacion: /\b(salari\w*|sueldo\w*|pago\w*|paga|bono\w*|bonificacion\w*|compensacion\w*|remuneracion|incremento\w*|aumento\w*|prestaciones|beneficio\w*|mal pagad\w*|ganamos|oferta salarial)\b/,
  ambiente: /\b(ambiente|clima|companer\w*|relaciones|convivencia|respeto|acoso|toxic\w*|trato|conflicto\w*|chisme\w*|discriminacion|cultura|equipo de trabajo)\b/,
  comunicacion: /\b(comunicacion|comunican|informacion|informan|transparen\w*|escuchan|escuchar|retroalimentacion|feedback|reuniones|claridad|desinformad\w*)\b/,
  desarrollo: /\b(crecimiento|ascenso\w*|promocion\w*|desarrollo|capacitacion\w*|formacion|aprendizaje|carrera|oportunidad\w*|estancad\w*|plan de carrera)\b/,
  balance_vida_trabajo: /\b(balance|flexib\w*|teletrabajo|remoto|home office|horario\w*|familia\w*|conciliacion|permiso\w*|vacacion\w*|descanso\w*|vida personal)\b/,
  reconocimiento: /\b(reconocimiento|reconocen|reconocer|valoran|valorad\w*|felicit\w*|incentivo\w*|motivacion|motivad\w*|agradec\w*|no me valoran)\b/,
  recursos_herramientas: /\b(herramienta\w*|sistema\w*|software|recurso\w*|infraestructura|espacio\w*|oficina\w*|computador\w*|insumos|materiales|equipos? de computo|tecnologia)\b/,
  seguridad_salud: /\b(seguridad|salud|accidente\w*|riesgo\w*|ergonom\w*|higiene|bienestar|psicologic\w*|ansiedad|enfermedad\w*)\b/,
};
const THEME_ENTRIES = Object.entries(THEME_LEXICON);
const POS_WORDS = new Set(('bueno buena buenos buenas excelente excelentes mejor mejores feliz contento contenta satisfecho satisfecha gusta gusto agradable apoyo apoyan apoya reconocen reconocimiento flexible flexibilidad respeto colaboracion colaborativo motivado motivada motivacion confianza orgullo comodo comoda claro clara justo justa positivo positiva genial recomiendo agradezco amable cordial unidos tranquilo estable').split(' '));
const NEG_WORDS = new Set(('malo mala malos malas pesimo pesima peor horrible insatisfecho insatisfecha estres estresante estresado agotado agotada agotamiento abuso acoso injusto injusta injusticia toxico toxica falta carencia deficiente desmotivado desmotivada desmotivacion renunciar renuncia renuncio bajo baja bajos bajas sobrecarga exceso presion miedo maltrato favoritismo desorganizacion desorden incumplen incumplimiento tension insuficiente inconforme descontento frustrado frustrante cansado cansada burnout mal').split(' '));
const NEGATORS = new Set(['no', 'nunca', 'ni', 'tampoco', 'jamas', 'sin']);
const STOPWORDS = new Set(('de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mis tu te ti tu tus ellas nosotras vosotros vosotras os mio mia mios mias tuyo tuya suyo suya nuestro nuestra son ser fue era han hacer hace tiene tienen estan esta estoy somos son debe deben puede pueden cada solo siempre ahora aqui asi aun bien donde cuando cual cuales cuanto trabajo empresa').split(' '));

function sentimentOf(nt) {
  const toks = nt.split(/[^a-z0-9]+/);
  let pos = 0, neg = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const isPos = POS_WORDS.has(t), isNeg = NEG_WORDS.has(t);
    if (!isPos && !isNeg) continue;
    const negated = (i >= 1 && NEGATORS.has(toks[i - 1])) || (i >= 2 && NEGATORS.has(toks[i - 2]));
    if (isPos) { negated ? neg++ : pos++; } else { negated ? pos++ : neg++; }
  }
  if (neg > pos) return 'neg';
  if (pos > neg) return 'pos';
  return 'neu';
}

/* ---------------------------------------------------------------------------
 * Anonimización de texto libre (PII)
 * ------------------------------------------------------------------------ */
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const RE_EMAIL_TEST = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const RE_LONGNUM = /(?<![\w])\+?\d[\d\s().-]{5,}\d(?![\w])/g;
const RE_TITLE_NAME = /\b(?:Sr\.?|Sra\.?|Srta\.?|Don|Doña|Dr\.?|Dra\.?|Ing\.?|Lic\.?|Arq\.?)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2}/g;
const RE_ROLE_NAME = /\b(?:[Jj]efe|[Jj]efa|[Ss]upervisor[a]?|[Gg]erente|[Cc]oordinador[a]?|[Dd]irector[a]?|[Ll][ií]der|[Cc]ompañer[oa]|[Cc]olega|[Aa]nalista)\s+(?:de\s+[a-záéíóúñ]+\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})?)/g;
const RE_CAP_TOKEN = /\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}\b/g;

const nameTokens = new Set(); // tokens normalizados recolectados de columnas de nombres

function scrubText(s) {
  let t = s.replace(RE_EMAIL, '[EMAIL]').replace(RE_URL, '[URL]');
  t = t.replace(RE_LONGNUM, (m) => ((m.match(/\d/g) || []).length >= 7 ? '[NUM_ID]' : m));
  t = t.replace(RE_TITLE_NAME, '[NOMBRE]');
  t = t.replace(RE_ROLE_NAME, (m, nm) => m.replace(nm, '[NOMBRE]'));
  if (nameTokens.size) {
    t = t.replace(RE_CAP_TOKEN, (tok) => {
      const k = norm(tok);
      return nameTokens.has(k) && !lexiconVocab.has(k) ? '[NOMBRE]' : tok;
    });
  }
  return t;
}
// Vocabulario del léxico: evita enmascarar palabras comunes que coinciden con nombres
const lexiconVocab = new Set([...POS_WORDS, ...NEG_WORDS, ...STOPWORDS,
  'carga', 'paz', 'luz', 'mar', 'pilar', 'rosa', 'gloria', 'esperanza', 'consuelo', 'amparo', 'victoria', 'angel', 'jefe', 'equipo']);

/* ---------------------------------------------------------------------------
 * Estadística auxiliar
 * ------------------------------------------------------------------------ */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function resAdd(a, x) {
  a.resSeen++;
  if (a.res.length < CFG.RESERVOIR) a.res.push(x);
  else {
    const j = Math.floor(rng() * a.resSeen);
    if (j < CFG.RESERVOIR) a.res[j] = x;
  }
}
function numStats(a) {
  const w = a.w;
  const sorted = a.res.slice().sort((x, y) => x - y);
  return {
    n: w.n, mean: round(w.mean, 4), sd: w.n > 1 ? round(Math.sqrt(w.m2 / (w.n - 1)), 4) : 0,
    min: w.min, max: w.max,
    p25: round(quantile(sorted, 0.25), 4), p50: round(quantile(sorted, 0.5), 4),
    p75: round(quantile(sorted, 0.75), 4), p90: round(quantile(sorted, 0.9), 4),
    approx_quantiles: a.resSeen > CFG.RESERVOIR,
  };
}
const ymKey = (y, mo) => `${y}-${String(mo).padStart(2, '0')}`;
const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

/* ---------------------------------------------------------------------------
 * Acumulador por columna (Pasada 1)
 * ------------------------------------------------------------------------ */
function newAcc(name, idx) {
  return {
    name, idx, hints: hintsFor(name), type: null,
    total: 0, missing: 0, num: 0, date: 0, bool: 0, str: 0, longStr: 0,
    w: { n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity },
    res: [], resSeen: 0, nonInt: 0, notZeroOne: 0, neg: 0, nonMono: 0, prev: undefined,
    numVals: new Set(), numBig: new Set(), bigCapAt: 0,
    dMin: Infinity, dMax: -Infinity, dAnom: 0,
    freq: new Map(), freqOverflow: false, overflowRows: 0,
    lenSum: 0, wordSum: 0, lenMax: 0,
    emailHits: 0, digitHits: 0,
  };
}
function addNum(a, x) {
  a.num++;
  const w = a.w;
  w.n++;
  const d = x - w.mean;
  w.mean += d / w.n;
  w.m2 += d * (x - w.mean);
  if (x < w.min) w.min = x;
  if (x > w.max) w.max = x;
  if (!Number.isInteger(x)) a.nonInt++;
  if (x !== 0 && x !== 1) a.notZeroOne++;
  if (x < 0) a.neg++;
  if (a.numVals.size <= 40) a.numVals.add(x);
  if (x >= 1e6 && Number.isInteger(x) && a.numBig.size < CFG.MAX_DISTINCT) {
    a.numBig.add(x);
    if (a.numBig.size === CFG.MAX_DISTINCT) a.bigCapAt = a.num;
  }
  if (a.prev !== undefined && x <= a.prev) a.nonMono++;
  a.prev = x;
  resAdd(a, x);
}
function addDate(a, d) {
  a.date++;
  if (isDateAnomaly(d)) { a.dAnom++; return; }
  if (d.ts < a.dMin) a.dMin = d.ts;
  if (d.ts > a.dMax) a.dMax = d.ts;
}
function addStr(a, v) {
  a.str++;
  const L = v.length;
  a.lenSum += L;
  if (L > a.lenMax) a.lenMax = L;
  let words = 1;
  for (let i = 0; i < L && i < 400; i++) if (v.charCodeAt(i) === 32) words++;
  a.wordSum += words;
  if (L <= 80) {
    const k = v.replace(/\s+/g, ' ').toLowerCase();
    const e = a.freq.get(k);
    if (e) e.n++;
    else if (a.freq.size < CFG.MAX_DISTINCT) a.freq.set(k, { label: v.replace(/\s+/g, ' '), n: 1 });
    else { a.freqOverflow = true; a.overflowRows++; }
  } else { a.longStr++; }
  if (v.indexOf('@') > 0 && RE_EMAIL_TEST.test(v)) a.emailHits++;
  if (a.hints.piiKind === 'direccion' && /\d/.test(v)) a.digitHits++;
  if (a.hints.piiKind === 'nombre' || a.hints.piiKind === 'jefe') collectNameTokens(v);
}
function collectNameTokens(v) {
  if (nameTokens.size >= CFG.MAX_NAME_TOKENS) return;
  for (const tok of v.split(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]+/)) {
    if (tok.length >= 3) nameTokens.add(norm(tok));
  }
}
// Devuelve true si la celda tiene dato
function ingest(a, raw) {
  a.total++;
  const v = cell(raw);
  if (isMissingCell(v)) { a.missing++; return false; }
  if (typeof v === 'number') { addNum(a, v); return true; }
  const t = classify(v);
  if (t === T_NUM) addNum(a, CL_N);
  else if (t === T_DATE) addDate(a, CL_D);
  else if (t === T_BOOL) { a.bool++; addStr(a, v); }
  else addStr(a, v);
  return true;
}

/* ---------------------------------------------------------------------------
 * Fuentes de filas: CSV por streaming y Excel en memoria
 * ------------------------------------------------------------------------ */
function detectKind(name) {
  const n = name.toLowerCase();
  if (/\.(xlsx|xlsm|xls)$/.test(n)) return 'xlsx';
  if (/\.(csv|tsv|txt)$/.test(n)) return 'csv';
  return 'csv';
}

async function detectEncoding(file) {
  const buf = await file.slice(0, 262144).arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return 'UTF-16LE';
  if (u8[0] === 0xfe && u8[1] === 0xff) return 'UTF-16BE';
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); return 'UTF-8'; }
  catch (_) { return 'windows-1252'; }
}

function csvSource(file, encoding) {
  const src = {
    kind: 'csv', encoding, delimiter: '', sheet: null, sheets: null,
    forEachRow(cb, onPct) {
      return new Promise((resolve, reject) => {
        let idx = 0;
        try {
          Papa.parse(file, {
            delimiter: src.delimiter || '',
            skipEmptyLines: 'greedy',
            encoding,
            chunkSize: CFG.CSV_CHUNK,
            chunk(res) {
              if (!src.delimiter && res.meta && res.meta.delimiter) src.delimiter = res.meta.delimiter;
              const data = res.data;
              for (let i = 0; i < data.length; i++) cb(data[i], idx++);
              if (onPct) onPct(Math.min(1, (res.meta.cursor || 0) / Math.max(1, file.size)));
            },
            complete() { resolve(idx); },
            error(err) { reject(coded('csv_parse', 'No se pudo leer el CSV: ' + (err && err.message ? err.message : err))); },
          });
        } catch (e) { reject(coded('csv_parse', 'No se pudo leer el CSV: ' + e.message)); }
      });
    },
  };
  return src;
}

async function excelSource(file) {
  try { importScripts(XLSX_URL); }
  catch (e) { throw coded('lib_xlsx', 'No se pudo cargar la librería de Excel (SheetJS). Verifica tu conexión o exporta el archivo a CSV.'); }
  progress('read', 3, 'Leyendo libro de Excel (puede tardar con archivos grandes)…', true);
  let rows, sheetName, sheets;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: true });
    sheets = wb.SheetNames.slice();
    // Se analiza la hoja con más filas
    let best = null, bestN = -1;
    for (const n of wb.SheetNames) {
      const ws = wb.Sheets[n];
      const ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
      const cnt = ref ? ref.e.r - ref.s.r + 1 : 0;
      if (cnt > bestN) { best = n; bestN = cnt; }
    }
    if (best === null) throw coded('excel_empty', 'El libro de Excel no contiene hojas.');
    sheetName = best;
    rows = XLSX.utils.sheet_to_json(wb.Sheets[best], { header: 1, raw: true, defval: '', blankrows: false });
  } catch (e) {
    if (e && e.code) throw e;
    if (e instanceof RangeError) throw coded('oom', 'El archivo de Excel es demasiado grande para la memoria del navegador. Expórtalo a CSV e inténtalo de nuevo.');
    throw coded('excel_parse', 'No se pudo leer el archivo de Excel: ' + (e && e.message ? e.message : e));
  }
  return {
    kind: 'xlsx', encoding: null, delimiter: null, sheet: sheetName, sheets,
    async forEachRow(cb, onPct) {
      const n = rows.length;
      for (let i = 0; i < n; i++) {
        cb(rows[i], i);
        if (onPct && (i & 0x3fff) === 0) onPct(i / n);
      }
      if (onPct) onPct(1);
      return n;
    },
  };
}

/* ---------------------------------------------------------------------------
 * PASADA 1: encabezado, perfilado de columnas, duplicados, nombres propios
 * ------------------------------------------------------------------------ */
function pickHeaderRow(buf) {
  let best = 0, bestScore = -1;
  buf.forEach((row, i) => {
    let score = 0;
    for (const c of row) {
      const v = cell(c);
      if (isMissingCell(v)) continue;
      if (typeof v === 'number') continue;
      const cc = v.charCodeAt(0);
      const digitish = (cc >= 48 && cc <= 57) || cc === 45 || cc === 43 || cc === 36;
      if (digitish && (parseNum(v) !== null || parseDate(v))) continue;
      score++;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

class Pass1 {
  constructor() {
    this.buf = []; this.headerRow = -1; this.accs = null; this.ncols = 0;
    this.rowsData = 0; this.emptyRows = 0; this.dupSet = new Set(); this.dups = 0; this.dupOverflow = false;
    this.skippedPreamble = 0; this.longRows = 0;
  }
  push(row, idx) {
    if (this.headerRow < 0) {
      this.buf.push(row);
      if (this.buf.length >= CFG.HEADER_SCAN_ROWS) this.decideHeader();
      return;
    }
    this.ingestRow(row);
  }
  finish() { if (this.headerRow < 0) this.decideHeader(); }
  decideHeader() {
    if (!this.buf.length) { this.headerRow = 0; this.accs = []; return; }
    const h = pickHeaderRow(this.buf);
    this.headerRow = h;
    this.skippedPreamble = h;
    let ncols = 0;
    for (const r of this.buf) if (r.length > ncols) ncols = r.length;
    ncols = Math.min(ncols, CFG.MAX_COLUMNS);
    this.ncols = ncols;
    const used = new Set();
    this.accs = [];
    for (let i = 0; i < ncols; i++) {
      let nm = cell(this.buf[h][i]);
      nm = (typeof nm === 'number' ? String(nm) : nm).replace(/\s+/g, ' ').trim();
      if (isMissingCell(nm) || nm === '') nm = `columna_${i + 1}`;
      let base = nm, k = 2;
      while (used.has(nm.toLowerCase())) nm = `${base}_${k++}`;
      used.add(nm.toLowerCase());
      this.accs.push(newAcc(nm, i));
    }
    for (let i = h + 1; i < this.buf.length; i++) this.ingestRow(this.buf[i]);
    this.buf = [];
  }
  ingestRow(row) {
    let present = 0;
    const n = this.ncols;
    for (let i = 0; i < n; i++) if (ingest(this.accs[i], row[i])) present++;
    if (row.length > n) this.longRows++;
    if (present === 0) {
      for (let i = 0; i < n; i++) { this.accs[i].total--; this.accs[i].missing--; }
      this.emptyRows++;
      return;
    }
    this.rowsData++;
    if (this.dupSet.size < CFG.MAX_DUP_TRACK) {
      const key = cyrb53(row.length === n ? row.join('\u0001') : row.slice(0, n).join('\u0001'));
      if (this.dupSet.has(key)) this.dups++; else this.dupSet.add(key);
    } else { this.dupOverflow = true; }
  }
}

/* ---------------------------------------------------------------------------
 * Inferencia de tipo por columna
 * ------------------------------------------------------------------------ */
function inferType(a) {
  const nm = a.total - a.missing;
  a.nonMissing = nm;
  const h = a.hints;
  if (nm <= 0) return 'empty';
  // "Dirección" puede ser una unidad organizacional: solo es PII si los valores parecen direcciones (con dígitos)
  if (h.piiKind === 'direccion' && a.digitHits / Math.max(1, a.str) < 0.3) h.piiKind = null;
  if (h.piiKind) return 'pii';
  if (a.emailHits / nm > 0.3) return 'pii';
  const pNum = a.num / nm, pDate = a.date / nm, pBool = a.bool / nm;
  if (pDate >= 0.6) return 'date';
  if (pBool >= 0.9) return 'boolean';
  if (pNum >= 0.6) {
    if (a.numVals.size <= 2 && a.notZeroOne === 0) return 'boolean';
    // Enteros de 7+ dígitos casi únicos => documentos/teléfonos (no salarios)
    if (a.nonInt === 0 && a.w.min >= 1e6 && h.role !== 'compensacion') {
      const uniqueLike = a.bigCapAt > 0 ? a.bigCapAt <= CFG.MAX_DISTINCT * 1.2 : (a.numBig.size / Math.max(1, a.num) >= 0.95 && a.num >= 20);
      if (uniqueLike) return 'pii';
    }
    if (a.nonInt === 0 && h.idLike && a.numVals.size > 40) return 'identifier';
    if (a.nonInt === 0 && a.nonMono === 0 && a.num > 50 && a.numVals.size > 40) return 'identifier';
    const noScaleRole = ['ausentismo', 'capacitacion', 'solicitudes', 'compensacion', 'demografia'].includes(h.role);
    if (a.nonInt === 0 && a.numVals.size <= 11 && a.w.min >= 0 && a.w.max <= 10 && !noScaleRole) return 'scale';
    return 'numeric';
  }
  if (pNum >= 0.3 || pDate >= 0.3) return 'ambiguous';
  // Columnas de texto
  const strN = Math.max(1, a.str);
  const avgLen = a.lenSum / strN, avgWords = a.wordSum / strN;
  const distinct = a.freq.size + (a.freqOverflow ? a.overflowRows : 0);
  const ratio = distinct / strN;
  a.avgLen = avgLen; a.avgWords = avgWords; a.distinct = distinct;
  if (avgLen >= 40 || avgWords >= 6 || a.longStr / strN > 0.2) return 'text';
  if (h.reason && avgLen >= 18 && ratio > 0.3) return 'text';
  if (h.idLike && ratio >= 0.8) return 'identifier';
  if (ratio >= 0.95 && a.str >= 30) return 'identifier';
  if (distinct <= 60 && (ratio <= 0.5 || distinct <= 25)) return 'categorical';
  if (distinct <= 200 && ratio <= 0.3) return 'categorical';
  return avgLen >= 14 ? 'text' : 'identifier';
}

const EXIT_VALUE = /(retir|renunci|baja|desvinc|terminad|inactiv|despid|salid|egres|finaliz|cesad|liquidad)/;

function topValues(a, k = 12) {
  const arr = [...a.freq.values()].sort((x, y) => y.n - x.n).slice(0, k);
  const base = Math.max(1, a.str);
  return arr.map((e) => ({ value: e.label, n: e.n, pct: round((100 * e.n) / base, 1) }));
}

function profileOf(a, rows) {
  const p = {
    name: a.name, index: a.idx, type: a.type,
    missing_pct: round((100 * a.missing) / Math.max(1, a.total), 1),
    non_missing: a.nonMissing, role_hint: a.hints.role,
  };
  switch (a.type) {
    case 'pii':
      p.masked = true; p.pii_kind = a.hints.piiKind || (a.emailHits ? 'email' : 'documento_o_telefono'); delete p.non_missing; break;
    case 'numeric': case 'scale':
      p.stats = numStats(a);
      if (a.num / a.nonMissing < 0.98) p.non_numeric_pct = round(100 * (1 - a.num / a.nonMissing), 1);
      if (a.neg) p.negative_values = a.neg;
      break;
    case 'boolean': {
      if (a.str) {
        const yes = [...a.freq.values()].filter((e) => BOOL_T.has(e.label.toLowerCase())).reduce((s, e) => s + e.n, 0);
        p.true_pct = round((100 * yes) / a.str, 1);
      } else p.true_pct = round(100 * a.w.mean, 1);
      break;
    }
    case 'date':
      p.date_range = a.dMin <= a.dMax ? { min: isoDay(a.dMin), max: isoDay(a.dMax) } : null;
      if (a.dAnom) p.date_anomalies = a.dAnom;
      break;
    case 'categorical':
      p.distinct = a.distinct; p.top_values = topValues(a, 10);
      if (a.hints.reason && (a.lenSum / Math.max(1, a.str)) >= 8) p.reason_category = true;
      break;
    case 'text':
      p.avg_len = round(a.lenSum / Math.max(1, a.str), 1); p.avg_words = round(a.wordSum / Math.max(1, a.str), 1); break;
    case 'identifier':
      p.note = 'identificador/alta cardinalidad: excluido de análisis y no enviado'; break;
    case 'ambiguous':
      p.note = 'tipo mixto (30%-60% convertible): excluido de cálculos'; break;
    default: break;
  }
  return p;
}

/* ---------------------------------------------------------------------------
 * Planificación de dimensiones y medidas
 * ------------------------------------------------------------------------ */
function planDimensions(accs) {
  const cands = accs.filter((a) => a.type === 'categorical' && !(a.hints.reason && a.lenSum / Math.max(1, a.str) >= 8) && a.distinct >= 2);
  const score = (a) => {
    let s = 0;
    if (a.hints.role === 'organizacion') s += 4;
    // La unidad organizacional principal (departamento/área/gerencia) va primero: es la llave de cruce con el texto
    if (/(departamento|area|gerencia|unidad|division|proceso|direccion)/.test(a.hints.key)) s += 2;
    else if (/(sede|ciudad|region|sucursal|planta)/.test(a.hints.key)) s += 1;
    if (a.hints.role === 'demografia') s += 2;
    if (a.distinct >= 3 && a.distinct <= 20) s += 2; else if (a.distinct === 2) s += 1;
    if (a.missing / Math.max(1, a.total) < 0.1) s += 1;
    return s - a.distinct / 1000;
  };
  cands.sort((x, y) => score(y) - score(x));
  const dims = [];
  for (const a of cands.slice(0, CFG.MAX_DIMS)) {
    const entries = [...a.freq.entries()].sort((x, y) => y[1].n - x[1].n);
    const map = new Map();
    const groups = [];
    let keptN = 0;
    for (const [key, e] of entries) {
      if (groups.length >= CFG.MAX_GROUPS || e.n < CFG.MIN_GROUP) break;
      map.set(key, groups.length);
      groups.push({ label: e.label, n: e.n });
      keptN += e.n;
    }
    const otherN = a.str - keptN;
    let otherIdx = -1;
    if (otherN > 0) { otherIdx = groups.length; groups.push({ label: CFG.OTHER_LABEL, n: otherN }); }
    if (groups.length < 2) continue;
    dims.push({ col: a.idx, column: a.name, map, groups, otherIdx, role_hint: a.hints.role, missing_n: a.missing });
  }
  return dims;
}

function makeNumGet() {
  return (raw) => {
    const v = cell(raw);
    if (isMissingCell(v)) return null;
    if (typeof v === 'number') return v;
    return classify(v) === T_NUM ? CL_N : null;
  };
}
function makeBoolGet() {
  return (raw) => {
    const v = cell(raw);
    if (isMissingCell(v)) return null;
    if (typeof v === 'number') return v === 1 ? 1 : v === 0 ? 0 : null;
    const b = parseBool(v);
    if (b !== null) return b ? 1 : 0;
    const t = classify(v);
    if (t === T_NUM) return CL_N === 1 ? 1 : CL_N === 0 ? 0 : null;
    return null;
  };
}

const ROLE_PRIO = { desempeno: 1, clima: 1, ausentismo: 2, rotacion: 2, capacitacion: 3, solicitudes: 3, compensacion: 4 };

function planMeasures(accs) {
  const numeric = [], binary = [];
  for (const a of accs) {
    const prio = ROLE_PRIO[a.hints.role] || 5;
    if (a.type === 'numeric' || a.type === 'scale') {
      const m = {
        col: a.idx, column: a.name, kind: a.type === 'scale' ? 'scale' : 'numeric', role_hint: a.hints.role,
        label_base: pretty(a.name), flag_desc: null, prio, nonMissing: a.nonMissing, get: makeNumGet(),
      };
      if (a.type === 'scale') {
        const M = a.w.max <= 5 ? 5 : a.w.max <= 7 ? 7 : 10;
        m.scale = { min: a.w.min >= 1 ? 1 : 0, max: M, favorable_from: M <= 7 ? M - 1 : M - 2 };
      }
      numeric.push(m);
    } else if (a.type === 'boolean') {
      binary.push({
        col: a.idx, column: a.name, kind: 'binary', role_hint: a.hints.role, label_base: pretty(a.name),
        flag_desc: `${pretty(a.name)} = Sí`, prio, nonMissing: a.nonMissing, get: makeBoolGet(),
      });
    } else if (a.type === 'date' && a.hints.role === 'rotacion') {
      // Fecha de retiro/salida: tener fecha = registro con salida
      binary.push({
        col: a.idx, column: a.name, kind: 'binary', role_hint: 'rotacion', label_base: pretty(a.name),
        flag_desc: `registros con ${pretty(a.name)} diligenciada`, prio: 2, nonMissing: a.total,
        get: (raw) => (isMissingCell(cell(raw)) ? 0 : 1),
      });
    } else if (a.type === 'categorical' && !a.hints.reason && (a.hints.role === 'rotacion' || /(^|_)(estado|status|situacion|condicion)(_|$)/.test(a.hints.key))) {
      const exitVals = new Set();
      for (const [k] of a.freq) if (EXIT_VALUE.test(norm(k))) exitVals.add(k);
      if (exitVals.size && exitVals.size < a.freq.size) {
        const labels = [...exitVals].map((k) => a.freq.get(k).label);
        binary.push({
          col: a.idx, column: a.name, kind: 'binary', role_hint: 'rotacion', label_base: pretty(a.name),
          flag_desc: `${pretty(a.name)} = ${labels.slice(0, 3).join(' / ')}`, prio: 2, nonMissing: a.nonMissing,
          get: (raw) => {
            const v = cell(raw);
            if (isMissingCell(v)) return null;
            return exitVals.has(String(v).replace(/\s+/g, ' ').toLowerCase()) ? 1 : 0;
          },
        });
      }
    }
  }
  numeric.sort((x, y) => x.prio - y.prio || y.nonMissing - x.nonMissing);
  binary.sort((x, y) => x.prio - y.prio || y.nonMissing - x.nonMissing);
  const list = [...numeric.slice(0, CFG.MAX_NUM_MEASURES), ...binary.slice(0, CFG.MAX_BIN_MEASURES)];
  list.forEach((m, i) => { m.id = `meas_${String(i + 1).padStart(2, '0')}`; });
  return list;
}

function planTextColumns(accs) {
  const list = [];
  for (const a of accs) {
    const reasonCat = a.type === 'categorical' && a.hints.reason && a.lenSum / Math.max(1, a.str) >= 8;
    if (a.type === 'text' || reasonCat) {
      list.push({ col: a.idx, column: a.name, kind: reasonCat ? 'reason_category' : 'free_text', acc: a, hinted: a.hints.reason ? 1 : 0 });
    }
  }
  list.sort((x, y) => y.hinted - x.hinted || y.acc.nonMissing - x.acc.nonMissing);
  return list.slice(0, CFG.MAX_TEXT_COLS);
}

/* ---------------------------------------------------------------------------
 * PASADA 2: agregados por grupo, series, correlaciones y texto cualitativo
 * ------------------------------------------------------------------------ */
class Pass2 {
  constructor(plan, headerRow, ncols) {
    this.plan = plan; this.headerRow = headerRow; this.ncols = ncols;
    const { dims, measures, textCols } = plan;
    const M = measures.length;
    this.overall = measures.map(() => ({ n: 0, sum: 0, sumsq: 0, fav: 0, out: 0 }));
    this.agg = dims.map((d) => measures.map(() => ({
      n: new Float64Array(d.groups.length), s: new Float64Array(d.groups.length),
      q: new Float64Array(d.groups.length), f: new Float64Array(d.groups.length),
    })));
    this.vals = new Array(M).fill(null);
    this.gidx = new Array(dims.length).fill(-1);
    this.rowsSeen = 0;

    // Rangos para outliers (Tukey 1.5 IQR) a partir de la pasada 1
    this.fence = measures.map((m) => {
      if (m.kind === 'binary') return null;
      const st = plan.accs[m.col].stats;
      if (!st || st.p25 === null || st.p75 === null) return null;
      const iqr = st.p75 - st.p25;
      return iqr > 0 ? [st.p25 - 1.5 * iqr, st.p75 + 1.5 * iqr] : null;
    });

    // Series temporales: fecha principal = columna fecha no-rotación con más datos
    const dateAccs = plan.accs.filter((a) => a.type === 'date' && a.dMin <= a.dMax);
    const primary = dateAccs.filter((a) => a.hints.role !== 'rotacion').sort((x, y) => y.nonMissing - x.nonMissing)[0] || dateAccs.sort((x, y) => y.nonMissing - x.nonMissing)[0] || null;
    this.primaryDate = primary ? primary.idx : -1;
    this.otherDates = dateAccs.filter((a) => a !== primary).slice(0, 3).map((a) => a.idx);
    this.seriesMeasures = [];
    measures.forEach((m, j) => { if (m.kind !== 'binary' && this.seriesMeasures.length < 4) this.seriesMeasures.push(j); });
    measures.forEach((m, j) => { if (m.kind === 'binary' && this.seriesMeasures.length < 7) this.seriesMeasures.push(j); });
    this.monthly = new Map();                       // fecha principal: ym -> {n, s[], c[]}
    this.otherMonthly = new Map(this.otherDates.map((i) => [i, new Map()]));
    this.dateAnomalies = 0;

    // Correlaciones entre las primeras CORR_VARS medidas
    this.corrIdx = measures.map((m, j) => j).slice(0, CFG.CORR_VARS);
    const K = this.corrIdx.length;
    this.pairs = [];
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) this.pairs.push({ a: this.corrIdx[a], b: this.corrIdx[b], n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 });

    // Texto cualitativo
    this.texts = textCols.map((t) => ({
      ...t, nTexts: 0, lenSum: 0, sent: { pos: 0, neg: 0, neu: 0 }, noTheme: 0,
      themes: Object.fromEntries(THEME_ENTRIES.map(([k]) => [k, { n: 0, neg: 0, pos: 0 }])),
      byGroup: new Map(), terms: new Map(),
      res: new Map(),   // muestreo ESTRATIFICADO: un reservorio por grupo (ver pushTexts)
    }));
    // Capacidad por grupo: reparte el presupuesto de comentarios entre los grupos para que cada uno quede representado
    this.groupCap = dims.length ? Math.max(8, Math.floor(CFG.TEXT_SAMPLES_PER_COL / dims[0].groups.length)) : CFG.TEXT_SAMPLES_PER_COL;
  }

  push(row) {
    const { dims, measures } = this.plan;
    this.rowsSeen++;
    // Grupos
    for (let d = 0; d < dims.length; d++) {
      const v = cell(row[dims[d].col]);
      if (isMissingCell(v)) { this.gidx[d] = -1; continue; }
      const key = String(v).replace(/\s+/g, ' ').toLowerCase();
      const gi = dims[d].map.get(key);
      this.gidx[d] = gi !== undefined ? gi : dims[d].otherIdx;
    }
    // Medidas
    for (let j = 0; j < measures.length; j++) {
      const x = measures[j].get(row[measures[j].col]);
      this.vals[j] = x;
      if (x === null) continue;
      const o = this.overall[j];
      o.n++; o.sum += x; o.sumsq += x * x;
      let fav = 0;
      const sc = measures[j].scale;
      if (sc && x >= sc.favorable_from) { fav = 1; o.fav++; }
      const fe = this.fence[j];
      if (fe && (x < fe[0] || x > fe[1])) o.out++;
      for (let d = 0; d < dims.length; d++) {
        const g = this.gidx[d];
        if (g < 0) continue;
        const A = this.agg[d][j];
        A.n[g]++; A.s[g] += x; A.q[g] += x * x; A.f[g] += fav;
      }
    }
    // Correlaciones (pares completos)
    for (const p of this.pairs) {
      const x = this.vals[p.a], y = this.vals[p.b];
      if (x === null || y === null) continue;
      p.n++; p.sx += x; p.sy += y; p.sxx += x * x; p.syy += y * y; p.sxy += x * y;
    }
    // Serie temporal
    if (this.primaryDate >= 0) {
      const dv = cell(row[this.primaryDate]);
      if (typeof dv === 'string' && dv !== '') {
        const pd = (dv.length >= 6 && dv.length <= 30) ? parseDate(dv) : null;
        if (pd) {
          if (isDateAnomaly(pd)) this.dateAnomalies++;
          else {
            const k = ymKey(pd.y, pd.mo);
            let e = this.monthly.get(k);
            if (!e) { e = { n: 0, s: new Float64Array(this.seriesMeasures.length), c: new Float64Array(this.seriesMeasures.length) }; this.monthly.set(k, e); }
            e.n++;
            for (let q = 0; q < this.seriesMeasures.length; q++) {
              const x = this.vals[this.seriesMeasures[q]];
              if (x !== null) { e.s[q] += x; e.c[q]++; }
            }
          }
        }
      }
    }
    for (const di of this.otherDates) {
      const dv = cell(row[di]);
      if (typeof dv === 'string' && dv !== '' && dv.length >= 6 && dv.length <= 30) {
        const pd = parseDate(dv);
        if (pd && !isDateAnomaly(pd)) {
          const m = this.otherMonthly.get(di);
          const k = ymKey(pd.y, pd.mo);
          m.set(k, (m.get(k) || 0) + 1);
        } else if (pd) this.dateAnomalies++;
      }
    }
    // Texto
    if (this.texts.length) this.pushTexts(row);
  }

  pushTexts(row) {
    const { dims } = this.plan;
    const g0 = dims.length ? this.gidx[0] : -1;
    const gLabel = g0 >= 0 ? dims[0].groups[g0].label : null;
    for (const tc of this.texts) {
      const v = cell(row[tc.col]);
      if (isMissingCell(v)) continue;
      const s = typeof v === 'string' ? v : String(v);
      tc.nTexts++; tc.lenSum += s.length;
      const nt = norm(s);
      const themes = [];
      for (const [k, re] of THEME_ENTRIES) if (re.test(nt)) themes.push(k);
      const sent = sentimentOf(nt);
      tc.sent[sent]++;
      if (!themes.length) tc.noTheme++;
      for (const t of themes) { const e = tc.themes[t]; e.n++; if (sent === 'neg') e.neg++; else if (sent === 'pos') e.pos++; }
      if (gLabel !== null) {
        let gb = tc.byGroup.get(gLabel);
        if (!gb) { gb = { n: 0, sent: { pos: 0, neg: 0, neu: 0 }, themes: {} }; tc.byGroup.set(gLabel, gb); }
        gb.n++; gb.sent[sent]++;
        for (const t of themes) { const e = gb.themes[t] || (gb.themes[t] = { n: 0, neg: 0 }); e.n++; if (sent === 'neg') e.neg++; }
      }
      // Términos frecuentes (sin nombres propios)
      for (const tok of nt.split(/[^a-z0-9]+/)) {
        if (tok.length < 4 || STOPWORDS.has(tok) || nameTokens.has(tok) || /^\d+$/.test(tok)) continue;
        if (tc.terms.size < 30000 || tc.terms.has(tok)) tc.terms.set(tok, (tc.terms.get(tok) || 0) + 1);
      }
      // Muestreo por reservorio ESTRATIFICADO por grupo (las categorías de motivo se resumen aparte).
      // Cada grupo conserva sus propios comentarios; el peso (visto/conservado) permite estimar porcentajes del total
      // sin que los grupos grandes tapen a los pequeños y haciendo comparables los grupos entre sí.
      if (tc.kind === 'free_text' && s.length >= 8) {
        const key = gLabel === null ? '\u0000' : gLabel;
        let r = tc.res.get(key);
        if (!r) { r = { seen: 0, items: [] }; tc.res.set(key, r); }
        r.seen++;
        const cap = !dims.length ? CFG.TEXT_SAMPLES_PER_COL : (gLabel === null ? 12 : this.groupCap);
        let slot = -1;
        if (r.items.length < cap) slot = r.items.length;
        else { const j = Math.floor(rng() * r.seen); if (j < cap) slot = j; }
        if (slot >= 0) {
          let clean = scrubText(s).replace(/\s+/g, ' ');
          if (clean.length > CFG.TEXT_SAMPLE_MAX_CHARS) clean = clean.slice(0, CFG.TEXT_SAMPLE_MAX_CHARS) + '…';
          r.items[slot] = { text: clean, group: gLabel, lex: { themes, sent }, weight: 1 };
        }
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * Ensamblado del resumen final
 * ------------------------------------------------------------------------ */
function buildMeasureOutput(p2, accs) {
  const { dims, measures } = p2.plan;
  return measures.map((m, j) => {
    const o = p2.overall[j];
    const nOv = o.n;
    const mean = nOv ? o.sum / nOv : null;
    const sd = nOv > 1 ? Math.sqrt(Math.max(0, (o.sumsq - (o.sum * o.sum) / nOv) / (nOv - 1))) : 0;
    const overall = { n: nOv };
    if (m.kind === 'binary') { overall.pos = o.sum; overall.rate_pct = nOv ? round((100 * o.sum) / nOv, 2) : null; }
    else {
      const st = accs[m.col].stats;
      Object.assign(overall, { mean: round(mean, 4), sd: round(sd, 4), min: st.min, max: st.max, p25: st.p25, p50: st.p50, p75: st.p75, p90: st.p90 });
      if (m.scale) overall.favorable_pct = nOv ? round((100 * o.fav) / nOv, 2) : null;
      overall.outliers_pct = nOv ? round((100 * o.out) / nOv, 2) : null;
    }
    const by = dims.map((d, di) => {
      const A = p2.agg[di][j];
      const groups = [];
      d.groups.forEach((g, gi) => {
        const n = A.n[gi];
        if (!n) return;
        const gm = A.s[gi] / n;
        const row = { group: g.label, n };
        if (m.kind === 'binary') { row.pos = A.s[gi]; row.rate_pct = round(100 * gm, 2); }
        else {
          const gsd = n > 1 ? Math.sqrt(Math.max(0, (A.q[gi] - (A.s[gi] * A.s[gi]) / n) / (n - 1))) : 0;
          row.mean = round(gm, 4); row.sd = round(gsd, 4);
          if (m.scale) row.favorable_pct = round((100 * A.f[gi]) / n, 2);
        }
        groups.push(row);
      });
      return { dimension: d.column, groups };
    });
    return {
      id: m.id, column: m.column, kind: m.kind, role_hint: m.role_hint, label_base: m.label_base,
      flag_desc: m.flag_desc, scale: m.scale || null, overall, by_dimension: by,
    };
  });
}

function buildCorrelations(p2, measuresOut) {
  const out = [];
  for (const p of p2.pairs) {
    if (p.n < 30) continue;
    const cov = p.sxy - (p.sx * p.sy) / p.n;
    const vx = p.sxx - (p.sx * p.sx) / p.n, vy = p.syy - (p.sy * p.sy) / p.n;
    if (vx <= 1e-12 || vy <= 1e-12) continue;
    const r = cov / Math.sqrt(vx * vy);
    if (!Number.isFinite(r)) continue;
    out.push({ a: measuresOut[p.a].id, b: measuresOut[p.b].id, r: round(r, 3), n: p.n });
  }
  out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return out.slice(0, 15);
}

function buildTimeSeries(p2, measuresOut) {
  const series = [];
  const sortedKeys = [...p2.monthly.keys()].sort();
  if (p2.primaryDate >= 0 && sortedKeys.length >= 2) {
    const keys = sortedKeys.slice(-CFG.MAX_SERIES_POINTS);
    const accName = p2.plan.accs[p2.primaryDate].name;
    series.push({
      date_column: accName, role_hint: p2.plan.accs[p2.primaryDate].hints.role, granularity: 'month',
      series_measures: p2.seriesMeasures.map((j) => measuresOut[j].id),
      points: keys.map((k) => {
        const e = p2.monthly.get(k);
        const values = {};
        p2.seriesMeasures.forEach((j, q) => {
          if (!e.c[q]) return;
          const m = measuresOut[j];
          values[m.id] = round(m.kind === 'binary' ? (100 * e.s[q]) / e.c[q] : e.s[q] / e.c[q], 3);
        });
        return { period: k, n: e.n, values };
      }),
    });
  }
  for (const [di, mp] of p2.otherMonthly) {
    const keys = [...mp.keys()].sort();
    if (keys.length < 2) continue;
    series.push({
      date_column: p2.plan.accs[di].name, role_hint: p2.plan.accs[di].hints.role, granularity: 'month', series_measures: [],
      points: keys.slice(-CFG.MAX_SERIES_POINTS).map((k) => ({ period: k, n: mp.get(k), values: {} })),
    });
  }
  return series;
}

function buildTextOutput(p2) {
  const cols = p2.texts.map((tc) => {
    const terms = [...tc.terms.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([t, n]) => ({ term: t, n }));
    // Comentarios libres: se aplanan los reservorios por grupo asignando peso = comentarios vistos / conservados
    let samples = [];
    for (const r of tc.res.values()) {
      const w = r.items.length ? Math.round((r.seen / r.items.length) * 100) / 100 : 1;
      for (const it of r.items) if (it) samples.push({ ...it, weight: w });
    }
    if (tc.kind === 'reason_category') {
      samples = topValues(tc.acc, 40).map((v) => {
        const nt = norm(v.value);
        const themes = THEME_ENTRIES.filter(([, re]) => re.test(nt)).map(([k]) => k);
        return { text: scrubText(v.value), group: null, lex: { themes, sent: sentimentOf(nt) }, weight: v.n };
      });
    }
    const byGroup = [...tc.byGroup.entries()].filter(([, g]) => g.n >= CFG.MIN_GROUP).sort((x, y) => y[1].n - x[1].n).slice(0, CFG.MAX_GROUPS)
      .map(([group, g]) => ({ group, n_texts: g.n, sentiment: g.sent, themes: g.themes }));
    return {
      column: tc.column, kind: tc.kind, n_texts: tc.nTexts, avg_len: tc.nTexts ? round(tc.lenSum / tc.nTexts, 1) : 0,
      distinct_texts: tc.kind === 'reason_category' ? tc.acc.distinct : undefined,
      lexicon: { theme_counts: tc.themes, no_theme: tc.noTheme, sentiment: tc.sent },
      top_terms: terms, by_group: byGroup, samples,
    };
  });
  return {
    columns: cols,
    lexicon_themes: THEME_ENTRIES.map(([k]) => k),
    note: 'Los comentarios están anonimizados (correos, teléfonos, documentos y nombres propios reemplazados por marcadores).',
  };
}

/* ---------------------------------------------------------------------------
 * Orquestación del worker
 * ------------------------------------------------------------------------ */
async function processFile(file, opts) {
  if (papaError) throw coded('lib_papaparse', 'No se pudo cargar PapaParse desde el CDN. Verifica tu conexión a internet.');
  if (!file || typeof file.size !== 'number') throw coded('no_file', 'No se recibió ningún archivo.');
  if (file.size === 0) throw coded('empty_file', 'El archivo está vacío.');
  const t0 = performance.now();
  nameTokens.clear();
  const kind = detectKind(file.name);

  progress('read', 1, 'Preparando lectura…', true);
  const src = kind === 'xlsx' ? await excelSource(file) : csvSource(file, await detectEncoding(file));

  // ---- Pasada 1: perfilado
  const tPass1 = performance.now();
  const p1 = new Pass1();
  const totalRows1 = await src.forEachRow(
    (row, i) => p1.push(row, i),
    (f) => progress('pass1', 2 + f * 43, `Pasada 1/2 · perfilando columnas (${Math.round(f * 100)}%)…`),
  );
  p1.finish();
  if (!p1.accs || !p1.accs.length || p1.rowsData === 0) {
    throw coded('no_data', 'No se encontraron filas de datos en el archivo. Verifica que tenga encabezados y registros.');
  }
  progress('pass1', 46, 'Detectando tipos de columnas y datos personales…', true);
  const accs = p1.accs;
  for (const a of accs) {
    a.type = inferType(a);
    if (a.type === 'numeric' || a.type === 'scale') a.stats = numStats(a);
  }
  const columns = accs.map((a) => profileOf(a, p1.rowsData));

  // ---- Planificación
  const dims = planDimensions(accs);
  const measures = planMeasures(accs);
  const textCols = planTextColumns(accs);
  const plan = { dims, measures, textCols, accs };

  // ---- Pasada 2: agregados
  const tPass2 = performance.now();
  const pass1Ms = Math.round(tPass2 - tPass1);
  const p2 = new Pass2(plan, p1.headerRow, p1.ncols);
  await src.forEachRow(
    (row, i) => {
      if (i <= p1.headerRow) return;
      // omitir filas totalmente vacías (consistente con la pasada 1)
      let any = false;
      for (let c = 0; c < p1.ncols; c++) { if (!isMissingCell(cell(row[c]))) { any = true; break; } }
      if (any) p2.push(row);
    },
    (f) => progress('pass2', 47 + f * 45, `Pasada 2/2 · calculando métricas (${Math.round(f * 100)}%)…`),
  );
  progress('finalize', 94, 'Consolidando resumen estadístico…', true);

  const measuresOut = buildMeasureOutput(p2, accs);
  const correlations = buildCorrelations(p2, measuresOut);
  const timeSeries = buildTimeSeries(p2, measuresOut);
  const text = buildTextOutput(p2);

  const rows = p1.rowsData;
  const piiCols = columns.filter((c) => c.type === 'pii').map((c) => ({ column: c.name, kind: c.pii_kind }));
  const totalTexts = text.columns.reduce((s, c) => s + c.n_texts, 0);
  const emptyCols = columns.filter((c) => c.type === 'empty').map((c) => c.name);
  const missingCells = accs.reduce((s, a) => s + a.missing, 0);
  const notes = [];
  if (p1.skippedPreamble > 0) notes.push(`Se omitieron ${p1.skippedPreamble} fila(s) de título sobre el encabezado.`);
  if (emptyCols.length) notes.push(`Columnas vacías ignoradas: ${emptyCols.join(', ')}.`);
  if (p1.emptyRows) notes.push(`${p1.emptyRows} fila(s) vacías descartadas.`);
  if (p1.dups) notes.push(`${p1.dups} fila(s) duplicadas exactas detectadas (no se eliminaron del cálculo).`);
  if (p1.dupOverflow) notes.push('El control de duplicados se limitó a las primeras 2.000.000 filas.');
  const dateAnomalyTotal = accs.reduce((s, a) => s + a.dAnom, 0); // la pasada 1 ya cuenta todas las celdas fecha fuera de rango
  if (dateAnomalyTotal > 0) notes.push('Se detectaron fechas fuera de rango (antes de 1950 o más de un año en el futuro); se excluyeron de las series.');
  if (accs.some((a) => a.type === 'ambiguous')) notes.push('Hay columnas de tipo mixto excluidas de los cálculos.');
  if (p1.ncols >= CFG.MAX_COLUMNS) notes.push(`Se analizaron solo las primeras ${CFG.MAX_COLUMNS} columnas.`);
  if (p1.longRows) notes.push(`${p1.longRows} fila(s) con más celdas que el encabezado: las columnas sobrantes se ignoraron.`);
  const privacyBlocks = piiCols.length ? `${piiCols.length} columna(s) de datos personales enmascaradas.` : null;

  const summary = {
    version: '1.0',
    file: {
      name: file.name, size_bytes: file.size, size_mb: round(file.size / 1048576, 2), kind: src.kind,
      encoding: src.encoding, delimiter: src.delimiter, sheet: src.sheet, sheets: src.sheets,
      header_row_index: p1.headerRow, rows, columns: accs.length,
    },
    processing: {
      duration_ms: Math.round(performance.now() - t0), pass1_ms: pass1Ms, pass2_ms: Math.round(performance.now() - tPass2), passes: 2,
      mode: src.kind === 'csv' ? 'streaming' : 'in_memory', pii_masked_columns: piiCols,
      min_group_size: CFG.MIN_GROUP, name_tokens_used_for_scrubbing: nameTokens.size,
      privacy_note: privacyBlocks,
    },
    quality: {
      missing_overall_pct: round((100 * missingCells) / Math.max(1, rows * accs.length), 2),
      duplicate_rows: p1.dups, empty_rows: p1.emptyRows, empty_columns: emptyCols,
      date_anomalies: dateAnomalyTotal, notes,
    },
    columns,
    dimensions: dims.map((d) => ({
      column: d.column, role_hint: d.role_hint, missing_n: d.missing_n,
      groups: d.groups.map((g) => ({ label: g.label, n: g.n })),
    })),
    measures: measuresOut,
    correlations,
    time_series: timeSeries,
    text,
    evidence: {
      quantitative: {
        measures: measuresOut.length,
        scale_measures: measuresOut.filter((m) => m.kind === 'scale').length,
        binary_measures: measuresOut.filter((m) => m.kind === 'binary').length,
        numeric_measures: measuresOut.filter((m) => m.kind === 'numeric').length,
        date_columns: columns.filter((c) => c.type === 'date').length,
        dimensions: dims.length,
        usable: measuresOut.some((m) => m.overall.n >= 10),
      },
      qualitative: {
        text_columns: text.columns.length, texts_total: totalTexts,
        usable: text.columns.some((c) => c.n_texts >= 10),
      },
    },
  };
  progress('done', 100, 'Resumen listo.', true);
  return summary;
}

function friendly(err) {
  if (err && err.code) return err.message;
  const msg = err && err.message ? err.message : String(err);
  if (/out of memory|allocation/i.test(msg)) return 'Memoria insuficiente en el navegador. Reduce el archivo o expórtalo a CSV.';
  return 'Error inesperado al procesar el archivo: ' + msg;
}

// IMPORTANTE: se asigna DESPUÉS de importScripts para no ser pisado por PapaParse
self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'process') return;
  try {
    const summary = await processFile(msg.file, msg.options || {});
    self.postMessage({ type: 'result', summary });
  } catch (err) {
    self.postMessage({
      type: 'error', message: friendly(err), code: (err && err.code) || 'worker_error',
      detail: String((err && err.stack) || err).slice(0, 600),
    });
  }
};
