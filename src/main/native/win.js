'use strict';
// Windows backend: `win-worker.js` in an Electron utilityProcess calls Win32 via koffi.
// FFI runs outside the main process so a bad call can only crash the worker (which is
// restarted lazily with backoff). The worker works in physical pixels; this side converts
// to DIP with screen.screenToDipRect / dipToScreenPoint.

const path = require('path');
const { RpcClient } = require('./rpc');
const u = require('./util');

const TIMEOUTS = { windows: 5000, scroll: 5000, captureWindow: 15000 };

let koffiPresent;
function koffiAvailable() {
  if (koffiPresent === undefined) {
    try {
      require.resolve('koffi');
      // koffi 3 ships its native code in per-platform packages (optionalDependencies).
      require.resolve(`@koromix/koffi-win32-${process.arch}`);
      koffiPresent = true;
    } catch {
      koffiPresent = false;
    }
  }
  return koffiPresent;
}

function staticCapabilities() {
  const k = process.platform === 'win32' && koffiAvailable();
  return {
    windowList: k,
    captureWindow: k,
    captureDisplays: false,
    scroll: k,
    ocr: false,
    barcodes: false,
    removeBackground: false,
    systemAudio: false,
  };
}

function spawnWorker() {
  const e = u.electron();
  if (!e || !e.utilityProcess) throw new Error('utilityProcess is not available');
  if (!e.app.isReady()) throw new Error('app is not ready yet');
  const child = e.utilityProcess.fork(path.join(__dirname, 'win-worker.js'), [], {
    serviceName: 'Kadr Native Helper',
  });
  let exited = false;
  let exitCb = () => {};
  child.on('exit', (code) => {
    if (exited) return;
    exited = true;
    exitCb(code, null);
  });
  child.on('error', (type, location) => console.warn('[native] win worker error', type, location));
  return {
    get pid() {
      return child.pid;
    },
    send(obj) {
      child.postMessage(obj);
    },
    onMessage(cb) {
      child.on('message', cb);
    },
    onExit(cb) {
      exitCb = cb;
    },
    kill() {
      child.kill();
    },
    close() {
      child.kill();
    },
  };
}

function createClient(hooks) {
  return new RpcClient({ name: 'win-worker', spawn: spawnWorker, ...hooks });
}

function toDipRect(r) {
  const { screen } = u.electron();
  return screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.width, height: r.height });
}

async function windows(client) {
  const r = await client.call('windows', {}, { timeout: TIMEOUTS.windows });
  const list = (r.windows || []).map((w) => ({ ...w, bounds: toDipRect(w.bounds) }));
  const displays = u.electron().screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds }));
  return { windows: list, displays, frontmostPid: r.foregroundPid ?? null, foregroundId: r.foregroundId ?? null };
}

async function captureWindow(client, id) {
  const r = await client.call('captureWindow', { id: Number(id) }, { timeout: TIMEOUTS.captureWindow });
  if (!r || !r.png) return null;
  const { screen } = u.electron();
  const display = screen.getDisplayMatching(toDipRect(r.frame));
  const scale = display ? display.scaleFactor : 1;
  // A DPI-unaware (bitmap-stretched) window on a scaled monitor renders at the wrong
  // size through PrintWindow; let the caller fall back to a screen crop instead.
  if ((r.awareness === 0 || r.awareness === 1) && r.dpi && Math.abs(r.dpi / 96 - scale) > 0.01) return null;
  const png = Buffer.from(r.png.buffer, r.png.byteOffset, r.png.byteLength);
  return { png, scale };
}

async function scroll(client, { x, y, deltaY, deltaX }) {
  const { screen } = u.electron();
  const p = screen.dipToScreenPoint({ x, y });
  await client.call('scroll', { x: p.x, y: p.y, deltaY, deltaX }, { timeout: TIMEOUTS.scroll });
  return true;
}

module.exports = { staticCapabilities, createClient, windows, captureWindow, scroll, koffiAvailable };
