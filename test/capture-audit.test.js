'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function load(relative, mocks, timers) {
  const filename = path.resolve(__dirname, '..', relative), module = { exports: {} };
  const localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
    console: { log() {}, warn() {}, error() {} }, process, Buffer,
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  }, { filename });
  return module.exports;
}
function fakeWindow({ loading = false, params = {} } = {}) {
  const win = new EventEmitter();
  win.destroyed = false; win.visible = false; win.params = params;
  win.webContents = Object.assign(new EventEmitter(), {
    sent: [], isLoading: () => loading, isDestroyed: () => win.destroyed,
    send(channel, payload) { this.sent.push({ channel, payload }); }, focus() {},
  });
  Object.assign(win, {
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); },
    isDestroyed: () => win.destroyed, show() { win.visible = true; }, showInactive() { win.visible = true; },
    hide() { win.visible = false; }, getBounds: () => ({ x: 0, y: 0, width: 100, height: 80 }),
    setBounds() {}, focus() {}, setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {},
    setContentProtection() {}, setIgnoreMouseEvents() {}, getMediaSourceId: () => 'window:1:0',
  });
  return win;
}
const region = { displayId: 1, scaleFactor: 1, displayBounds: { x: 0, y: 0, width: 100, height: 80 }, rect: { x: 5, y: 5, width: 40, height: 40 }, global: { x: 5, y: 5, width: 40, height: 40 } };
function scrollHarness({ sources, getSources, selectRegion } = {}) {
  const windows = [], timers = new Set(), handlers = {}, ipcMain = new EventEmitter(), delivered = [], scrolls = [];
  let id = 0;
  const ctx = {
    isMac: false, newId: () => String(++id), t: (k) => k, notify() {}, trustedSender: () => true,
    settings: { get: () => true }, handle: (channel, handler) => { handlers[channel] = handler; },
    modules: { capture: { selectRegion: selectRegion || (async () => region), deliver: async (img) => delivered.push(img) }, native: { capabilities: () => ({ scroll: true }), scroll: async (request) => { scrolls.push(request); } } },
    createWindow: (kind, opts) => { const win = fakeWindow({ loading: true, params: opts.params }); windows.push(win); return win; },
  };
  const api = load('src/main/scroll-capture.js', {
    './context': ctx, './basics': { toBuffer: (x) => x },
    electron: { ipcMain, desktopCapturer: { getSources: getSources || (async () => sources || [{ id: 'screen:1', display_id: '1' }]) },
      globalShortcut: { register() {}, unregister() {} }, nativeImage: { createFromBuffer: (x) => x },
      screen: { getAllDisplays: () => [{ id: 1 }], getDisplayMatching: () => ({ workArea: region.displayBounds }) } },
  }, timers);
  api.register();
  const worker = () => windows.findLast((w) => w.params.role === 'worker');
  const ready = async () => { await flush(); worker().webContents.emit('did-finish-load'); await flush(); };
  const reply = (channel, result, error) => {
    const w = worker(), request = w.webContents.sent.findLast((m) => m.channel === channel);
    assert(request, `missing ${channel}`);
    ipcMain.emit('scroll:reply', { sender: w.webContents }, { id: request.payload.id, result, error });
  };
  return { api, windows, timers, handlers, ipcMain, delivered, scrolls, worker, ready, reply };
}

test('closing a scroller during init settles start and removes its pending reply listener', async () => {
  const h = scrollHarness(); let settled = false;
  const starting = h.api.start({ manual: false }).then(() => { settled = true; });
  await h.ready(); assert.equal(h.ipcMain.listenerCount('scroll:reply'), 1);
  h.worker().destroy(); await flush();
  assert.equal(settled, true); assert.equal(h.ipcMain.listenerCount('scroll:reply'), 0);
  await starting;
});

test('a cancelled source lookup cannot initialize or close a replacement scroller', async () => {
  const sources = deferred(); let calls = 0;
  const h = scrollHarness({ getSources: () => ++calls === 1 ? sources.promise : Promise.resolve([{ id: 'screen:1', display_id: '1' }]) });
  const first = h.api.start({ manual: false }); await h.ready(); h.api.cancel();
  const second = h.api.start({ manual: false }); await h.ready();
  const replacement = h.worker();
  sources.resolve([{ id: 'screen:old', display_id: '1' }]); await flush();
  assert.equal(replacement.webContents.sent.filter((m) => m.channel === 'scroll:init').length, 1);
  assert.equal(replacement.destroyed, false);
  h.reply('scroll:init', {}); await second; await first; h.api.cancel();
});

test('scroller rejects a missing monitor instead of capturing another display', async () => {
  const h = scrollHarness({ sources: [{ id: 'screen:wrong', display_id: '2' }] });
  let settled = false;
  const starting = h.api.start({ manual: false }).then(() => { settled = true; });
  await h.ready();
  assert.equal(h.worker().webContents.sent.some((m) => m.channel === 'scroll:init'), false);
  assert.equal(settled, true); assert(h.windows.every((w) => w.destroyed)); await starting;
});

test('scroller finish is idempotent and delivers the image only once', async () => {
  const h = scrollHarness(); const starting = h.api.start({ manual: false });
  await h.ready(); h.reply('scroll:init', {}); await starting;
  const first = h.handlers['scroll:finish'](), second = h.handlers['scroll:finish'](); await flush();
  assert.equal(h.worker().webContents.sent.filter((m) => m.channel === 'scroll:finish').length, 1);
  h.reply('scroll:finish', { data: Buffer.from('image'), scale: 1 });
  await Promise.all([first, second]); assert.equal(h.delivered.length, 1);
  assert.equal(h.ipcMain.listenerCount('scroll:reply'), 0);
});

test('a nonresponsive scroller times out and releases all session windows', async () => {
  const h = scrollHarness(); let settled = false;
  const starting = h.api.start({ manual: false }).then(() => { settled = true; });
  await h.ready();
  const timeout = [...h.timers].find((timer) => timer.ms >= 10000);
  assert(timeout, 'worker requests need a finite timeout'); timeout.fn(); await flush();
  assert.equal(settled, true); assert(h.windows.every((w) => w.destroyed));
  assert.equal(h.ipcMain.listenerCount('scroll:reply'), 0); await starting;
});

function captureHarness({ loading = false, sources = [], displays: suppliedDisplays, captureDisplays, execFile, native = {}, ocr, translate } = {}) {
  const windows = [], timers = new Set(), handlers = {}, writes = [], unlinks = [];
  const previews = [];
  const files = new Set();
  const display = { id: 1, bounds: region.displayBounds, size: { width: 100, height: 80 }, scaleFactor: 1 };
  const displays = suppliedDisplays || [display];
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays, getCursorScreenPoint: () => ({ x: 1, y: 1 }),
    getDisplayNearestPoint: () => display, getDisplayMatching: () => displays[0],
  });
  const settings = { afterCapture: 'preview', library: { enabled: false }, windowCapture: { shadow: true, backdrop: true } };
  const image = (data, rect = { x: 0, y: 0, width: 100, height: 80 }) => ({
    getSize: () => ({ width: rect.width, height: rect.height }),
    crop: (crop) => image(data, crop),
    toPNG: () => Buffer.from(JSON.stringify({ data: String(data), ...rect })),
  });
  const ctx = {
    isMac: !!captureDisplays, paths: { captures: '/synthetic' }, settings: { get: (key) => key ? key.split('.').reduce((s, k) => s?.[k], settings) : settings },
    modules: {
      native: { capabilities: () => ({ captureDisplays: !!captureDisplays, captureWindow: !!native.captureWindow }), captureDisplays, ...native },
      preview: { show: (opts) => previews.push(opts) }, ocr, translate,
    },
    newId: () => 'result',
    t: (key) => key, notify() {}, dataUrl: (file) => file,
    handle: (channel, handler) => { handlers[channel] = handler; },
    createWindow: (_kind, opts) => { const win = fakeWindow({ loading, params: opts.params }); windows.push(win); return win; },
  };
  const api = load('src/main/capture.js', {
    fs: {
      writeFileSync: (file, data) => writes.push({ file, data }),
      readFileSync(file) { assert(files.has(file)); return Buffer.from('synthetic screenshot'); },
      promises: {
        async unlink(file) { unlinks.push(file); files.delete(file); },
        async writeFile(file, data) { writes.push({ file, data }); },
      },
    },
    ...(execFile && { child_process: { execFile: (cmd, args, cb) => execFile(cmd, args, cb, files) } }),
    './context': ctx, electron: {
      app: { focus() {} }, screen, desktopCapturer: { getSources: async () => sources },
      nativeImage: { createFromBuffer: image },
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
    },
    './clip': { async writeText() {} },
  }, timers);
  api.register();
  return { api, windows, timers, handlers, screen, writes, unlinks, files, previews };
}

test('a failed macOS fallback capture cleans up partial and late display PNGs', async () => {
  const displays = [1, 2, 3].map((id) => ({ id, bounds: region.displayBounds }));
  const complete = [];
  const h = captureHarness({
    displays,
    captureDisplays: async () => null,
    execFile: (_cmd, args, callback, files) => {
      complete.push((error) => {
        files.add(args.at(-1));
        callback(error);
      });
    },
  });
  const result = assert.rejects(h.api.captureAllDisplays(), /screencapture failed/);
  await flush();
  complete[0]();
  complete[1](new Error('screencapture failed'));
  await flush();
  complete[2]();
  await result;
  assert.equal(h.files.size, 0, 'temporary fallback PNGs remain after the capture failed');
});

for (const failure of ['closed', 'did-fail-load', 'render-process-gone']) {
  test(`overlay ${failure} releases capture ownership and permits another selection`, async () => {
    const h = captureHarness({ loading: true }); let settled = false;
    const first = h.api.selectRegion().then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const firstWindow = h.windows[0];
    if (failure === 'closed') firstWindow.destroy();
    else firstWindow.webContents.emit(failure, {}, -2, 'synthetic load failure');
    await flush(); assert.equal(settled, true); await first;
    const second = h.api.selectRegion(); await flush();
    const win = h.windows.at(-1); win.webContents.emit('did-finish-load'); await flush();
    assert(win.webContents.sent.some((m) => m.channel === 'overlay:start'));
    h.handlers['overlay:cancel'](); assert.equal(await second, null);
  });
}

test('cancelling an overlay during load never reinitializes the hidden renderer later', async () => {
  const h = captureHarness({ loading: true });
  const result = h.api.runOverlay({ purpose: 'area' }); await flush();
  const win = h.windows[0]; h.handlers['overlay:cancel'](); assert.equal(await result, null);
  win.webContents.emit('did-finish-load'); await flush();
  assert.equal(win.webContents.sent.filter((m) => m.channel === 'overlay:start').length, 0);
  assert.equal(win.webContents.listenerCount('did-finish-load'), 0);
});

test('display topology changes cancel the selection before rebuilding overlays', async () => {
  const h = captureHarness(); let settled = false;
  const result = h.api.selectRegion().then((r) => { settled = true; return r; }); await flush();
  h.screen.emit('display-metrics-changed'); await flush();
  assert.equal(settled, true); assert.equal(await result, null);
});

test('cancelling a pending scroll export cannot close a replacement session', async () => {
  const h = scrollHarness(); const first = h.api.start({ manual: false });
  await h.ready(); h.reply('scroll:init', {}); await first;
  const exporting = h.handlers['scroll:finish'](); await flush();
  h.api.cancel(); const second = h.api.start({ manual: false }); await h.ready();
  await exporting; assert.equal(h.worker().destroyed, false); assert.equal(h.delivered.length, 0);
  h.reply('scroll:init', {}); await second; h.api.cancel();
  assert.equal(h.ipcMain.listenerCount('scroll:reply'), 0);
});

for (const failure of ['closed', 'did-fail-load', 'render-process-gone']) {
  test(`scroller ${failure} during renderer load settles start and removes load listeners`, async () => {
    const h = scrollHarness(); let settled = false;
    const starting = h.api.start({ manual: false }).then(() => { settled = true; }); await flush();
    const w = h.worker();
    if (failure === 'closed') w.destroy(); else w.webContents.emit(failure, {}, -2, 'load failed');
    await flush(); assert.equal(settled, true); await starting;
    assert(h.windows.every((win) => win.destroyed));
    assert.equal(w.webContents.listenerCount('did-finish-load'), 0);
  });
}

test('one unnamed screen source is safe when the selected display is the only monitor', async () => {
  const h = scrollHarness({ sources: [{ id: 'screen:unnamed', display_id: '' }] });
  const starting = h.api.start({ manual: false }); await h.ready();
  assert.equal(h.worker().webContents.sent.find((m) => m.channel === 'scroll:init').payload.sourceId, 'screen:unnamed');
  h.reply('scroll:init', {}); await starting; h.api.cancel();
});

test('normal overlay selection shows the window and returns exactly the chosen rectangle', async () => {
  const h = captureHarness();
  const result = h.api.runOverlay({ purpose: 'area' }); await flush();
  const win = h.windows[0]; h.handlers['overlay:ready']({ sender: win.webContents });
  assert.equal(win.visible, true);
  const chosen = { displayId: 1, rect: { x: 10, y: 12, width: 40, height: 30 } };
  h.handlers['overlay:done']({ sender: win.webContents }, chosen);
  assert.equal(await result, chosen); assert.equal(win.visible, false);
});

const frame = { displayId: 1, path: '/synthetic/frame.png', pixelWidth: 100, pixelHeight: 80 };
const bounds = (x, y, width, height) => ({ x, y, width, height });
const listedWindow = (id, pid, layer, bounds) => ({ id, pid, layer, bounds, appName: 'Fixture', title: 'Window' });

async function clickListedWindow(h, opts, displayId = 1) {
  h.files.add(frame.path);
  const result = h.api.start(opts);
  await flush();
  const win = h.windows.find((w) => w.params.displayId === displayId);
  const { payload } = win.webContents.sent.find((m) => m.channel === 'overlay:start');
  const target = payload.windows.find((w) => w.id === 1);
  assert(target);
  h.handlers['overlay:done']({ sender: win.webContents }, { displayId, windowId: target.id, rect: target.captureRect || target.rect });
  const returned = await result;
  await flush();
  return { payload, target, returned };
}

test('window highlight includes touching same-app transient windows and clips to the selected display', async () => {
  const left = { id: 2, bounds: bounds(-100, -10, 100, 80), scaleFactor: 1 };
  const main = { id: 1, bounds: region.displayBounds, scaleFactor: 1 };
  const windows = [
    listedWindow(2, 10, 101, bounds(-26, 53, 42, 8)),    // touches the bottom edge
    listedWindow(3, 10, 101, bounds(-80, 61, 60, 24)),  // touches only the other popup
    listedWindow(4, 11, 101, bounds(-30, 30, 5, 80)),    // a different app
    listedWindow(5, 10, 101, bounds(160, 30, 4, 30)),    // off both displays
    listedWindow(6, 10, 101, bounds(0, 30, 60, 20)),     // only on the main display
    listedWindow(7, 10, -1, bounds(-98, 10, 95, 52)),    // behind normal windows
    listedWindow(1, 10, 0, bounds(-90, 8, 110, 45)),
  ];
  const h = captureHarness({
    displays: [main, left],
    captureDisplays: async () => [frame, { ...frame, displayId: 2 }],
    native: { listWindows: async () => windows },
  });
  const { payload, target, returned } = await clickListedWindow(h, { mode: 'area', return: true }, 2);
  assert.deepEqual(Array.from(payload.windows, (w) => w.id), [1]);
  assert.deepEqual({ ...target.captureRect }, bounds(10, 18, 90, 53));
  assert.deepEqual(JSON.parse(returned.data), { data: 'synthetic screenshot', ...bounds(10, 18, 90, 53) });
});

for (const [mode, returnResult, transient, live] of [
  ['area', false, false, false],
  ['area', true, true, false],
  ['ocr', false, true, false],
  ['translate', false, true, false],
  ['window', false, true, false],
  ['window', false, false, true],
]) {
  test(`${mode} windowId selects ${live ? 'live' : 'frozen'} pixels (transient=${transient}, return=${returnResult})`, async () => {
    const base = bounds(10, 12, 40, 30);
    const extra = bounds(40, 32, 30, 5);
    const frozenCrop = transient ? bounds(10, 12, 60, 30) : base;
    const windows = [listedWindow(1, 10, 0, base)];
    if (transient) windows.unshift(listedWindow(2, 10, 100, extra));
    const scans = [], captures = [], recognized = [], translations = [];
    const h = captureHarness({
      captureDisplays: async () => [frame],
      native: {
        async listWindows(opts) {
          scans.push(opts);
          return opts?.allLayers ? windows : windows.filter((w) => !w.layer);
        },
        async captureWindow(id, opts) {
          captures.push({ id, shadow: opts.shadow });
          return { png: Buffer.from('live window'), scale: 2 };
        },
      },
      ocr: { async recognize(data) { recognized.push(data); return { text: 'OCR' }; } },
      translate: { async translateText(text) { translations.push(text); return { text: 'Translated' }; } },
    });
    const { returned } = await clickListedWindow(h, { mode, return: returnResult });
    const data = returned?.data || recognized[0] || h.writes[0]?.data;
    assert.deepEqual(JSON.parse(data), live
      ? { data: 'live window', ...bounds(0, 0, 100, 80) }
      : { data: 'synthetic screenshot', ...frozenCrop });
    assert.deepEqual(scans.map((opts) => opts?.allLayers), [true]);
    assert.deepEqual(captures, live ? [{ id: 1, shadow: true }] : []);
    assert.deepEqual(translations, mode === 'translate' ? ['OCR'] : []);
    if (!returnResult && mode !== 'ocr' && mode !== 'translate') {
      assert.equal(h.previews[0].meta.appName, 'Fixture');
      assert.equal(h.previews[0].options?.backdrop ?? false, live);
    }
  });
}

test('a transient completely inside the window still suppresses live capture', async () => {
  const windows = [listedWindow(2, 10, 100, bounds(20, 20, 32, 20)), listedWindow(1, 10, 0, bounds(10, 10, 60, 55))];
  const h = captureHarness({
    captureDisplays: async () => [frame],
    native: { listWindows: async () => windows, captureWindow: async () => ({ png: Buffer.from('live window') }) },
  });
  await clickListedWindow(h, { mode: 'window' });
  assert.deepEqual(JSON.parse(h.writes[0].data), { data: 'synthetic screenshot', ...bounds(10, 10, 60, 55) });
});

for (const mode of ['area', 'colorPicker']) {
  test(`macOS ${mode} keeps overlays hidden until display capture completes`, async () => {
    const frames = deferred();
    const h = captureHarness({ captureDisplays: () => frames.promise });
    const result = h.api.start({ mode });
    await flush();
    const win = h.windows[0];
    h.handlers['overlay:ready']({ sender: win.webContents });
    for (const timer of [...h.timers]) if (timer.ms === 1500) timer.fn();
    assert.equal(win.visible, false);

    frames.resolve([{ displayId: 1, path: '/synthetic/frame.png', pixelWidth: 100, pixelHeight: 80 }]);
    await flush();
    const start = win.webContents.sent.find((message) => message.channel === 'overlay:start');
    assert.equal(start?.payload.imageUrl, '/synthetic/frame.png');
    h.handlers['overlay:ready']({ sender: win.webContents });
    assert.equal(win.visible, true);
    h.handlers['overlay:cancel']();
    assert.equal(await result, null);
    assert.deepEqual(h.unlinks, ['/synthetic/frame.png']);
  });
}

test('display topology changes during a macOS snapshot discard the late frame', async () => {
  const frames = deferred();
  const h = captureHarness({ captureDisplays: () => frames.promise });
  const result = h.api.start({ mode: 'area' });
  await flush();
  h.screen.emit('display-metrics-changed');
  frames.resolve([{ displayId: 1, path: '/synthetic/frame.png', pixelWidth: 100, pixelHeight: 80 }]);
  assert.equal(await result, null);
  assert(h.windows.every((win) => !win.visible && !win.webContents.sent.some((m) => m.channel === 'overlay:start')));
  assert.deepEqual(h.unlinks, ['/synthetic/frame.png']);
});

test('overlay IPC send failure settles and releases the capture lock', async () => {
  const h = captureHarness({ loading: true }); let settled = false;
  const result = h.api.selectRegion().catch(() => { settled = true; }); await flush();
  h.windows[0].webContents.send = () => { throw new Error('frame disposed'); };
  h.windows[0].webContents.emit('did-finish-load'); await flush();
  assert.equal(settled, true); await result;
});

function stitchHarness() {
  class ImageData {
    constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
  }
  class OffscreenCanvas extends ImageData {
    getContext() {
      const canvas = this;
      return {
        putImageData(image, _x, y) { canvas.data.set(image.data, y * canvas.width * 4); },
        drawImage() {}, clearRect() {}, translate() {}, scale() {},
      };
    }
  }
  const filename = path.resolve(__dirname, '../src/renderer/scroller/stitch.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace('export class Stitcher', 'module.exports = class Stitcher'), { module, ImageData, OffscreenCanvas });
  const frame = (offset = 0) => {
    const img = new ImageData(8, 100);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4, row = y + offset;
      img.data.set([(row * 37 + x * 97) % 256, (row * 71 + x * 31) % 256, (row * 137 + x * 47) % 256, 255], i);
    }
    return img;
  };
  return { Stitcher: module.exports, frame };
}

for (const maxHeight of [50, 100, 150, 160]) {
  test(`stitched image never exceeds the configured ${maxHeight}px limit`, () => {
    const { Stitcher, frame } = stitchHarness();
    const stitcher = new Stitcher(8, 100, { maxHeight });
    const first = frame(); let result = stitcher.add(first);
    if (maxHeight > 100) result = stitcher.add(frame(60), 60);
    assert.equal(result.full, true);
    assert.equal(result.height, maxHeight);
    const composed = stitcher.compose(); assert.equal(composed.height, maxHeight);
    assert.deepEqual(composed.data.subarray(0, Math.min(100, maxHeight) * 8 * 4), first.data.subarray(0, Math.min(100, maxHeight) * 8 * 4));
    if (maxHeight > 100) assert.deepEqual(composed.data.subarray(100 * 8 * 4), frame(60).data.subarray(40 * 8 * 4, (maxHeight - 60) * 8 * 4));
  });
}

test('stitching below its limit preserves the full nonduplicated image', () => {
  const { Stitcher, frame } = stitchHarness();
  const stitcher = new Stitcher(8, 100, { maxHeight: 200 });
  stitcher.add(frame()); const result = stitcher.add(frame(60), 60);
  assert.equal(result.full, false); assert.equal(result.height, 160);
  assert.equal(stitcher.compose().height, 160);
});

test('automatic scrolling never moves the page when the first frame fills the height limit', async () => {
  const h = scrollHarness(), starting = h.api.start({ manual: false });
  await h.ready(); h.reply('scroll:init', {}); await starting;
  const running = h.handlers['scroll:start-auto'](); await flush();
  h.reply('scroll:grab', { full: true, height: 100, changed: true }); await running;
  assert.equal(h.scrolls.length, 0);
  h.reply('scroll:finish', { data: null, scale: 1 }); await flush();
  assert(h.windows.every((w) => w.destroyed));
});

for (const failure of ['crash', 'send']) {
  test(`scroller panel ${failure} releases the worker and its pending requests`, async () => {
    const h = scrollHarness(); let settled = false;
    const starting = h.api.start({ manual: false }).then(() => { settled = true; }); await h.ready();
    const panel = h.windows.find((w) => w.params.role === 'panel');
    if (failure === 'crash') panel.webContents.emit('render-process-gone');
    else { panel.webContents.send = () => { throw new Error('frame disposed'); }; h.reply('scroll:init', {}); }
    await flush(); assert.equal(settled, true); await starting;
    assert(h.windows.every((w) => w.destroyed)); assert.equal(h.ipcMain.listenerCount('scroll:reply'), 0);
  });
}

function screenSource(id, displayId, label) {
  return { id, display_id: displayId, thumbnail: { getSize: () => ({ width: 100, height: 80 }), toPNG: () => Buffer.from(label) } };
}

test('screenshot capture does not relabel a known different display by array position', async () => {
  const h = captureHarness({ sources: [screenSource('screen:2', '2', 'wrong')] });
  const shots = await h.api.captureAllDisplays();
  assert.equal(shots.length, 0); assert.equal(h.writes.length, 0);
});

test('screenshot capture maps reordered display sources by exact ID', async () => {
  const displays = [1, 2].map((id) => ({ id, bounds: { x: id === 1 ? 0 : -100, y: 0, width: 100, height: 80 }, size: { width: 100, height: 80 }, scaleFactor: 1 }));
  const h = captureHarness({ displays, sources: [screenSource('screen:2', '2', 'second'), screenSource('screen:1', '1', 'first')] });
  const shots = await h.api.captureAllDisplays();
  assert.deepEqual(Array.from(shots, (shot) => shot.display.id), [1, 2]);
  assert.deepEqual(h.writes.map((write) => write.data.toString()), ['first', 'second']);
});
