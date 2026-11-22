'use strict';
// Scrolling capture: select a region, then frames are grabbed from a live screen
// stream (hidden worker window) while the content scrolls — automatically via the
// native helper, or manually by the user — and stitched into one tall image.

const { desktopCapturer, globalShortcut, nativeImage, screen, systemPreferences } = require('electron');
const ctx = require('./context');
const { toBuffer } = require('./basics');

let active = null; // { region, worker, panel, frame, manual, direction, stopRequested }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function sourceIdFor(displayId) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  const src = sources.find((s) => String(s.display_id) === String(displayId));
  if (src) return src.id;
  // A positional fallback can silently select a different monitor after hot-plug.
  const displays = screen.getAllDisplays();
  if (sources.length === 1 && displays.length === 1 && String(displays[0].id) === String(displayId) && !sources[0].display_id) return sources[0].id;
  throw new Error('selected display is no longer available');
}

function canAutoScroll() {
  const native = ctx.modules.native;
  if (!native?.capabilities?.().scroll) return false;
  if (ctx.isMac) return systemPreferences.isTrustedAccessibilityClient(false);
  return true;
}

function makeWindows(region, manual, direction, s) {
  const g = region.global;
  const common = {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
  };
  const pad = 4;
  const frame = s.frame = ctx.createWindow('scroller', {
    page: 'scroller',
    params: { role: 'frame', pad },
    ...common,
    x: g.x - pad,
    y: g.y - pad,
    width: g.width + pad * 2,
    height: g.height + pad * 2,
    focusable: false,
    enableLargerThanScreen: true,
  });
  frame.setIgnoreMouseEvents(true);

  // Control panel: to the right of the region if there is room, otherwise left / inside.
  const pw = 260;
  const ph = 330;
  const wa = screen.getDisplayMatching(g).workArea;
  let px = g.x + g.width + 14;
  if (px + pw > wa.x + wa.width) px = g.x - pw - 14;
  if (px < wa.x) px = Math.max(wa.x + 8, g.x + g.width - pw - 12);
  const py = Math.max(wa.y + 8, Math.min(g.y, wa.y + wa.height - ph - 8));
  const panel = s.panel = ctx.createWindow('scroller', {
    page: 'scroller',
    params: { role: 'panel', manual, direction },
    ...common,
    movable: true,
    x: Math.round(px),
    y: Math.round(py),
    width: pw,
    height: ph,
    focusable: true,
  });

  const worker = s.worker = ctx.createWindow('scroller', {
    page: 'scroller',
    params: { role: 'worker' },
    show: false,
    webPreferences: { backgroundThrottling: false },
  });

  for (const w of [frame, panel]) {
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setContentProtection(true); // excluded from the captured stream
    if (ctx.isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  frame.once('ready-to-show', () => { if (!frame.isDestroyed()) frame.showInactive(); });
  panel.once('ready-to-show', () => { if (!panel.isDestroyed()) panel.show(); });
  return { frame, panel, worker };
}

function sendPanel(s, channel, payload) {
  if (active !== s || !s.panel || s.panel.isDestroyed()) return;
  try { s.panel.webContents.send(channel, payload); } catch { closeAll(s); }
}

function closeAll(s = active) {
  if (!s || active !== s) return;
  // Clear ownership before destroying windows: their synchronous close handlers must
  // neither recurse nor close a replacement session.
  active = null;
  s.stopRequested = true;
  for (const cancel of [...s.pending]) cancel(new Error('scroll capture cancelled'));
  for (const w of [s.frame, s.panel, s.worker]) if (w && !w.isDestroyed()) w.destroy();
  try {
    globalShortcut.unregister('Escape');
  } catch {
    /* ignore */
  }
}

function waitWorkerLoaded(s) {
  const win = s.worker;
  if (active !== s || win.isDestroyed()) return Promise.reject(new Error('worker gone'));
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const loaded = () => done();
    const failed = (_event, _code, message) => done(new Error(message || 'worker failed to load'));
    const done = (error) => {
      clearTimeout(timer);
      s.pending.delete(done);
      win.webContents.removeListener('did-finish-load', loaded);
      win.webContents.removeListener('did-fail-load', failed);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => done(new Error('worker load timed out')), 30000);
    s.pending.add(done);
    win.webContents.once('did-finish-load', loaded);
    win.webContents.once('did-fail-load', failed);
  });
}

function workerCall(s, channel, payload) {
  return new Promise((resolve, reject) => {
    if (active !== s || !s.worker || s.worker.isDestroyed()) return reject(new Error('worker gone'));
    const worker = s.worker, ipcMain = require('electron').ipcMain;
    const id = ctx.newId();
    const done = (error, result) => {
      clearTimeout(timer);
      s.pending.delete(done);
      ipcMain.removeListener('scroll:reply', onReply);
      error ? reject(error) : resolve(result);
    };
    const onReply = (e, reply) => {
      if (!ctx.trustedSender(e, 'scroll:reply', 'send') || e.sender !== worker.webContents || reply?.id !== id) return;
      done(reply.error ? new Error(reply.error) : null, reply.result);
    };
    // Permission requests and PNG encoding can be slow, but a dead renderer must
    // not keep the session (and IPC listener) alive indefinitely.
    const timer = setTimeout(() => done(new Error(`${channel} timed out`)), 60000);
    s.pending.add(done);
    ipcMain.on('scroll:reply', onReply);
    try {
      worker.webContents.send(channel, { id, ...payload });
    } catch (e) {
      done(e);
    }
  });
}

async function start({ direction = 'down', manual } = {}) {
  if (active) return;
  const s = { pending: new Set(), stopRequested: false, running: false };
  active = s; // reserve ownership even while the region chooser is open
  try {
    const region = await ctx.modules.capture?.selectRegion({ purpose: 'scroll' });
    if (active !== s) return;
    if (!region) return closeAll(s);

    if (manual === undefined) manual = !ctx.settings.get('scrolling.auto');
    if (!manual && !canAutoScroll()) {
      manual = true;
      ctx.notify(ctx.t('scroll.noAccess'));
      if (ctx.isMac) systemPreferences.isTrustedAccessibilityClient(true);
    }

    Object.assign(s, { region, ...makeWindows(region, manual, direction, s), manual, direction });
    s.worker.on('closed', () => closeAll(s));
    s.worker.webContents.on('render-process-gone', () => closeAll(s));
    s.panel.on('closed', () => closeAll(s));
    s.panel.webContents.on('render-process-gone', () => closeAll(s));
    try {
      globalShortcut.register('Escape', () => { if (active === s) cancel(); });
    } catch {
      /* ignore */
    }

    await waitWorkerLoaded(s);
    if (active !== s) return;
    const sourceId = await sourceIdFor(region.displayId);
    if (active !== s) return;
    await workerCall(s, 'scroll:init', {
      sourceId,
      region: region.rect,
      displayBounds: region.displayBounds,
      scaleFactor: region.scaleFactor,
      direction,
      maxHeight: ctx.settings.get('scrolling.maxHeight'),
    });
    if (active !== s) return;
    s.ready = true;
    sendPanel(s, 'scroll:ready', {});
    if (manual) runManual(s);
  } catch (e) {
    if (active !== s) return;
    console.error('[scroll] init failed', e);
    ctx.notify(ctx.t('notify.captureFailed'), String(e.message || e));
    closeAll(s);
  }
}

async function runManual(s) {
  if (active !== s || s.stopRequested) return;
  s.running = true;
  while (active === s && !s.stopRequested) {
    try {
      const res = await workerCall(s, 'scroll:grab', { expected: 0 });
      sendPanel(s, 'scroll:progress', res);
      if (res.full) break;
    } catch {
      break;
    }
    await wait(140);
  }
  s.running = false;
}

async function runAuto() {
  const s = active;
  if (!s || !s.ready || s.running || s.stopRequested) return;
  s.running = true;
  const native = ctx.modules.native;
  const g = s.region.global;
  const stepDip = Math.max(40, Math.round(g.height * (ctx.settings.get('scrolling.step') || 0.6)));
  const cx = Math.round(g.x + g.width / 2);
  const cy = Math.round(g.y + g.height / 2);
  let still = 0;
  try {
    let res = await workerCall(s, 'scroll:grab', { expected: 0 });
    sendPanel(s, 'scroll:progress', res);
    if (res.full) sendPanel(s, 'scroll:message', ctx.t('scroll.maxReached'));
    while (active === s && !s.stopRequested && !res.full) {
      await native.scroll({ x: cx, y: cy, deltaY: s.direction === 'up' ? -stepDip : stepDip });
      await wait(320);
      if (active !== s || s.stopRequested) break;
      res = await workerCall(s, 'scroll:grab', { expected: Math.round(stepDip * s.region.scaleFactor) });
      sendPanel(s, 'scroll:progress', res);
      if (res.full) {
        sendPanel(s, 'scroll:message', ctx.t('scroll.maxReached'));
        break;
      }
      still = res.changed ? 0 : still + 1;
      if (still >= 2) break; // reached the end of the content
    }
  } catch (e) {
    console.error('[scroll] auto failed', e);
    if (/NO_ACCESS/.test(String(e.code || e.message))) sendPanel(s, 'scroll:message', ctx.t('scroll.noAccess'));
  }
  s.running = false;
  if (active === s && !s.stopRequested) finish();
}

function finish() {
  const s = active;
  if (!s || !s.ready) return;
  if (s.finishing) return s.finishing;
  s.stopRequested = true;
  s.finishing = (async () => {
    while (active === s && s.running) await wait(50);
    if (active !== s) return;
    try {
      const { data, scale } = await workerCall(s, 'scroll:finish', {});
      if (active !== s) return;
      closeAll(s);
      if (!data) return;
      const img = nativeImage.createFromBuffer(toBuffer(data));
      await ctx.modules.capture.deliver(img, { source: 'scrolling', scale }).catch((e) => {
        console.error('[scroll] delivery failed', e);
        ctx.notify(ctx.t('notify.captureFailed'), String(e.message || e));
      });
    } catch (e) {
      if (active !== s) return;
      console.error('[scroll] finish failed', e);
      ctx.notify(ctx.t('notify.captureFailed'), String(e.message || e));
      closeAll(s);
    }
  })();
  return s.finishing;
}

function cancel() {
  if (!active) return;
  active.stopRequested = true;
  closeAll();
}

function register() {
  ctx.handle('scroll:start-auto', () => runAuto());
  ctx.handle('scroll:finish', () => finish());
  ctx.handle('scroll:cancel', () => cancel());
}

module.exports = { register, start, cancel };
