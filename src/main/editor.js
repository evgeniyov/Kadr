'use strict';
// Annotation editor: window management and editor-specific IPC.
//
//   openEditor({ imagePath, scale, meta, options }) → BrowserWindow
//   prepareEditor() / discardPreparedEditor() around a capture that ends in the editor
//   IPC: editor:ready, editor:import-image, editor:export-gif

const fs = require('fs');
const { writeFileAtomic } = require('./atomic-file');
const path = require('path');
const { app, screen, nativeImage, dialog, BrowserWindow } = require('electron');
const ctx = require('./context');

// Editor settings that are not part of the core defaults.
const EXTRA_DEFAULTS = {
  closeOnCopy: true, // ⌘C / Copy button closes the editor after copying (like Shottr)
  opacity: 1,
  shadow: true,
  rectRadius: 0,
  ovalFill: 'outline',
  spotlightShape: 'rect',
  spotlightDim: 0.55,
  magnifierZoom: 2,
  rulerUnit: 'px',
  unit: 'px',
  wandTolerance: 32,
  wandSample: 1,
  wandContiguous: true,
  wandAntialias: true,
  lassoShape: 'free',
  bgTolerance: 30,
};

const CHROME_H = 42 + 38 + 26; // toolbar + property bar + status bar
const CANVAS_PAD = 56;
const BACKDROP_PANEL_W = 268;
const MIN_W = 760;
const MIN_H = 520;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const readyCallbacks = new Map(); // webContents.id → () => void
const documents = new Map(); // webContents.id → close and save state for the document

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function isInside(dir, file) {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error('expected binary data');
}

// Pixel size of an image; reads the PNG header directly (fast), falls back to nativeImage.
function imageSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    /* fall through */
  }
  const s = nativeImage.createFromPath(file).getSize();
  return s.width ? s : { width: 800, height: 600 };
}

function assetsDir() {
  const dir = path.join(ctx.paths.userData, 'editor-assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Images must live inside userData to be loadable through kadr:// URLs.
function ensureInUserData(file) {
  if (isInside(ctx.paths.userData, file)) return file;
  const dst = path.join(assetsDir(), `${ctx.newId()}${path.extname(file).toLowerCase() || '.png'}`);
  fs.copyFileSync(file, dst);
  return dst;
}

// Keep only the few most recent imported backdrop images (plus the one in use).
async function pruneAssets(keep) {
  try {
    const dir = assetsDir();
    const inUse = ctx.settings.get('editor.backdrop.imagePath');
    const files = await Promise.all(
      (await fs.promises.readdir(dir)).map(async (name) => {
        const p = path.join(dir, name);
        return { p, t: (await fs.promises.stat(p)).mtimeMs };
      }),
    );
    files.sort((a, b) => b.t - a.t);
    for (const f of files.slice(keep)) if (f.p !== inUse) await fs.promises.rm(f.p, { force: true });
  } catch (e) {
    console.warn('[editor] prune assets failed', e.message);
  }
}

function backdropImageUrl() {
  const p = ctx.settings.get('editor.backdrop.imagePath');
  if (!p || !isInside(ctx.paths.userData, p) || !fs.existsSync(p)) return null;
  return ctx.dataUrl(p);
}

// A capture in progress gets its editor window right away, hidden: the page loads while the
// user is still selecting, and the picked image is handed over the moment it exists. The
// renderer asks for its params first thing (win:params), so it simply waits for them.
let prepared = null; // { win, resolve, activate }

function editorWindow(params, bounds, minSize, title) {
  const win = ctx.createWindow('editor', {
    params,
    ...bounds,
    useContentSize: true,
    minWidth: minSize.width,
    minHeight: minSize.height,
    title,
    show: false,
    fullscreenable: true,
    ...(ctx.isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
  });
  const wc = win.webContents;
  if (params.meta?.filePath) ctx.grantPath(wc, params.meta.filePath);
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const id = wc.id;
  win.on('closed', () => {
    readyCallbacks.delete(id);
    documents.delete(id);
  });
  return win;
}

// Shows the window once the page has painted AND the renderer reports the image is laid out.
// A prepared window waits for activate(): until then it has no image and never shows.
function showWhenReady(win, { waitForImage = false } = {}) {
  let painted = false;
  let ready = false;
  let shown = false;
  let active = !waitForImage;
  const show = () => {
    if (shown || !active || win.isDestroyed()) return;
    shown = true;
    if (ctx.isMac) app.focus({ steal: true });
    win.show();
    win.focus();
  };
  readyCallbacks.set(win.webContents.id, () => {
    ready = true;
    // A prepared page painted before it had the image: give it a frame to draw it.
    if (painted) setTimeout(show, waitForImage ? 20 : 0);
  });
  win.once('ready-to-show', () => {
    painted = true;
    if (ready) show();
    else if (active) setTimeout(show, 1500);
  });
  const armFallback = () => setTimeout(show, 5000); // never leave an invisible window behind
  if (active) armFallback();
  return () => {
    active = true;
    armFallback();
    if (painted && !ready) setTimeout(show, 1500);
  };
}

/** Called when a capture that ends in the editor starts. */
function prepareEditor() {
  if (prepared && !prepared.win.isDestroyed()) return;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  let resolve;
  const params = new Promise((r) => (resolve = r));
  const win = editorWindow(params, { width: MIN_W, height: MIN_H, x: wa.x, y: wa.y }, { width: MIN_W, height: MIN_H }, 'Kadr');
  prepared = { win, resolve, activate: showWhenReady(win, { waitForImage: true }) };
  win.on('closed', () => {
    if (prepared?.win === win) prepared = null;
  });
}

/** The capture ended without an editor (cancelled, failed, copied only…). */
function discardPreparedEditor() {
  const p = prepared;
  prepared = null;
  if (p && !p.win.isDestroyed()) p.win.destroy();
}

/** Is a prepared editor window waiting for its image? */
function hasPrepared() {
  return !!prepared && !prepared.win.isDestroyed();
}

// pixels: { width, height, data: BGRA } — handed to a prepared window instead of loading
// imagePath, which may still be being written.
function openEditor({ imagePath, scale = 1, meta = {}, options = {}, usePrepared = false, pixels = null } = {}) {
  if (!pixels && (!imagePath || !fs.existsSync(imagePath))) throw new Error(`editor: image not found: ${imagePath}`);
  const file = pixels ? imagePath : ensureInUserData(imagePath);
  const s = Number(scale) > 0 ? Number(scale) : 1;
  const size = pixels ? { width: pixels.width, height: pixels.height } : imageSize(file);

  // Size the window to show the image at real size (1/scale) where possible.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const bd = ctx.settings.get('editor.backdrop') || {};
  const backdrop = !!(options.backdrop || bd.enabled);
  const bdPad = backdrop ? (bd.padding ?? 64) * 2 : 0;
  const maxW = Math.floor(wa.width * 0.9);
  const maxH = Math.floor(wa.height * 0.9);
  const width = clamp(Math.round(size.width / s + CANVAS_PAD + bdPad + (backdrop ? BACKDROP_PANEL_W : 0)), Math.min(MIN_W, maxW), maxW);
  const height = clamp(Math.round(size.height / s + CANVAS_PAD + bdPad + CHROME_H), Math.min(MIN_H, maxH), maxH);
  const bounds = { width, height, x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2) };
  const minSize = { width: Math.min(MIN_W, maxW), height: Math.min(MIN_H, maxH) };
  const title = meta?.fileName || 'Kadr';
  const imageUrl = ctx.dataUrl(file);
  const params = {
    imagePath: file,
    imageUrl: meta?.libraryId ? `${imageUrl}?v=${meta.libraryVersion ?? 0}` : imageUrl,
    scale: s,
    meta: meta || {},
    options: options || {},
    backdropImageUrl: backdropImageUrl(),
    dev: process.argv.includes('--dev'),
  };

  let win;
  const p = usePrepared ? prepared : null;
  if (p && !p.win.isDestroyed()) {
    prepared = null;
    win = p.win;
    win.setMinimumSize(minSize.width, minSize.height);
    win.setContentBounds(bounds);
    win.setTitle(title);
    // Keep pixels available for late win:params requests until the renderer is ready.
    const delivered = pixels ? { ...params, pixels } : params;
    const entry = ctx.entryFor(win.webContents);
    if (entry) entry.params = delivered;
    p.resolve(delivered);
    p.activate();
  } else {
    if (pixels) throw new Error('editor: pixels need a prepared window');
    win = editorWindow(params, bounds, minSize, title);
    showWhenReady(win);
  }
  trackDocument(win, meta?.filePath);
  return win;
}

function trackDocument(win, filePath) {
  const id = win.webContents.id;
  const state = { filePath, dirty: false, forceClose: false, closePhase: null };
  documents.set(id, state);
  if (ctx.isMac && filePath) win.setRepresentedFilename(filePath);
  win.webContents.on('render-process-gone', () => {
    if (state.closePhase === 'saving') state.closePhase = null;
  });
  win.on('close', (e) => {
    if (state.forceClose || (!state.dirty && !state.closePhase)) return;
    e.preventDefault();
    if (state.closePhase) return;
    state.closePhase = 'prompting';
    dialog
      .showMessageBox(win, {
        type: 'warning',
        message: filePath
          ? ctx.t('editor.unsaved.title', { name: path.basename(filePath) })
          : ctx.t('editor.unsaved.capture'),
        detail: ctx.t('editor.unsaved.detail'),
        buttons: [ctx.t('editor.unsaved.save'), ctx.t('editor.unsaved.discard'), ctx.t('common.cancel')],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return;
        if (response === 0) {
          win.webContents.send('editor:save-and-close');
          state.closePhase = 'saving';
        } else if (response === 1) {
          state.forceClose = true;
          win.close();
        }
      })
      .catch((error) => console.error('[editor] close confirmation failed', error))
      .finally(() => {
        if (state.closePhase === 'prompting') state.closePhase = null;
      });
  });
}

async function exportGif(e, { frames, delay = 1000, maxWidth = 1600 } = {}) {
  const ffmpeg = require('./ffmpeg');
  if (!Array.isArray(frames) || !frames.length || frames.length > 100) throw new Error('invalid frames');
  const dir = await fs.promises.mkdtemp(path.join(ctx.paths.tmp, 'gif-'));
  try {
    await Promise.all(frames.map((f, i) => fs.promises.writeFile(path.join(dir, `f${i + 1}.png`), toBuffer(f))));
    const out = path.join(dir, 'out.gif');
    const fps = 1000 / clamp(Number(delay) || 1000, 50, 10000);
    const w = Math.max(16, Math.round(Number(maxWidth) || 1600));
    await ffmpeg.run([
      '-framerate', String(fps),
      '-i', path.join(dir, 'f%d.png'),
      '-filter_complex', `[0:v]scale='min(${w},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`,
      '-loop', '0',
      out,
    ]);
    return await fs.promises.readFile(out);
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function importImage(e, { path: src } = {}) {
  if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error('invalid path');
  ctx.assertPath(e.sender, src);
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new Error('unsupported image type');
  const st = await fs.promises.stat(src);
  if (!st.isFile() || st.size > 200 * 1024 * 1024) throw new Error('invalid image file');
  const dst = path.join(assetsDir(), `${ctx.newId()}${ext}`);
  await fs.promises.copyFile(src, dst);
  pruneAssets(6);
  return { path: dst, url: ctx.dataUrl(dst) };
}

function register() {
  ctx.settings.registerDefaults('editor', EXTRA_DEFAULTS);
  ctx.handle('editor:ready', (e) => {
    const entry = ctx.entryFor(e.sender);
    if (entry?.params) delete entry.params.pixels;
    readyCallbacks.get(e.sender.id)?.();
  });
  ctx.handle('editor:dirty', (e, dirty) => {
    const st = documents.get(e.sender.id);
    if (!st) return;
    st.dirty = !!dirty;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (ctx.isMac && win) win.setDocumentEdited(st.dirty);
  });
  ctx.handle('editor:close-save-finished', (e, saved) => {
    const st = documents.get(e.sender.id);
    if (st?.closePhase !== 'saving') return;
    st.closePhase = null;
    if (saved === true) BrowserWindow.fromWebContents(e.sender)?.close();
  });
  // Only the file this editor window was opened with can be overwritten.
  ctx.handle('editor:save-original', async (e, { data }) => {
    const st = documents.get(e.sender.id);
    if (!st?.filePath) throw new Error('not editing a file');
    await writeFileAtomic(st.filePath, toBuffer(data));
    // The renderer clears dirty only if no newer edit arrived during the save.
    return st.filePath;
  });
  ctx.handle('editor:import-image', importImage);
  ctx.handle('editor:export-gif', exportGif);
}

module.exports = { register, openEditor, prepareEditor, discardPreparedEditor, hasPrepared };
