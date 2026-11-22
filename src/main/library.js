'use strict';
// Screenshot library: every capture is kept (if enabled) with a thumbnail and
// recognised text for search.

const fs = require('fs');
const { readJson, writeJson, writeFileAtomic, writeFileAtomicSync } = require('./atomic-file');
const path = require('path');
const { nativeImage, shell, screen } = require('electron');
const clip = require('./clip');
const ctx = require('./context');
const { toBuffer } = require('./basics');

const dir = ctx.paths.library;
const indexFile = path.join(dir, 'index.json');
let items = [];
let saveTimer = null;
const ocrQueue = new Map();
let ocrTimer = null;
let ocrRunning = false;
const pendingOperations = new Set();
let mutationVersion = 0;

const updateChains = new Map();
let saveChain = Promise.resolve();
// Index paths must identify the item's own generated files. A malformed thumb
// must never alias an original PNG or the index during repair/deletion.
const validItems = (data) => Array.isArray(data) && data.every((it) => it &&
  typeof it.id === 'string' && /^[a-z0-9-]+$/i.test(it.id) &&
  it.file === `${it.id}.png` && it.thumb === `${it.id}.thumb.jpg`);

function load() {
  const loaded = readJson(indexFile, validItems);
  items = (loaded.data || []).filter((it) => fs.existsSync(path.join(dir, it.file)));
  for (const it of items) {
    const thumb = path.join(dir, it.thumb);
    if (it.updating || !fs.existsSync(thumb)) {
      if (it.updating) it.text = '';
      // Interrupted redaction must never show an older thumbnail than its PNG.
      try {
        fs.rmSync(thumb, { force: true });
        const img = nativeImage.createFromPath(path.join(dir, it.file));
        if (!img.isEmpty()) {
          writeFileAtomicSync(thumb, makeThumb(img));
          Object.assign(it, img.getSize());
        }
      } catch (e) { console.warn('[library] thumbnail recovery failed', e.message); }
    }
    delete it.updating;
  }
  // A crash can leave a completely valid but older index: pixels are committed
  // before the debounced index save. Look for orphans on every startup.
  {
    const known = new Set(items.map((it) => it.file));
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-z0-9-]+\.png$/i.test(name) || known.has(name)) continue;
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      const id = name.slice(0, -4);
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) continue;
      const { width, height } = img.getSize();
      const thumb = `${id}.thumb.jpg`;
      if (!fs.existsSync(path.join(dir, thumb))) fs.writeFileSync(path.join(dir, thumb), makeThumb(img), { flag: 'wx' });
      items.push({ id, file: name, thumb, created: st.mtimeMs, width, height, scale: 1, source: 'recovered', text: '', version: 0 });
    }
    items.sort((a, b) => b.created - a.created);
  }
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = structuredClone(items);
  const job = saveChain.catch(() => {}).then(() => writeJson(indexFile, snapshot));
  saveChain = job;
  return job;
}
// A quit barrier is separate from flush: image updates call flush themselves.
function trackOperation(job) {
  mutationVersion++;
  pendingOperations.add(job);
  job.finally(() => pendingOperations.delete(job)).catch(() => {});
  return job;
}
// OCR stays in the background: quitting must never start or await native recognition.
async function flushForQuit() {
  for (;;) {
    if (pendingOperations.size) {
      await Promise.all([...pendingOperations]);
      continue;
    }
    const version = mutationVersion;
    await flush();
    // Work may arrive (and even finish) while the final index is being written.
    if (version === mutationVersion && !pendingOperations.size) return;
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch((e) => console.error('[library] save failed', e)), 200);
}

function broadcast() {
  for (const w of ctx.windowsOfKind('library')) w.webContents.send('library:changed');
}

function makeThumb(img) {
  const { width, height } = img.getSize();
  const w = Math.min(480, width);
  return img.resize({ width: w, height: Math.max(1, Math.round((height * w) / width)), quality: 'good' }).toJPEG(80);
}

function publicItem(it) {
  return {
    ...it,
    path: path.join(dir, it.file),
    url: `${ctx.dataUrl(path.join(dir, it.file))}?v=${it.version || 0}`,
    thumbUrl: `${ctx.dataUrl(path.join(dir, it.thumb))}?v=${it.version || 0}`,
  };
}

async function removeFiles(it) {
  await Promise.all([it.file, it.thumb].map((f) => fs.promises.unlink(path.join(dir, f)).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  })));
}

function mutateItem(id, task) {
  const previous = updateChains.get(id) || Promise.resolve();
  const job = previous.catch(() => {}).then(task);
  updateChains.set(id, job);
  job.finally(() => { if (updateChains.get(id) === job) updateChains.delete(id); }).catch(() => {});
  return trackOperation(job);
}
async function removeIds(ids) {
  await Promise.all([...new Set(ids)].map((id) => mutateItem(id, async () => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.version = (it.version || 0) + 1;
    ocrQueue.delete(id);
    await removeFiles(it);
    items = items.filter((x) => x !== it);
  })));
  await flush();
  broadcast();
}

async function prune(protectedId) {
  const { maxItems, keepDays } = ctx.settings.get('library');
  const now = Date.now();
  const candidates = items.filter((it) => it.id !== protectedId);
  const reserved = items.length - candidates.length;
  const drop = [];
  candidates.forEach((it, i) => {
    const tooOld = keepDays > 0 && now - it.created > keepDays * 86400000;
    const tooMany = maxItems > 0 && i >= Math.max(1, maxItems - reserved);
    if (tooOld || tooMany) drop.push(it);
  });
  if (drop.length) {
    await removeIds(drop.map((it) => it.id));
  }
}

// Add a capture. Returns { id, path }.
// Where add(…, { id }) will store the image (known before the PNG is written).
function pathFor(id) {
  return path.join(dir, `${id}.png`);
}

function add(pngData, meta = {}, options = {}) {
  return trackOperation(addCapture(pngData, meta, options));
}
async function addCapture(pngData, meta = {}, { id = ctx.newId(), protectedId } = {}) {
  const png = toBuffer(pngData);
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) throw new Error('invalid image');
  const { width, height } = img.getSize();
  const it = {
    id,
    file: `${id}.png`,
    thumb: `${id}.thumb.jpg`,
    created: Date.now(),
    width,
    height,
    scale: meta.scale || 1,
    source: meta.source || 'area',
    appName: meta.appName || '',
    windowTitle: meta.windowTitle || '',
    text: '',
    version: 0,
  };
  await writeFileAtomic(path.join(dir, it.file), png);
  await writeFileAtomic(path.join(dir, it.thumb), makeThumb(img));
  items.unshift(it);
  await prune(protectedId);
  save();
  broadcast();
  queueOcr(id);
  return { id, path: path.join(dir, it.file) };
}

function updateImage(id, pngData, baseVersion) {
  return mutateItem(id, () => replaceImage(id, pngData, baseVersion));
}
async function replaceImage(id, pngData, baseVersion) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  if ((it.version || 0) !== baseVersion) return { conflict: true, item: it };
  const png = toBuffer(pngData);
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) throw new Error('invalid image');
  const { width, height } = img.getSize();
  // Invalidate in-flight OCR, then scrub both index copies before replacing pixels.
  it.version = (it.version || 0) + 1;
  it.text = '';
  it.updating = true;
  broadcast();
  try {
    await flush();
    // Remove the old thumbnail before committing redacted pixels. If the next
    // write fails, a missing preview is safer than revealing concealed content.
    await fs.promises.unlink(path.join(dir, it.thumb)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    await writeFileAtomic(path.join(dir, it.file), png);
    await writeFileAtomic(path.join(dir, it.thumb), makeThumb(img));
    Object.assign(it, { width, height, edited: true });
    delete it.updating;
    await flush();
    broadcast();
    queueOcr(id);
    return { id, version: it.version };
  } finally { delete it.updating; }
}

async function saveEditedImage(e, { id, data, baseVersion }) {
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new Error('invalid base version');
  const result = await updateImage(id, data, baseVersion);
  if (!result?.conflict) return result;
  // Adding can prune items, so let the original item's queue finish first.
  const copy = await add(data, result.item, { protectedId: id });
  ctx.notify(ctx.t('editor.libraryConflict.title'), ctx.t('editor.libraryConflict.detail'));
  return { id: copy.id, version: 0 };
}

// Background text indexing — only with the fast native engine (Vision).
function queueOcr(id) {
  if (!ctx.modules.native?.capabilities?.().ocr) return;
  const it = items.find((x) => x.id === id);
  if (!it || it.updating) return;
  ocrQueue.set(id, it.version || 0);
  // Not right away: a new capture is opening in the editor, let it have the CPU first.
  if (!ocrRunning && !ocrTimer) ocrTimer = setTimeout(() => { ocrTimer = null; return runOcrQueue(); }, 1500);
}

async function runOcrQueue() {
  if (ocrRunning) return;
  ocrRunning = true;
  while (ocrQueue.size) {
    const [id, version] = ocrQueue.entries().next().value;
    ocrQueue.delete(id);
    const it = items.find((x) => x.id === id);
    if (!it || it.updating || (it.version || 0) !== version) continue;
    try {
      const png = await fs.promises.readFile(path.join(dir, it.file));
      const res = await ctx.modules.native.ocr(png, { languages: ['ru-RU', 'en-US'], fast: true });
      if (!items.includes(it) || it.updating || (it.version || 0) !== version) continue;
      it.text = (res.lines || []).map((l) => l.text).join('\n').slice(0, 20000);
      mutationVersion++; // Include resolved text if a quit snapshot is already being written.
      save();
    } catch (e) {
      console.warn('[library] OCR indexing failed', e.message);
    }
  }
  ocrRunning = false;
}

function matches(it, q) {
  if (!q) return true;
  const d = new Date(it.created);
  const hay = [it.text, it.appName, it.windowTitle, it.source, d.toLocaleDateString('ru-RU'), d.toLocaleDateString('en-US'), `${it.width}x${it.height}`].join('\n').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function byId(id) {
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('not found');
  return it;
}

function openWindow() {
  const existing = ctx.windowsOfKind('library')[0];
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = Math.min(1100, Math.round(d.workArea.width * 0.8));
  const h = Math.min(760, Math.round(d.workArea.height * 0.8));
  const win = ctx.createWindow('library', {
    width: w,
    height: h,
    x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
    y: Math.round(d.workArea.y + (d.workArea.height - h) / 2),
    minWidth: 520,
    minHeight: 360,
    title: ctx.t('library.title'),
    titleBarStyle: ctx.isMac ? 'hiddenInset' : 'default',
  });
  win.once('ready-to-show', () => {
    win.show();
    if (ctx.isMac) require('electron').app.focus({ steal: true });
  });
  return win;
}

function register() {
  load();
  save();

  ctx.handle('library:list', (e, { query = '' } = {}) => items.filter((it) => matches(it, query)).map(publicItem));
  // Replacement reserves the next version before writing pixels. Open after it finishes.
  ctx.handle('library:open', (e, id) => mutateItem(id, () => {
    const it = byId(id);
    ctx.modules.editor?.openEditor({
      imagePath: path.join(dir, it.file),
      scale: it.scale,
      meta: {
        source: it.source, appName: it.appName, windowTitle: it.windowTitle,
        libraryId: it.id, libraryVersion: it.version || 0,
      },
    });
  }));
  ctx.handle('library:copy', (e, id) => {
    const it = byId(id);
    return clip.writeImage(path.join(dir, it.file));
  });
  ctx.handle('library:reveal', (e, id) => shell.showItemInFolder(path.join(dir, byId(id).file)));
  ctx.handle('library:pin', async (e, id) => {
    const it = byId(id);
    const data = await fs.promises.readFile(path.join(dir, it.file));
    ctx.modules.pin?.create({ data, scale: it.scale });
  });
  ctx.handle('library:delete', (e, ids) => removeIds([].concat(ids)));
  ctx.handle('library:clear', () => removeIds(items.map((it) => it.id)));
  ctx.handle('library:update-image', saveEditedImage);
  ctx.on('library:start-drag', (e, id) => {
    try {
      const it = byId(id);
      // Drag a copy with a human-friendly name instead of the internal id.
      const file = path.join(ctx.paths.tmp, `${ctx.formatFileName(ctx.settings.get('fileNameTemplate'))}.png`);
      fs.copyFileSync(path.join(dir, it.file), file);
      const icon = nativeImage.createFromPath(path.join(dir, it.thumb)).resize({ width: 96 });
      e.sender.startDrag({ file, icon });
    } catch (err) {
      console.error('[library] drag failed', err);
    }
  });
}

module.exports = { register, add, updateImage, openWindow, pathFor, flush, flushForQuit };
