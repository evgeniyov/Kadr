'use strict';
// Native helpers (contract: docs/ARCHITECTURE.md → "Native").
//
// macOS: Swift helper process (mac.js). Windows: koffi worker in a utilityProcess (win.js).
// Nothing is started or loaded from the OS at require time; helpers start on first use,
// are restarted with backoff after a crash, and every request has a timeout.
//
// Errors carry `code`: UNSUPPORTED (feature not available here — also reflected in
// capabilities()), NO_ACCESS (missing Screen Recording / Accessibility permission),
// NO_SUBJECT (removeBackground found nothing), BAD_ARGS, TIMEOUT, HELPER_UNAVAILABLE,
// HELPER_EXITED, FAILED.

const EventEmitter = require('events');
const path = require('path');
const u = require('./util');

const FEATURES = [
  'windowList',
  'captureWindow',
  'captureDisplays',
  'scroll',
  'ocr',
  'barcodes',
  'removeBackground',
  'systemAudio',
];
const NONE = Object.fromEntries(FEATURES.map((k) => [k, false]));

// Layer-0 windows of system processes that are never capture targets (macOS).
const IGNORED_APPS = new Set(['Window Server', 'Dock', 'WindowManager', 'Wallpaper']);
const MIN_WINDOW_SIZE = 24;

function onSomeDisplay(b, displays) {
  if (!displays || !displays.length) return true;
  return displays.some(({ bounds: d }) => {
    const w = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
    const h = Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y);
    return w > 0 && h > 0;
  });
}

const events = new EventEmitter(); // 'helper-exit' {code, signal, crashed}, 'audio-interrupted'

let backend; // mac.js | win.js | null
let client = null;
let reported = null; // capabilities from the helper's hello
let initPromise = null;
let audioActive = false;
let stopping = false;

// macOS: the helper stays running, so a screenshot hotkey never waits for it to start (about
// a quarter of a second, and the frame would be grabbed that much later). Light it is ~25 MB;
// once it has done heavy work (Vision, translation, audio) it is restarted fresh when idle.
const KEEP_WARM = process.platform === 'darwin';
const LIGHT_CALLS = new Set(['hello', 'permissions', 'windows', 'captureDisplays', 'prepareCapture', 'captureWindow', 'scroll', 'requestScreenAccess']);
let heavy = false;

function platformBackend() {
  if (backend === undefined) {
    backend = null;
    try {
      if (process.platform === 'darwin') backend = require('./mac');
      else if (process.platform === 'win32') backend = require('./win');
    } catch (e) {
      console.error('[native] cannot load the platform backend', e);
    }
  }
  return backend;
}

function getClient() {
  if (!client && platformBackend()) {
    client = backend.createClient({
      onHello: (hello) => {
        reported = { ...NONE, ...(hello && hello.capabilities) };
        heavy = false;
        events.emit('helper-ready');
      },
      onCall: (cmd) => {
        if (!LIGHT_CALLS.has(cmd)) heavy = true;
      },
      onExit: (info) => {
        if (audioActive && info.crashed) {
          audioActive = false;
          events.emit('audio-interrupted', info);
        }
        events.emit('helper-exit', info);
        // Closed because idle after heavy work: start a fresh, light one.
        if (KEEP_WARM && !info.crashed && !stopping) setTimeout(() => !stopping && getClient()?.ensure().catch(() => {}), 1000).unref?.();
      },
      // Never recycle a slow helper while it is recording system audio.
      canRecycle: () => !audioActive,
      // Free the helper's memory (Vision models can take hundreds of MB) when unused.
      idleMs: Number(process.env.KADR_HELPER_IDLE_MS) || 120000,
      canIdle: () => !audioActive && (!KEEP_WARM || heavy),
    });
  }
  return client;
}

/** Sync. Accurate before init(): derived from platform, OS version and the helper binary. */
function capabilities() {
  const b = platformBackend();
  if (!b) return { ...NONE };
  const base = b.staticCapabilities();
  if (!reported) return base;
  return Object.fromEntries(FEATURES.map((k) => [k, !!(base[k] && reported[k])]));
}

function requireFeature(feature) {
  if (!capabilities()[feature]) throw u.unsupported(feature);
  const c = getClient();
  if (!c) throw u.unsupported(feature);
  return c;
}

/** Starts the helper (once; safe to call many times). Resolves with capabilities(), never rejects. */
function init() {
  if (!initPromise) {
    initPromise = (async () => {
      const c = platformBackend() && Object.values(capabilities()).some(Boolean) ? getClient() : null;
      if (c) {
        try {
          await c.ensure();
          c.armIdle?.();
        } catch (e) {
          console.warn('[native] helper did not start:', e.message);
        }
      }
      u.cleanupStaleTemp();
      return capabilities();
    })().finally(() => {
      // Allow a later init() to retry if the helper could not be started this time.
      if (!client || !client.running) initPromise = null;
    });
  }
  return initPromise;
}

// ---- windows ------------------------------------------------------------------

async function fetchWindows({ allLayers = false } = {}) {
  const c = requireFeature('windowList');
  const raw = await backend.windows(c, { allLayers });
  const own = u.ownPids([c.pid]);
  const windows = [];
  for (const w of raw.windows) {
    const b = w.bounds;
    if (!b || own.has(w.pid)) continue;
    const layer = w.layer || 0;
    if ((w.alpha ?? 1) <= 0) continue;
    if (layer !== 0 && (!allLayers || layer < 0)) continue;
    const minSize = layer === 0 ? MIN_WINDOW_SIZE : 1;
    if (b.width < minSize || b.height < minSize) continue;
    if (IGNORED_APPS.has(w.appName) || !onSomeDisplay(b, raw.displays)) continue;
    windows.push({
      id: w.id,
      pid: w.pid,
      appName: w.appName || '',
      title: w.title || '',
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      layer,
    });
  }
  return { windows, frontmostPid: raw.frontmostPid, foregroundId: raw.foregroundId, own };
}

/** On-screen windows, front-to-back, global DIP bounds, Kadr's own windows excluded. */
async function listWindows(opts) {
  return (await fetchWindows(opts)).windows;
}

/** The frontmost window that does not belong to Kadr, or null. */
async function activeWindow() {
  const { windows, frontmostPid, foregroundId, own } = await fetchWindows();
  if (foregroundId != null) {
    const w = windows.find((x) => x.id === foregroundId);
    if (w) return w;
  }
  if (frontmostPid && !own.has(frontmostPid)) {
    const w = windows.find((x) => x.pid === frontmostPid);
    if (w) return w;
  }
  return windows[0] || null;
}

// ---- capture ------------------------------------------------------------------

// Permission / support problems propagate; any other failure resolves to null so the
// caller can fall back (desktopCapturer).
function softFail(what, e) {
  if (e && (e.code === 'UNSUPPORTED' || e.code === 'NO_ACCESS' || e.code === 'BAD_ARGS')) throw e;
  console.warn(`[native] ${what} failed:`, e && e.message);
  return null;
}

/** → { png: Buffer, scale } | null */
async function captureWindow(id, { shadow = true } = {}) {
  const c = requireFeature('captureWindow');
  if (id === undefined || id === null || !Number.isFinite(Number(id))) throw u.nativeError('BAD_ARGS', 'window id required');
  try {
    return await backend.captureWindow(c, id, { shadow: shadow !== false });
  } catch (e) {
    return softFail('captureWindow', e);
  }
}

/**
 * → [{ displayId, path, pixelWidth, pixelHeight, scale }] | null. The caller owns the files.
 * excludeWindowIds: macOS window numbers to leave out (e.g. overlays already on screen);
 * excludeSelf: leave out every Kadr window.
 */
async function captureDisplays({ cursor = false, excludeSelf = false, excludeWindowIds = null } = {}) {
  const c = requireFeature('captureDisplays');
  try {
    return await backend.captureDisplays(c, { cursor: !!cursor, excludePid: excludeSelf ? process.pid : 0, excludeWindowIds });
  } catch (e) {
    return softFail('captureDisplays', e);
  }
}

/** Lets the next captureDisplays grab the frame right away (macOS). Never rejects. */
async function prepareCapture() {
  if (!capabilities().captureDisplays || !backend?.prepareCapture) return false;
  try {
    await backend.prepareCapture(getClient());
    return true;
  } catch (e) {
    if (e?.code !== 'NO_ACCESS' && e?.code !== 'UNSUPPORTED') console.warn('[native] prepareCapture failed:', e?.message);
    return false;
  }
}

// ---- input ----------------------------------------------------------------------

/** Scroll-wheel event at a global DIP point; deltaY > 0 scrolls down. Resolves true. */
async function scroll({ x, y, deltaY = 0, deltaX = 0 } = {}) {
  const c = requireFeature('scroll');
  if (![x, y, deltaY, deltaX].every((v) => Number.isFinite(Number(v)))) {
    throw u.nativeError('BAD_ARGS', 'scroll needs numeric x, y, deltaY');
  }
  return backend.scroll(c, { x: Number(x), y: Number(y), deltaY: Number(deltaY), deltaX: Number(deltaX) });
}

// ---- image analysis ---------------------------------------------------------------

/** → { lines: [{ text, box:{x,y,width,height}, confidence }], width, height } (image px, top-left origin) */
async function ocr(png, { languages, fast = false } = {}) {
  return backend.ocr(requireFeature('ocr'), png, { languages, fast });
}

/** → [{ text, symbology, box }] */
async function barcodes(png) {
  return backend.barcodes(requireFeature('barcodes'), png);
}

/** → Buffer (PNG with alpha, same size as the input). Rejects NO_SUBJECT when nothing is found. */
async function removeBackground(png) {
  return backend.removeBackground(requireFeature('removeBackground'), png);
}

/** → { screen, accessibility } (never prompts). */
async function permissions() {
  if (process.platform !== 'darwin') return { screen: true, accessibility: true };
  const c = getClient();
  if (!c || !capabilities().windowList) return { screen: false, accessibility: false };
  return backend.permissions(c);
}

// ---- translation ---------------------------------------------------------------------

/** On-device translation is available (macOS 26+ with the helper). Sync. */
function canTranslate() {
  return process.platform === 'darwin' && Number(require('os').release().split('.')[0]) >= 25 && !!platformBackend()?.translate && capabilities().ocr;
}

const translation = {
  async detect(text) {
    if (!canTranslate()) throw u.unsupported('translation');
    return backend.detectLanguage(getClient(), text);
  },
  async status(from, to) {
    if (!canTranslate()) return 'unsupported';
    return backend.translationStatus(getClient(), from, to);
  },
  /** texts: string[] → string[] (same order). Rejects NOT_INSTALLED / UNSUPPORTED_PAIR. */
  async translate(texts, from, to) {
    if (!canTranslate()) throw u.unsupported('translation');
    return backend.translate(getClient(), texts, from, to);
  },
  prepare(from, to, title, message) {
    if (!canTranslate()) return Promise.resolve(false);
    return backend.prepareTranslation(from, to, title, message);
  },
};

/** macOS: request Screen Recording access (prompt + entry in System Settings) → granted? */
async function requestScreenAccess() {
  if (process.platform !== 'darwin') return true;
  const c = getClient();
  if (!c || !backend?.requestScreenAccess) return false;
  return backend.requestScreenAccess(c);
}

// ---- system audio (macOS) ---------------------------------------------------------

const systemAudio = {
  /** Starts capturing system audio into an AAC .m4a at outPath → { path, startedAt }. */
  async start(outPath) {
    const c = requireFeature('systemAudio');
    if (!outPath) throw u.nativeError('BAD_ARGS', 'output path required');
    const r = await backend.audio.start(c, path.resolve(outPath));
    audioActive = true;
    return r;
  },
  async pause() {
    const c = requireFeature('systemAudio');
    await backend.audio.pause(c);
    return true;
  },
  async resume() {
    const c = requireFeature('systemAudio');
    await backend.audio.resume(c);
    return true;
  },
  /** → { path, startedAt (epoch ms of sample 0), durationMs } | null (nothing captured / helper died). */
  async stop() {
    if (!capabilities().systemAudio || !client || !client.running) {
      audioActive = false;
      return null;
    }
    try {
      const r = await backend.audio.stop(client);
      return r ? { path: r.path, startedAt: r.startedAt, durationMs: r.durationMs } : null;
    } catch (e) {
      console.warn('[native] systemAudio.stop failed:', e.message);
      return null;
    } finally {
      audioActive = false;
    }
  },
  isActive: () => audioActive,
};

/** Stops helpers. The mac helper finalises an in-progress audio file before exiting. */
function shutdown() {
  stopping = true;
  try {
    client?.stop();
  } catch {
    /* ignore */
  }
  initPromise = null;
}

module.exports = {
  init,
  capabilities,
  listWindows,
  activeWindow,
  captureWindow,
  captureDisplays,
  prepareCapture,
  scroll,
  ocr,
  barcodes,
  removeBackground,
  permissions,
  requestScreenAccess,
  canTranslate,
  translation,
  systemAudio,
  shutdown,
  events,
};
