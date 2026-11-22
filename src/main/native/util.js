'use strict';
// Shared helpers for the native layer. Nothing here touches Electron or the OS at
// require time, so the module also loads under plain Node (tests).

const fs = require('fs');
const os = require('os');
const path = require('path');

function nativeError(code, message) {
  const e = new Error(message || String(code).toLowerCase());
  e.code = code;
  return e;
}

// Contract: unsupported features reject with Error('unsupported'), code 'UNSUPPORTED'.
function unsupported(feature) {
  const e = new Error('unsupported');
  e.code = 'UNSUPPORTED';
  if (feature) e.feature = feature;
  return e;
}

// Electron's main-process API, or null under plain Node (where `require('electron')`
// resolves to the npm package that only exports the binary path).
let electronApi;
function electron() {
  if (electronApi === undefined) {
    try {
      const m = require('electron');
      electronApi = m && typeof m === 'object' && m.app ? m : null;
    } catch {
      electronApi = null;
    }
  }
  return electronApi;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- temp files --------------------------------------------------------------

let tmpDir = null;
function tempDir() {
  if (tmpDir) return tmpDir;
  let base = null;
  if (electron()) {
    try {
      base = path.join(require('../context').paths.tmp, 'native');
    } catch {
      /* context not available (tests) */
    }
  }
  tmpDir = base || path.join(os.tmpdir(), `kadr-native-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

let seq = 0;
function tempFile(prefix, ext) {
  return path.join(tempDir(), `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}.${ext}`);
}

async function unlinkQuiet(p) {
  if (!p) return;
  try {
    await fs.promises.unlink(p);
  } catch {
    /* already gone */
  }
}

// Removes leftovers (e.g. display captures nobody consumed) older than maxAgeMs.
async function cleanupStaleTemp(maxAgeMs = 6 * 3600 * 1000) {
  try {
    const dir = tempDir();
    const now = Date.now();
    for (const name of await fs.promises.readdir(dir)) {
      const p = path.join(dir, name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && st.isFile() && now - st.mtimeMs > maxAgeMs) await unlinkQuiet(p);
    }
  } catch {
    /* best effort */
  }
}

// Accepts a PNG Buffer/Uint8Array/ArrayBuffer or an existing file path.
// Returns { file, temp } — temp files must be removed by the caller.
async function materialize(image, prefix = 'input') {
  if (typeof image === 'string') return { file: image, temp: false };
  let buf = image;
  if (buf instanceof ArrayBuffer) buf = Buffer.from(buf);
  else if (ArrayBuffer.isView(buf) && !Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw nativeError('BAD_ARGS', 'expected PNG bytes or a file path');
  const file = tempFile(prefix, 'png');
  await fs.promises.writeFile(file, buf);
  return { file, temp: true };
}

// ---- process / OS info -------------------------------------------------------

// pids of the Kadr process tree (main + Electron helpers/renderers), cached briefly.
let pidCache = { at: 0, pids: null };
function ownPids(extra = []) {
  const now = Date.now();
  if (!pidCache.pids || now - pidCache.at > 2000) {
    const pids = new Set([process.pid]);
    try {
      for (const m of electron()?.app?.getAppMetrics?.() || []) if (m.pid) pids.add(m.pid);
    } catch {
      /* not ready yet */
    }
    pidCache = { at: now, pids };
  }
  const all = new Set(pidCache.pids);
  for (const p of extra) if (p) all.add(p);
  return all;
}

// macOS product major version (13, 14, 15, 26, …); 0 elsewhere.
function macosMajor() {
  if (process.platform !== 'darwin') return 0;
  try {
    const v = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
    const major = parseInt(v, 10);
    if (major >= 10) return major;
  } catch {
    /* plain Node */
  }
  // Darwin 22 = macOS 13, 23 = 14, 24 = 15, 25 = 26; later releases share the number.
  const darwin = parseInt(os.release(), 10);
  return darwin >= 25 ? Math.max(26, darwin) : darwin - 9;
}

// Tesseract-style / short codes -> BCP-47-ish codes understood by the mac helper.
const LANG_ALIASES = {
  rus: 'ru', eng: 'en', ukr: 'uk', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es',
  ita: 'it', por: 'pt', pol: 'pl', chi_sim: 'zh-Hans', chi_tra: 'zh-Hant', jpn: 'ja', kor: 'ko',
};
function normalizeLanguages(languages) {
  if (!languages) return [];
  const list = Array.isArray(languages) ? languages : String(languages).split(/[+,\s]+/);
  return list.filter(Boolean).map((l) => LANG_ALIASES[String(l).toLowerCase()] || String(l));
}

module.exports = {
  nativeError,
  unsupported,
  electron,
  sleep,
  tempDir,
  tempFile,
  unlinkQuiet,
  cleanupStaleTemp,
  materialize,
  ownPids,
  macosMajor,
  normalizeLanguages,
};
