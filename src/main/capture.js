'use strict';
// Screenshot capture: frozen-screen overlays, area/window/fullscreen modes,
// region selection for other modules and the after-capture pipeline.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app, screen, desktopCapturer, nativeImage, systemPreferences } = require('electron');
const clip = require('./clip');
const ctx = require('./context');

const IMAGE_MODES = new Set(['area', 'window', 'fullscreen', 'activeWindow', 'repeatArea', 'delayed']);

let busy = false; // one capture session at a time
let lastArea = null; // { displayId, rect } for "repeat area"
const overlays = new Map(); // displayId -> BrowserWindow
let session = null; // current overlay session { resolve, displays, purpose }

// ---------------------------------------------------------------------------
// Display capture
// ---------------------------------------------------------------------------

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))));
}

// Capture every display → [{ display, file, pixelWidth, pixelHeight }]
// Other Kadr windows (editor, video editor, pins) stay capturable like any other app.
async function captureAllDisplays({ cursor = false } = {}) {
  const displays = screen.getAllDisplays();
  const stamp = Date.now();
  const native = ctx.modules.native;

  if (ctx.isMac) {
    // Preferred: ScreenCaptureKit helper (exact CGDirectDisplayID mapping).
    if (native?.capabilities?.().captureDisplays) {
      try {
        const res = await native.captureDisplays({ cursor });
        if (res && res.length) {
          return res
            .map((r) => ({ display: displays.find((d) => String(d.id) === String(r.displayId)), file: r.path, pixelWidth: r.pixelWidth, pixelHeight: r.pixelHeight }))
            .filter((r) => r.display);
        }
      } catch (e) {
        console.warn('[capture] helper captureDisplays failed, falling back to screencapture', e.message);
      }
    }
    // Fallback: the system `screencapture` tool, one rect per display.
    const targets = displays.map((display) => ({
      display,
      file: path.join(ctx.paths.captures, `screen-${display.id}-${stamp}.png`),
    }));
    const results = await Promise.allSettled(
      targets.map(async ({ display, file }) => {
        const { x, y, width, height } = display.bounds;
        const args = ['-x', '-r', '-t', 'png', `-R${x},${y},${width},${height}`];
        if (cursor) args.push('-C');
        await execFileP('/usr/sbin/screencapture', [...args, file]);
        const img = nativeImage.createFromBuffer(fs.readFileSync(file));
        const s = img.getSize();
        return { display, file, pixelWidth: s.width, pixelHeight: s.height };
      })
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      await Promise.all(targets.map(({ file }) => fs.promises.unlink(file).catch(() => {})));
      throw failure.reason;
    }
    return results.map((result) => result.value);
  }

  // Windows / Linux: desktopCapturer thumbnails at physical resolution.
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
  const byOrder = sources.length === displays.length && sources.every((s) => !s.display_id);
  return displays
    .map((d, i) => {
      const src = sources.find((s) => String(s.display_id) === String(d.id)) || (byOrder ? sources[i] : null);
      if (!src) return null;
      let img = src.thumbnail;
      const pw = Math.round(d.size.width * d.scaleFactor);
      const ph = Math.round(d.size.height * d.scaleFactor);
      const s = img.getSize();
      if (s.width !== pw || s.height !== ph) img = img.resize({ width: pw, height: ph, quality: 'best' });
      const file = path.join(ctx.paths.captures, `screen-${d.id}-${stamp}.png`);
      fs.writeFileSync(file, img.toPNG());
      return { display: d, file, pixelWidth: pw, pixelHeight: ph };
    })
    .filter(Boolean);
}

function looksBlank(file) {
  // A capture without Screen Recording permission on macOS contains only the wallpaper
  // or is fully black. We only detect the fully-black case cheaply.
  try {
    const img = nativeImage.createFromBuffer(fs.readFileSync(file)).resize({ width: 64 });
    const bmp = img.toBitmap();
    for (let i = 0; i < bmp.length; i += 4) if (bmp[i] > 8 || bmp[i + 1] > 8 || bmp[i + 2] > 8) return false;
    return true;
  } catch {
    return false;
  }
}

function hasScreenPermission() {
  if (!ctx.isMac) return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

function warnScreenPermission() {
  ctx.notify(ctx.t('notify.permissionScreen'), ctx.t('notify.permissionScreenBody'), {
    onClick: () => require('electron').shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
  });
}

function cleanupFrozen(shots) {
  for (const s of shots || []) {
    s.done = true;
    s.image = null;
    fs.promises.unlink(s.file).catch(() => {});
  }
}

// Decoding a frozen display image takes 30–90 ms: done while the user is still selecting,
// so the crop after the click is instant. (A little later than the capture, so the overlay
// gets the image file from us first.)
function predecode(shots, delay = 150) {
  setTimeout(() => {
    for (const s of shots || []) {
      if (s.image || s.done) continue;
      try {
        s.image = nativeImage.createFromBuffer(fs.readFileSync(s.file));
      } catch {
        /* cropped from the file later */
      }
    }
  }, delay);
}

function cropShot(shot, pixelRect) {
  const img = shot.image || nativeImage.createFromBuffer(fs.readFileSync(shot.file));
  return img.crop(pixelRect);
}

// DIP rect relative to the display → pixel rect in the display capture.
function toPixelRect(rect, shot) {
  const sx = shot.pixelWidth / shot.display.bounds.width;
  const sy = shot.pixelHeight / shot.display.bounds.height;
  const x = Math.max(0, Math.round(rect.x * sx));
  const y = Math.max(0, Math.round(rect.y * sy));
  return {
    x,
    y,
    width: Math.max(1, Math.min(shot.pixelWidth - x, Math.round(rect.width * sx))),
    height: Math.max(1, Math.min(shot.pixelHeight - y, Math.round(rect.height * sy))),
  };
}

// ---------------------------------------------------------------------------
// Overlay windows (one per display, reused between sessions)
// ---------------------------------------------------------------------------

function createOverlay(display) {
  const { x, y, width, height } = display.bounds;
  const win = ctx.createWindow('overlay', {
    params: { displayId: display.id },
    x,
    y,
    width,
    height,
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
    enableLargerThanScreen: true,
    roundedCorners: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    type: ctx.isMac ? 'panel' : undefined,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (ctx.isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setContentProtection(true); // never appear in our own captures / recordings
  win.on('closed', () => {
    if (overlays.get(String(display.id)) === win) {
      overlays.delete(String(display.id));
      finishSession(null);
    }
  });
  const failed = () => {
    if (overlays.get(String(display.id)) !== win) return;
    finishSession(null);
    // Recreate failed renderers on the next capture, including after a load error.
    if (!win.isDestroyed()) win.destroy();
  };
  win.webContents.on('render-process-gone', failed);
  win.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame !== false) failed();
  });
  overlays.set(String(display.id), win);
  return win;
}

function ensureOverlays() {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => String(d.id)));
  for (const [id, w] of overlays) {
    if (!ids.has(id) || w.isDestroyed()) {
      if (!w.isDestroyed()) w.destroy();
      overlays.delete(id);
    }
  }
  let created = false;
  for (const d of displays) {
    const w = overlays.get(String(d.id));
    if (!w) {
      createOverlay(d);
      created = true;
    } else {
      const b = w.getBounds();
      const db = d.bounds;
      if (b.x !== db.x || b.y !== db.y || b.width !== db.width || b.height !== db.height) w.setBounds(db);
    }
  }
  if (created) prepareCapture();
}

// Refresh the helper's cached display metadata before the next capture.
let prepareTimer = null;
function prepareCapture() {
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(() => {
    if (canUseDisplayHelper()) ctx.modules.native.prepareCapture?.();
  }, 300);
}

function waitLoaded(win, s) {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('overlay closed'));
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const loaded = () => done();
    const done = (error) => {
      clearTimeout(timer);
      s.pending.delete(done);
      win.webContents.removeListener('did-finish-load', loaded);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => done(new Error('overlay load timed out')), 30000);
    s.pending.add(done);
    win.webContents.once('did-finish-load', loaded);
  });
}

function hideOverlays() {
  for (const w of overlays.values()) {
    if (w.isDestroyed()) continue;
    try { w.webContents.send('overlay:reset'); } catch { /* a crashed renderer has no frame */ }
    w.hide();
  }
  scheduleOverlayRecycle();
}

// A finished session leaves a full-screen screenshot's worth of memory in the overlay
// renderer and its GPU surfaces (hundreds of MB on Retina) that GC returns only slowly.
// Replacing the hidden overlays with fresh ones (~20 MB each) gets it all back; they are
// ready again long before the next capture.
let recycleTimer = null;
function scheduleOverlayRecycle() {
  clearTimeout(recycleTimer);
  recycleTimer = setTimeout(() => {
    if (session || busy) return scheduleOverlayRecycle();
    for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy();
    overlays.clear();
    ensureOverlays();
  }, 1500);
}

async function windowList({ allLayers = false } = {}) {
  const native = ctx.modules.native;
  if (!native?.listWindows) return [];
  try {
    const list = await native.listWindows({ allLayers });
    return (list || []).filter((w) => w.bounds && (w.layer > 0 || (w.bounds.width > 20 && w.bounds.height > 20)));
  } catch (e) {
    console.warn('[capture] listWindows failed', e.message);
    return [];
  }
}

/**
 * Show overlays and let the user pick something.
 * opts: { purpose: 'area'|'window'|'ocr'|'scroll'|'record'|'color'|'return', shots?, windows?, live?, snapshot? }
 * resolves: null | { displayId, rect, windowId?, color? }
 */
async function runOverlay(opts) {
  ensureOverlays();
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursor);

  return new Promise((resolve, reject) => {
    const s = { resolve, reject, purpose: opts.purpose, pending: new Set() };
    session = s;
    const ready = new Set();
    const total = displays.length;
    const main = overlays.get(String(cursorDisplay.id));
    let shown = false;
    const focusMain = () => {
      if (session !== s || !main || main.isDestroyed()) return;
      main.show();
      if (ctx.isMac) app.focus({ steal: true });
      main.focus();
      main.webContents.focus();
    };
    const showAll = () => {
      if (session !== s || shown) return;
      shown = true;
      for (const d of displays) {
        const w = overlays.get(String(d.id));
        if (!w || w.isDestroyed()) continue;
        w.setBounds(d.bounds);
        if (w !== main) w.showInactive();
      }
      focusMain();
    };
    const initialize = async () => {
      // A visible overlay can dismiss hover UI even without taking focus.
      // Wait for the snapshot before arming either path that shows the overlay.
      const { shots, windows } = opts.snapshot ? await opts.snapshot : opts;
      if (session !== s) return;
      s.onReady = (wc) => {
        if (![...overlays.values()].some((w) => w.webContents === wc)) return;
        ready.add(wc);
        if (ready.size === total) showAll();
      };
      s.readyTimer = setTimeout(showAll, 1500);
      for (const d of displays) {
        if (session !== s) return;
        const w = overlays.get(String(d.id));
        await waitLoaded(w, s);
        if (session !== s) return;
        const shot = shots?.find((s) => String(s.display.id) === String(d.id));
        w.webContents.send('overlay:start', {
          purpose: opts.purpose,
          live: !!opts.live,
          displayId: d.id,
          bounds: d.bounds,
          scaleFactor: d.scaleFactor,
          imageUrl: shot ? ctx.dataUrl(shot.file) : null,
          pixelWidth: shot?.pixelWidth,
          pixelHeight: shot?.pixelHeight,
          windowMode: !!opts.windowMode,
          windows: windowsFor(d, windows),
          colorFormat: ctx.settings.get('colorFormat'),
          blocks: ctx.settings.get('detectBlocks') !== false,
          cursor: { x: cursor.x - d.bounds.x, y: cursor.y - d.bounds.y },
          lastRegion: opts.purpose === 'record' ? ctx.settings.get('recording.lastRegion') : null,
        });
      }
    };
    initialize().catch((error) => finishSession(null, s, error));
  });
}

function windowsFor(d, windows) {
  if (!windows) return [];
  return windows.filter((win) => !win.layer).map((win) => {
    const rect = relativeRect(win.bounds, d.bounds);
    const selection = windowCrop(win, d.bounds, windows);
    return {
      id: win.id,
      title: win.title,
      appName: win.appName,
      rect, // hit-testing and block detection use the original window bounds
      ...(selection?.hasTransient && { captureRect: selection.rect }),
    };
  });
}

function relativeRect(bounds, display) {
  return { ...bounds, x: bounds.x - display.x, y: bounds.y - display.y };
}

function visibleEdges(bounds, display) {
  const rect = relativeRect(bounds, display);
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(display.width, rect.x + rect.width);
  const bottom = Math.min(display.height, rect.y + rect.height);
  return left < right && top < bottom ? { left, top, right, bottom } : null;
}

function windowCrop(win, display, windows = []) {
  const base = visibleEdges(win.bounds, display);
  if (!base) return null;
  let { left, top, right, bottom } = base;
  let hasTransient = false;
  for (const popup of windows) {
    if (!(popup.layer > 0 && win.pid > 0 && popup.pid === win.pid)) continue;
    const p = visibleEdges(popup.bounds, display);
    if (!p || p.right < base.left || p.left > base.right || p.bottom < base.top || p.top > base.bottom) continue;
    left = Math.min(left, p.left);
    top = Math.min(top, p.top);
    right = Math.max(right, p.right);
    bottom = Math.max(bottom, p.bottom);
    hasTransient = true;
  }
  return { rect: { x: left, y: top, width: right - left, height: bottom - top }, hasTransient };
}

function canUseDisplayHelper() {
  return ctx.isMac && !!ctx.modules.native?.capabilities?.().captureDisplays && hasScreenPermission();
}

async function captureBeforeOverlay({ purpose, windowMode = false, withWindows = true }) {
  const snapshot = Promise.all([
    captureAllDisplays({ cursor: ctx.settings.get('captureCursor') }),
    withWindows ? windowList({ allLayers: true }) : [],
  ]).then(([shots, windows]) => {
    predecode(shots, 300);
    return { shots, windows };
  });
  const [overlay, captured] = await Promise.allSettled([
    runOverlay({ purpose, windowMode, snapshot }),
    snapshot,
  ]);
  if (captured.status === 'rejected') throw captured.reason;
  const { shots, windows } = captured.value;
  if (overlay.status === 'rejected') {
    cleanupFrozen(shots);
    throw overlay.reason;
  }
  return { res: overlay.value, shots, windows };
}

function finishSession(result, expected = session, error) {
  if (!session || session !== expected) return;
  const s = session;
  session = null;
  clearTimeout(s.readyTimer);
  for (const cancel of [...s.pending]) cancel(new Error('overlay cancelled'));
  hideOverlays();
  error ? s.reject(error) : s.resolve(result);
}

// ---------------------------------------------------------------------------
// After-capture pipeline
// ---------------------------------------------------------------------------

function playShutter() {
  if (!ctx.settings.get('playSound')) return;
  try {
    if (ctx.isMac) {
      const f = '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif';
      if (fs.existsSync(f)) spawn('/usr/bin/afplay', [f], { detached: true, stdio: 'ignore' }).unref();
    } else if (ctx.isWin) {
      const wav = path.join(ctx.paths.appRoot, 'build', 'shutter.wav');
      const file = app.isPackaged ? path.join(process.resourcesPath, 'shutter.wav') : wav;
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    }
  } catch {
    /* sound is optional */
  }
}

async function encodeForSave(img, format, quality) {
  if (format === 'jpg') return { data: img.toJPEG(quality), ext: 'jpg' };
  if (format === 'webp') {
    // No native WebP encoder in Electron's main process — use ffmpeg.
    try {
      const src = path.join(ctx.paths.tmp, `${ctx.newId()}.png`);
      const dst = src.replace(/\.png$/, '.webp');
      fs.writeFileSync(src, img.toPNG());
      await require('./ffmpeg').run(['-i', src, '-c:v', 'libwebp', '-quality', String(quality), '-lossless', quality >= 100 ? '1' : '0', dst]);
      const data = fs.readFileSync(dst);
      fs.promises.unlink(src).catch(() => {});
      fs.promises.unlink(dst).catch(() => {});
      return { data, ext: 'webp' };
    } catch (e) {
      console.warn('[capture] webp encode failed, saving png', e.message);
    }
  }
  return { data: img.toPNG(), ext: 'png' };
}

/**
 * Deliver a fresh capture: clipboard / save / library / editor|preview.
 * img: nativeImage (pixels), meta: { source, scale, appName?, windowTitle? }, options: editor options
 */
async function deliver(img, meta = {}, options = {}, { usePrepared = false } = {}) {
  const s = ctx.settings.get();
  const autoCopy = s.copyAfterCapture ? clip.deferImageWrite() : null;
  let scale = meta.scale || 1;
  if (s.downscaleRetina && scale > 1) {
    const size = img.getSize();
    img = img.resize({ width: Math.round(size.width / scale), height: Math.round(size.height / scale), quality: 'best' });
    scale = 1;
  }
  const editor = ctx.modules.editor;
  const library = ctx.modules.library;
  const useLibrary = !!(s.library.enabled && library?.add);

  // Fast path into the prepared editor: it gets the raw pixels (no PNG encode and decode on
  // the way), and the PNG for the library and the clipboard is made once it is on screen.
  // Opaque captures only: raw pixels are premultiplied, a window's shadow would darken.
  if (s.afterCapture === 'editor' && usePrepared && meta.source !== 'window' && editor?.hasPrepared?.()) {
    const id = ctx.newId();
    const imagePath = useLibrary ? library.pathFor(id) : path.join(ctx.paths.captures, `${id}.png`);
    const { width, height } = img.getSize();
    const win = editor.openEditor({
      imagePath,
      scale,
      meta: { ...meta, scale, libraryId: useLibrary ? id : null },
      options,
      usePrepared: true,
      pixels: { width, height, data: img.toBitmap() },
    });
    playShutter();
    await shown(win, 600);
    const png = img.toPNG();
    if (useLibrary) await library.add(png, { ...meta, scale }, { id });
    else await fs.promises.writeFile(imagePath, png);
    await copyAndSave(s, img, png, meta, autoCopy);
    return { imagePath, libraryId: useLibrary ? id : null };
  }

  const png = img.toPNG();
  playShutter();

  // Library keeps the canonical file; otherwise a temp capture file.
  let imagePath;
  let libraryId = null;
  if (useLibrary) {
    const item = await library.add(png, { ...meta, scale });
    imagePath = item.path;
    libraryId = item.id;
  } else {
    imagePath = path.join(ctx.paths.captures, `${ctx.newId()}.png`);
    await fs.promises.writeFile(imagePath, png);
  }

  // The editor first: it is what the user waits for. Clipboard and auto-save follow.
  const fullMeta = { ...meta, scale, libraryId };
  if (s.afterCapture === 'editor' && editor?.openEditor) {
    editor.openEditor({ imagePath, scale, meta: fullMeta, options, usePrepared });
    await copyAndSave(s, img, png, meta, autoCopy);
    return { imagePath, libraryId };
  }
  const { savedPath, copied } = await copyAndSave(s, img, png, meta, autoCopy);
  if (s.afterCapture === 'preview' && ctx.modules.preview?.show) {
    ctx.modules.preview.show({ imagePath, scale, meta: { ...fullMeta, savedPath }, options });
  } else {
    const parts = [];
    if (copied) parts.push(ctx.t('notify.copied'));
    if (savedPath) parts.push(ctx.t('notify.saved', { name: path.basename(savedPath) }));
    if (parts.length) ctx.notify('Kadr', parts.join('\n'));
  }
  return { imagePath, libraryId };
}

// Resolves when the window is on screen (or after `ms`, or when it is gone).
function shown(win, ms) {
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.isVisible()) return resolve();
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, ms);
    win.once('show', done);
    win.once('closed', done);
  });
}

// Clipboard and auto-save after a capture.
async function copyAndSave(s, img, png, meta, autoCopy) {
  let copied = false;
  let savedPath = null;
  try {
    if (autoCopy) copied = await autoCopy(png);
  } catch (e) {
    console.error('[capture] clipboard failed', e);
  }
  if (!s.saveAfterCapture) return { copied, savedPath };
  try {
    const { data, ext } = await encodeForSave(img, s.imageFormat, s.jpgQuality);
    savedPath = await require('./basics').saveBytes({
      data, ext, folder: s.saveFolder,
      name: ctx.formatFileName(s.fileNameTemplate, { app: meta.appName }),
    });
  } catch (e) {
    console.error('[capture] auto-save failed', e);
  }
  return { copied, savedPath };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function captureLiveWindow(win) {
  const native = ctx.modules.native;
  const wc = ctx.settings.get('windowCapture');
  if (ctx.isMac && native?.capabilities?.().captureWindow) {
    try {
      const res = await native.captureWindow(win.id, { shadow: wc.shadow });
      if (res?.png) return { img: nativeImage.createFromBuffer(res.png), scale: res.scale || 2 };
    } catch (e) {
      console.warn('[capture] native captureWindow failed', e.message);
    }
  }
  if (ctx.isMac) {
    // Fallback: screencapture -l<windowid> (captures the window even when covered).
    try {
      const file = path.join(ctx.paths.captures, `win-${ctx.newId()}.png`);
      const args = ['-x', '-r', '-t', 'png', `-l${win.id}`];
      if (!wc.shadow) args.push('-o');
      await execFileP('/usr/sbin/screencapture', [...args, file]);
      const img = nativeImage.createFromBuffer(fs.readFileSync(file));
      fs.promises.unlink(file).catch(() => {});
      if (!img.isEmpty()) {
        const d = screen.getDisplayMatching(win.bounds);
        return { img, scale: d.scaleFactor };
      }
    } catch (e) {
      console.warn('[capture] screencapture -l failed', e.message);
    }
  }
  if (ctx.isWin && native?.capabilities?.().captureWindow) {
    try {
      const res = await native.captureWindow(win.id, { shadow: false });
      if (res?.png) return { img: nativeImage.createFromBuffer(res.png), scale: res.scale || 1 };
    } catch (e) {
      console.warn('[capture] native captureWindow failed', e.message);
    }
  }
  return null;
}

function prepareToCapture() {
  // Hide transient UI (previews) so it doesn't end up in the shot.
  ctx.modules.preview?.hideAll?.();
}

async function start({ mode = 'area', return: returnResult = false } = {}) {
  if (busy) return null;
  if (mode === 'record') return ctx.modules.recording?.openPanel?.();
  if (mode === 'scrolling' || mode === 'scrollingUp' || mode === 'scrollingManual') {
    return ctx.modules.scrollCapture?.start?.({ direction: mode === 'scrollingUp' ? 'up' : 'down', manual: mode === 'scrollingManual' ? true : undefined });
  }
  busy = true;
  let shots = null;
  // Captures that end in the editor get its window ahead (see editor.prepareEditor).
  const editor = ctx.modules.editor;
  const toEditor = !returnResult && !['colorPicker', 'ocr', 'translate'].includes(mode) && ctx.settings.get('afterCapture') === 'editor' && !!editor?.prepareEditor;
  let delivered = false;
  try {
    prepareToCapture();
    if (mode === 'delayed') await countdown(3);
    if (toEditor) editor.prepareEditor();

    if (mode === 'colorPicker') {
      let res;
      if (canUseDisplayHelper()) ({ res, shots } = await captureBeforeOverlay({ purpose: 'color', withWindows: false }));
      else {
        shots = await captureAllDisplays();
        if (shots.length && looksBlank(shots[0].file) && !hasScreenPermission()) warnScreenPermission();
        res = await runOverlay({ purpose: 'color', shots });
      }
      if (res?.color) {
        await clip.writeText(res.color);
        ctx.notify(ctx.t('notify.colorCopied', { color: res.color }));
      }
      return null;
    }

    if (mode === 'activeWindow') {
      const native = ctx.modules.native;
      const win = await native?.activeWindow?.().catch(() => null);
      shots = await captureAllDisplays({ cursor: ctx.settings.get('captureCursor') });
      if (!win) {
        mode = 'fullscreen';
      } else {
        const live = await captureLiveWindow(win);
        if (live) return finishWindow(win, live.img, live.scale, { backdrop: ctx.settings.get('windowCapture.backdrop') });
        const d = screen.getDisplayMatching(win.bounds);
        const shot = shots.find((s) => String(s.display.id) === String(d.id));
        const selection = shot && windowCrop(win, shot.display.bounds);
        if (!selection) throw new Error('window capture failed');
        return finishWindow(win, cropShot(shot, toPixelRect(selection.rect, shot)), shot.pixelWidth / shot.display.bounds.width);
      }
    }

    if (mode === 'repeatArea') {
      if (!lastArea) {
        ctx.notify(ctx.t('notify.noRepeatArea'));
        return null;
      }
      shots = await captureAllDisplays({ cursor: ctx.settings.get('captureCursor') });
      const shot = shots.find((s) => String(s.display.id) === String(lastArea.displayId));
      if (!shot) return null;
      const img = cropShot(shot, toPixelRect(lastArea.rect, shot));
      return finish(img, { source: 'area', scale: shot.pixelWidth / shot.display.bounds.width });
    }

    if (mode === 'fullscreen') {
      shots = shots || (await captureAllDisplays({ cursor: ctx.settings.get('captureCursor') }));
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const shot = shots.find((s) => String(s.display.id) === String(d.id)) || shots[0];
      if (!shot) throw new Error('no display captured');
      if (looksBlank(shot.file) && !hasScreenPermission()) warnScreenPermission();
      const img = nativeImage.createFromBuffer(fs.readFileSync(shot.file));
      return finish(img, { source: 'fullscreen', scale: shot.pixelWidth / shot.display.bounds.width });
    }

    // Interactive modes: area / window / ocr / delayed
    const textMode = mode === 'ocr' || mode === 'translate';
    const purpose = textMode ? 'ocr' : returnResult ? 'return' : 'area';
    let res;
    let windows;
    if (canUseDisplayHelper()) {
      ({ res, shots, windows } = await captureBeforeOverlay({ purpose, windowMode: mode === 'window' }));
    } else {
      [shots, windows] = await Promise.all([captureAllDisplays({ cursor: ctx.settings.get('captureCursor') }), windowList({ allLayers: true })]);
      if (shots.length && looksBlank(shots[0].file) && !hasScreenPermission()) warnScreenPermission();
      predecode(shots, 300);
      res = await runOverlay({ purpose, shots, windows, windowMode: mode === 'window' });
    }
    if (!res) return null;

    const shot = shots.find((s) => String(s.display.id) === String(res.displayId));
    if (!shot) return null;
    const scale = shot.pixelWidth / shot.display.bounds.width;

    if (res.windowId != null) {
      const win = windows.find((w) => !w.layer && String(w.id) === String(res.windowId));
      const selection = win && windowCrop(win, shot.display.bounds, windows);
      if (selection) {
        if (mode === 'window' && !returnResult && !selection.hasTransient) {
          const live = await captureLiveWindow(win);
          if (live) return finishWindow(win, live.img, live.scale, { backdrop: ctx.settings.get('windowCapture.backdrop') });
        }
        const img = cropShot(shot, toPixelRect(selection.rect, shot));
        if (textMode) return runOcr(img, { translate: mode === 'translate' });
        return finishWindow(win, img, scale);
      }
    }

    const img = cropShot(shot, toPixelRect(res.rect, shot));
    if (textMode) return runOcr(img, { translate: mode === 'translate' });
    lastArea = { displayId: res.displayId, rect: res.rect };
    return finish(img, { source: 'area', scale });
  } catch (e) {
    console.error('[capture] failed', e);
    ctx.notify(ctx.t('notify.captureFailed'), String(e.message || e));
    return null;
  } finally {
    cleanupFrozen(shots);
    if (toEditor && !delivered) editor.discardPreparedEditor();
    busy = false;
  }

  function finishWindow(win, img, scale, options) {
    return finish(img, { source: 'window', scale, appName: win.appName, windowTitle: win.title }, options);
  }

  function finish(img, meta, options) {
    if (returnResult) {
      const size = img.getSize();
      return { data: img.toPNG(), scale: meta.scale, width: size.width, height: size.height };
    }
    delivered = true;
    deliver(img, meta, options, { usePrepared: toEditor }).catch((e) => {
      console.error('[capture] deliver failed', e);
      if (toEditor) editor.discardPreparedEditor();
    });
    return null;
  }
}

async function runOcr(img, { translate = false } = {}) {
  const ocr = ctx.modules.ocr;
  if (!ocr) return null;
  // The first recognition after a long idle can take a while (the system loads its models).
  const slow = setTimeout(() => ctx.notify(ctx.t('notify.ocrWorking')), 2500);
  try {
    const res = await ocr.recognize(img.toPNG());
    clearTimeout(slow);
    if (translate && res.text?.trim()) return copyTranslation(res.text);
    if (res.qr?.length) {
      const text = res.qr.map((q) => q.text).join('\n');
      await clip.writeText(text);
      ctx.notify(ctx.t('notify.qrCopied'), text.slice(0, 200));
    } else if (res.text?.trim()) {
      await clip.writeText(res.text);
      ctx.notify(ctx.t('notify.textCopied'), res.text.slice(0, 200));
    } else {
      ctx.notify(ctx.t('notify.noText'));
    }
  } catch (e) {
    clearTimeout(slow);
    console.error('[capture] OCR failed', e);
    ctx.notify(ctx.t('common.error'), String(e.message || e));
  }
  return null;
}

// "Translate text on screen": recognise, translate, copy the translation.
async function copyTranslation(text) {
  const tr = ctx.modules.translate;
  const res = tr ? await tr.translateText(text) : { error: 'unsupported' };
  if (res.error === 'not-installed') {
    ctx.notify(ctx.t('notify.translateNeedsLanguages'), ctx.t('notify.translateNeedsLanguagesBody'), {
      onClick: () => ctx.modules.settingsWindow?.open('capture'),
    });
    ctx.modules.settingsWindow?.open('capture');
  } else if (res.error) {
    await clip.writeText(text);
    await tr?.openWeb(text, res.to);
  } else {
    await clip.writeText(res.text);
    ctx.notify(ctx.t('notify.translationCopied'), res.text.slice(0, 200));
  }
  return null;
}

// Small centered countdown for delayed screenshots (content-protected → never captured).
async function countdown(seconds) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = 140;
  const win = ctx.createWindow('overlay', {
    page: 'overlay',
    params: { countdown: seconds },
    x: Math.round(d.bounds.x + (d.bounds.width - size) / 2),
    y: Math.round(d.bounds.y + (d.bounds.height - size) / 2),
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  win.once('ready-to-show', () => win.showInactive());
  await new Promise((r) => setTimeout(r, seconds * 1000));
  if (!win.isDestroyed()) win.destroy();
  await new Promise((r) => setTimeout(r, 120));
}

/**
 * Region selection for other modules (recording, scrolling capture).
 * Shows a live (transparent) overlay. Resolves null | { displayId, scaleFactor, displayBounds, rect, global }.
 */
async function selectRegion({ purpose = 'record' } = {}) {
  if (busy) return null;
  busy = true;
  try {
    prepareToCapture();
    const windows = await windowList();
    const res = await runOverlay({ purpose: purpose === 'scroll' ? 'scroll' : 'record', live: true, windows });
    if (!res) return null;
    const d = ctx.displayById(res.displayId);
    const rect = res.rect;
    return {
      displayId: d.id,
      scaleFactor: d.scaleFactor,
      displayBounds: d.bounds,
      rect,
      global: { x: d.bounds.x + rect.x, y: d.bounds.y + rect.y, width: rect.width, height: rect.height },
    };
  } finally {
    busy = false;
  }
}

function register() {
  ctx.handle('capture:start', (e, opts) => start(opts || {}));
  ctx.handle('capture:select-region', (e, opts) => selectRegion(opts || {}));
  ctx.handle('overlay:ready', (e) => session?.onReady?.(e.sender));
  ctx.handle('overlay:done', (e, result) => finishSession(result));
  ctx.handle('overlay:cancel', () => finishSession(null));
  ctx.handle('overlay:copy-color', (e, color) => clip.writeText(color));

  const displaysChanged = () => {
    // Frozen pixels and DIP coordinates belong to the original topology. Restart
    // selection rather than cropping against a moved/resized/disconnected display.
    finishSession(null);
    ensureOverlays();
    prepareCapture();
  };
  screen.on('display-added', displaysChanged);
  screen.on('display-removed', displaysChanged);
  screen.on('display-metrics-changed', displaysChanged);
  ctx.modules.native?.events?.on('helper-ready', prepareCapture);
  // Pre-create overlays so the first capture is instant.
  setTimeout(() => ensureOverlays(), 500);
}

module.exports = { register, start, selectRegion, deliver, captureAllDisplays, runOverlay, IMAGE_MODES, _dev: { hideOverlays }, get lastArea() { return lastArea; } };
