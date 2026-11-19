/* =============================================================================
 * keyVault.js — Almacén local de la API Key (vincular UNA sola vez)
 * -----------------------------------------------------------------------------
 * La clave se guarda de forma persistente en este navegador y NO se muestra en la interfaz
 * (solo una versión enmascarada: AIza••••••••••••1234).
 *
 * Cómo se guarda:
 *   · Cifrada con AES-GCM (WebCrypto). La clave de cifrado es NO EXPORTABLE y vive en IndexedDB;
 *     el texto cifrado también. Así la clave no queda legible en localStorage ni en un volcado casual.
 *   · Si el navegador no permite WebCrypto/IndexedDB (p. ej. http en una IP de red), se usa localStorage
 *     sin cifrar y la interfaz lo advierte. Si tampoco hay almacenamiento, vive solo en memoria de la pestaña.
 *
 * Límite honesto: en una app 100 % frontend, quien tenga acceso a tu perfil del navegador (o ejecute código
 * malicioso dentro de esta página) podría usar la clave. No la vincules en equipos compartidos y
 * restríngela en Google AI Studio. Para producción, mueve las llamadas a un backend.
 * ========================================================================== */

const DB_NAME = 'th_vault';
const STORE = 'kv';
const META_KEY = 'th_key_meta';      // metadatos NO secretos: últimos 4 caracteres, modo de guardado
const PLAIN_KEY = 'th_key_plain';    // solo si no hay cifrado disponible
let memoryKey = null;                // último recurso: solo esta pestaña

const canEncrypt = () => typeof indexedDB !== 'undefined' && Boolean(globalThis.crypto && globalThis.crypto.subtle);

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB no disponible'));
    req.onblocked = () => reject(new Error('IndexedDB bloqueada'));
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
  });
}
async function idbPutMany(entries) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const [k, v] of entries) st.put(v, k);
    await txDone(tx);
  } finally { db.close(); }
}
async function idbGetMany(keys) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    const reqs = keys.map((k) => new Promise((res, rej) => { const r = st.get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    return await Promise.all(reqs);
  } finally { db.close(); }
}
async function idbClear() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  } finally { db.close(); }
}

/* ---- Metadatos (síncronos, no secretos) ---- */
export function getKeyMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) || 'null');
    return m && m.last4 ? m : null;
  } catch (_) { return null; }
}
function setKeyMeta(meta) { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (_) { /* sin persistencia */ } }

/** Versión enmascarada para mostrar en pantalla (nunca la clave completa): prefijo + puntos + últimos 4. */
export function maskKey(meta) {
  const m = typeof meta === 'string' ? { last4: meta } : (meta || {});
  return `${m.prefix || ''}••••••••••••${m.last4 || ''}`;
}

/**
 * Limpia lo que el usuario pega: quita comillas, espacios/saltos de línea y prefijos típicos de archivos .env
 * ("GEMINI_API_KEY=…", "GOOGLE_API_KEY: …", "Bearer …"). Así copiar la línea completa de un .env también funciona.
 */
export function normalizeApiKey(raw) {
  let s = String(raw ?? '').replace(/^﻿/, '').trim();
  s = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
  s = s.replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*/, '');   // NOMBRE=valor
  s = s.replace(/^bearer\s+/i, '').trim();
  s = s.replace(/^["'`]+|["'`;,]+$/g, '').trim();                          // comillas / punto y coma finales
  return s;
}

/**
 * Valida el formato de forma permisiva: Google ha emitido claves "AIza…" (39 caracteres) y, más recientes, claves
 * "AQ.…" con punto. La validación real la hace Google en "Verificar y guardar"; aquí solo se descartan
 * valores claramente erróneos (espacios, texto muy corto o muy largo, caracteres raros).
 */
export function looksLikeApiKey(key) { return /^[A-Za-z0-9._~+/=-]{20,256}$/.test(String(key || '').trim()); }

/**
 * Guarda la clave (cifrada si es posible). Devuelve los metadatos.
 * @param {string} key
 */
export async function saveApiKey(key) {
  key = normalizeApiKey(key);
  if (!looksLikeApiKey(key)) throw new Error('El formato de la clave no parece válido: debe ser una sola línea, sin espacios (por ejemplo «AIza…» o «AQ.…»).');
  let encrypted = false, persisted = true;
  if (canEncrypt()) {
    try {
      const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(key));
      await idbPutMany([['wrap', wrapKey], ['blob', { iv, data }]]);
      encrypted = true;
      try { localStorage.removeItem(PLAIN_KEY); } catch (_) { /* nada */ }
    } catch (_) { encrypted = false; }
  }
  if (!encrypted) {
    try { localStorage.setItem(PLAIN_KEY, key); }
    catch (_) { persisted = false; }
  }
  memoryKey = persisted ? null : key;
  const meta = { prefix: key.startsWith('AIza') ? 'AIza' : key.slice(0, 3), last4: key.slice(-4), encrypted, persisted, savedAt: new Date().toISOString() };
  if (persisted) setKeyMeta(meta);
  else { try { localStorage.removeItem(META_KEY); } catch (_) { /* nada */ } }
  if (persisted) { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) { /* opcional */ } }
  return meta;
}

/** Recupera la clave guardada (descifrándola) o null si no hay ninguna / no se puede leer. */
export async function loadApiKey() {
  if (memoryKey) return memoryKey;
  const meta = getKeyMeta();
  if (!meta) return null;
  if (meta.encrypted) {
    try {
      const [wrapKey, blob] = await idbGetMany(['wrap', 'blob']);
      if (!wrapKey || !blob) throw new Error('almacén vacío');
      const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, wrapKey, blob.data);
      return new TextDecoder().decode(buf);
    } catch (_) {
      // El navegador borró los datos del sitio o el almacén está dañado: se invalida el vínculo.
      try { localStorage.removeItem(META_KEY); } catch (__) { /* nada */ }
      return null;
    }
  }
  try { return localStorage.getItem(PLAIN_KEY) || null; } catch (_) { return null; }
}

/** Olvida la clave (la desvincula de este navegador). */
export async function clearApiKey() {
  memoryKey = null;
  try { localStorage.removeItem(META_KEY); localStorage.removeItem(PLAIN_KEY); } catch (_) { /* nada */ }
  if (typeof indexedDB !== 'undefined') { try { await idbClear(); } catch (_) { /* nada */ } }
}

/** Migra la clave de versiones anteriores (sessionStorage) al almacén persistente y borra la copia antigua. */
export async function migrateLegacySessionKey() {
  try {
    const legacy = sessionStorage.getItem('th_api_key');
    if (!legacy) return false;
    sessionStorage.removeItem('th_api_key');
    if (!getKeyMeta() && looksLikeApiKey(normalizeApiKey(legacy))) { await saveApiKey(legacy); return true; }
  } catch (_) { /* nada */ }
  return false;
}
