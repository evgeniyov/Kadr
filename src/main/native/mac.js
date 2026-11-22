'use strict';
// macOS backend: the Swift helper `kadr-helper` (native/mac/*.swift) as a long-lived child
// process speaking JSON lines over stdin/stdout. Window bounds from the helper are already
// global points with a top-left origin, i.e. Electron DIP coordinates.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { RpcClient } = require('./rpc');
const u = require('./util');

const TIMEOUTS = {
  permissions: 5000,
  windows: 5000,
  scroll: 5000,
  captureWindow: 15000,
  captureDisplays: 20000,
  prepareCapture: 10000,
  // The very first Vision request on a machine can take close to a minute (model setup).
  ocr: 120000,
  barcodes: 120000,
  removeBackground: 120000,
  audioStart: 15000,
  audioPause: 5000,
  audioResume: 5000,
  audioStop: 30000,
};

function candidatePaths() {
  if (process.env.KADR_HELPER_PATH) return [process.env.KADR_HELPER_PATH];
  const devRoot = path.join(__dirname, '..', '..', '..');
  const list = [];
  if (process.resourcesPath && u.electron()?.app?.isPackaged) {
    list.push(path.join(process.resourcesPath, 'bin', 'mac', 'kadr-helper'));
    list.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin', 'mac', 'kadr-helper'));
  }
  list.push(path.join(devRoot, 'resources', 'bin', 'mac', 'kadr-helper'));
  return list;
}

let resolvedPath; // string | null (cached)
function helperPath() {
  if (resolvedPath === undefined) {
    resolvedPath = null;
    for (const p of candidatePaths()) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        resolvedPath = p;
        break;
      } catch {
        /* try next */
      }
    }
  }
  return resolvedPath;
}

/** Capabilities derivable without running the helper (platform, OS version, binary). */
function staticCapabilities() {
  const has = !!helperPath();
  const major = u.macosMajor();
  const m14 = has && major >= 14;
  return {
    windowList: has,
    captureWindow: m14,
    captureDisplays: m14,
    scroll: has,
    ocr: has,
    barcodes: has,
    removeBackground: m14,
    systemAudio: has && major >= 13,
  };
}

function spawnHelper() {
  const bin = helperPath();
  if (!bin) throw new Error('kadr-helper binary not found (run `npm run build:helper:mac`)');
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  // EPIPE after the helper died must not become an uncaught exception; 'exit' handles it.
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let errBuf = '';
  child.stderr.on('data', (d) => {
    errBuf += d;
    let i;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i).trim();
      errBuf = errBuf.slice(i + 1);
      if (line) console.log(line.startsWith('[kadr-helper]') ? line : `[kadr-helper] ${line}`);
    }
  });

  let messageCb = () => {};
  let outBuf = '';
  child.stdout.on('data', (d) => {
    outBuf += d;
    let i;
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn('[native] kadr-helper sent a malformed line');
        continue;
      }
      messageCb(msg);
    }
  });

  let exitCb = () => {};
  let exited = false;
  const fireExit = (code, signal) => {
    if (exited) return;
    exited = true;
    exitCb(code, signal);
  };
  child.on('exit', fireExit);
  child.on('error', (e) => {
    console.warn('[native] kadr-helper process error:', e.message);
    fireExit(null, e.code || 'ERROR');
  });

  return {
    get pid() {
      return child.pid;
    },
    send(obj) {
      if (!child.stdin.writable) throw new Error('helper stdin is closed');
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    onMessage(cb) {
      messageCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
    // Closing stdin makes the helper finalise any audio recording and exit by itself.
    close() {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 10000);
      t.unref?.();
    },
  };
}

function createClient(hooks) {
  return new RpcClient({ name: 'kadr-helper', spawn: spawnHelper, ...hooks });
}

// ---- operations (called by index.js with a started-on-demand client) ----------

async function windows(client, { allLayers = false } = {}) {
  const r = await client.call('windows', { allLayers }, { timeout: TIMEOUTS.windows });
  return { windows: r.windows || [], displays: r.displays || null, frontmostPid: r.frontmostPid ?? null, foregroundId: null };
}

async function captureWindow(client, id, { shadow }) {
  const out = u.tempFile('window', 'png');
  try {
    const r = await client.call('captureWindow', { id: Number(id), shadow, out }, { timeout: TIMEOUTS.captureWindow });
    const png = await fs.promises.readFile(r.path);
    return { png, scale: r.scale || 1 };
  } finally {
    u.unlinkQuiet(out);
  }
}

function prepareCapture(client) {
  return client.call('prepareCapture', {}, { timeout: TIMEOUTS.prepareCapture });
}

async function captureDisplays(client, { cursor, excludePid, excludeWindowIds }) {
  const args = { cursor, dir: u.tempDir() };
  if (excludePid) args.excludePid = excludePid;
  if (excludeWindowIds?.length) args.excludeWindowIds = excludeWindowIds.map(Number);
  const r = await client.call('captureDisplays', args, { timeout: TIMEOUTS.captureDisplays });
  return r.map((d) => ({
    displayId: d.displayId,
    path: d.path,
    pixelWidth: d.pixelWidth,
    pixelHeight: d.pixelHeight,
    scale: d.scale,
    grabMs: d.grabMs,
  }));
}

// ---- translation (Apple Translation framework, macOS 26+) ---------------------------

async function detectLanguage(client, text) {
  return client.call('detectLanguage', { text }, { timeout: 10000 });
}

async function translationStatus(client, from, to) {
  return (await client.call('translationStatus', { from, to }, { timeout: 15000 })).status;
}

async function translate(client, texts, from, to) {
  return (await client.call('translate', { texts, from, to }, { timeout: 60000 })).texts;
}

// Shows macOS's own "download translation languages" prompt in a separate, short-lived
// helper process → true when the languages are ready.
function prepareTranslation(from, to, title, message) {
  const bin = helperPath();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(bin, ['--prepare-translation', from, to, title, message], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0 && /"ok":true/.test(out)));
  });
}

async function requestScreenAccess(client) {
  const r = await client.call('requestScreenAccess', {}, { timeout: 60000 });
  return !!r?.granted;
}

async function scroll(client, { x, y, deltaY, deltaX }) {
  await client.call('scroll', { x, y, deltaY, deltaX }, { timeout: TIMEOUTS.scroll });
  return true;
}

async function ocr(client, image, { languages, fast }) {
  const { file, temp } = await u.materialize(image, 'ocr');
  try {
    const args = { path: file, languages: u.normalizeLanguages(languages), fast: !!fast };
    const r = await client.call('ocr', args, { timeout: TIMEOUTS.ocr });
    return { lines: r.lines || [], width: r.width, height: r.height };
  } finally {
    if (temp) u.unlinkQuiet(file);
  }
}

async function barcodes(client, image) {
  const { file, temp } = await u.materialize(image, 'barcodes');
  try {
    const r = await client.call('barcodes', { path: file }, { timeout: TIMEOUTS.barcodes });
    return (r.codes || []).map(({ text, symbology, box }) => ({ text, symbology, box }));
  } finally {
    if (temp) u.unlinkQuiet(file);
  }
}

async function removeBackground(client, image) {
  const { file, temp } = await u.materialize(image, 'subject');
  const out = u.tempFile('cutout', 'png');
  try {
    await client.call('removeBackground', { path: file, out }, { timeout: TIMEOUTS.removeBackground });
    return await fs.promises.readFile(out);
  } finally {
    if (temp) u.unlinkQuiet(file);
    u.unlinkQuiet(out);
  }
}

async function permissions(client) {
  return client.call('permissions', {}, { timeout: TIMEOUTS.permissions });
}

const audio = {
  start: (client, outPath) => client.call('audioStart', { out: outPath }, { timeout: TIMEOUTS.audioStart }),
  pause: (client) => client.call('audioPause', {}, { timeout: TIMEOUTS.audioPause }),
  resume: (client) => client.call('audioResume', {}, { timeout: TIMEOUTS.audioResume }),
  stop: (client) => client.call('audioStop', {}, { timeout: TIMEOUTS.audioStop }),
};

module.exports = {
  helperPath,
  staticCapabilities,
  createClient,
  windows,
  captureWindow,
  captureDisplays,
  prepareCapture,
  requestScreenAccess,
  detectLanguage,
  translationStatus,
  translate,
  prepareTranslation,
  scroll,
  ocr,
  barcodes,
  removeBackground,
  permissions,
  audio,
};
