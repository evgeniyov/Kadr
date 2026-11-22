// Export and document-level actions: copy / save / pin / drag-out / GIF, paste & drop images,
// add capture, remove background, rotate / flip / resize.
import { kadr, t, toast, getSettings, canvasToBytes, bytesToObjectUrl } from '../../shared/ui.js';
import { makeCanvas } from './doc.js';
import { loadBitmap } from './app.js';
import { bounds } from './objects/index.js';
import { backgroundMask } from './mask.js';
import { readPixels } from './pixels.js';
import { openBgPopover } from './ui/dialogs.js';

// Clipboard images go through core IPC; if that is unavailable (the Electron 44 main-process
// clipboard API changed), fall back to the web Clipboard API of this renderer.
let ipcImageClipboardRead = true;

export async function writeClipboardImage(png) {
  // Main orders every manual copy against pending automatic capture copies.
  try {
    await kadr.invoke('clipboard:write-image', png);
    return;
  } catch (e) {
    console.warn('clipboard:write-image failed, using navigator.clipboard', e.message);
  }
  const write = () => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  try {
    await write();
  } catch (e) {
    // The web clipboard needs a focused document.
    if (e?.name !== 'NotAllowedError') throw e;
    await kadr.invoke('win:focus').catch(() => {});
    await new Promise((r) => setTimeout(r, 80));
    await write();
  }
}

async function readClipboardImage() {
  if (ipcImageClipboardRead) {
    try {
      return await kadr.invoke('clipboard:read-image');
    } catch (e) {
      console.warn('clipboard:read-image failed, using navigator.clipboard', e.message);
      ipcImageClipboardRead = false;
    }
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((ty) => ty.startsWith('image/'));
      if (type) return new Uint8Array(await (await item.getType(type)).arrayBuffer());
    }
  } catch (e) {
    console.warn('navigator.clipboard.read failed', e.message);
  }
  return null;
}

export class Output {
  constructor(app) {
    this.app = app;
    const { libraryId, libraryVersion } = app.params?.meta || {};
    this.library = libraryId ? { id: libraryId, version: libraryVersion ?? 0 } : null;
    this.cache = null; // { key, format, bytes }
    this.pending = null;
    this.encodings = new Map();
    this.outputQueue = Promise.resolve();
  }

  #key(format) {
    const a = this.app;
    return `${a.doc.version}|${a.backdropVersion}|${JSON.stringify(a.backdrop)}|${format}|${a.renderer.bgImage ? 1 : 0}`;
  }

  // Final image (backdrop included). The GIF's before frame keeps concealment.
  renderCanvas({ concealOnly = false } = {}) {
    const app = this.app;
    app.textEditor?.commit();
    const layout = app.renderer.layout(app.backdrop);
    const c = makeCanvas(layout.width, layout.height);
    app.renderer.render(c, { layout, backdrop: layout.backdrop ? app.backdrop : null, concealOnly });
    return c;
  }

  async bytes(format = 'png', quality = 90) {
    this.app.textEditor?.commit();
    const key = this.#key(format) + `|${quality}`;
    if (this.cache?.key === key) return this.cache.bytes;
    if (this.encodings.has(key)) return this.encodings.get(key);
    const canvas = this.renderCanvas();
    const job = canvasToBytes(canvas, format, quality).then((bytes) => {
      // A slower old encoding must not evict the cache for a newer revision.
      if (this.#key(format) + `|${quality}` === key) this.cache = { key, bytes };
      return bytes;
    }).finally(() => this.encodings.delete(key));
    this.encodings.set(key, job);
    return job;
  }

  // Start encoding in the background (used before a drag-out, since dragstart must be synchronous).
  prepare() {
    this.app.textEditor?.commit();
    const key = this.#key('png') + '|90';
    if (this.cache?.key === key) return;
    if (this.pending?.key === key) return;
    const p = this.bytes('png').catch((e) => console.warn('drag preview encoding failed', e)).finally(() => {
      if (this.pending?.promise === p) this.pending = null;
    });
    this.pending = { key, promise: p };
  }

  cachedPng() {
    this.app.textEditor?.commit();
    const key = this.#key('png') + '|90';
    return this.cache?.key === key ? this.cache.bytes : null;
  }

  async updateLibrary(png) {
    if (!this.library) return;
    try {
      const saved = await kadr.invoke('library:update-image', {
        id: this.library.id, baseVersion: this.library.version, data: png,
      });
      if (saved) this.library = saved;
    } catch (e) {
      console.warn('library:update-image failed', e);
    }
  }

  // Both operations replace the library image: preserve request order even when an
  // older PNG encoding takes longer than a later save.
  #enqueue(action) {
    const job = this.outputQueue.catch(() => {}).then(action);
    this.outputQueue = job;
    return job;
  }

  copy(options = {}) {
    return this.#enqueue(() => this.#copy(options));
  }

  async #copy({ silent = false } = {}) {
    try {
      this.app.textEditor?.commit();
      const revision = this.#key('png');
      const png = await this.bytes('png');
      await writeClipboardImage(png);
      if (!silent) toast(t('editor.toast.copied'));
      // A copied screenshot is "done"; an opened file still has unsaved changes.
      await this.updateLibrary(png);
      const current = this.#key('png') === revision;
      if (current && !this.app.params.meta?.filePath) this.app.dirty = false;
      return current;
    } catch (e) {
      console.error('copy failed:', e?.name, e?.message || e);
      toast(t('editor.toast.failed'));
      return false;
    }
  }

  save(options = {}) {
    return this.#enqueue(() => this.#save(options));
  }

  async #save({ saveAs = false, format } = {}) {
    const s = getSettings() || {};
    const original = this.app.params.meta?.filePath || null;
    // A file opened from disk is saved back into itself (like Preview) when its format can
    // be written; other formats (HEIC, GIF, TIFF, BMP…) go through "Save As" next to it.
    const origExt = original ? (/\.([a-z0-9]+)$/i.exec(original)?.[1] || '').toLowerCase() : '';
    const writable = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' }[origExt];
    if (original && !saveAs && !format && !writable) saveAs = true;
    const fmt = format || (original && writable) || s.imageFormat || 'png';
    try {
      this.app.textEditor?.commit();
      const revision = this.#key('png');
      const canvas = this.renderCanvas();
      // Encode the exported file and its library image from one immutable canvas.
      const [data, libraryPng] = await Promise.all([
        canvasToBytes(canvas, fmt, s.jpgQuality ?? 90),
        this.library && fmt !== 'png' ? canvasToBytes(canvas, 'png', 90) : null,
      ]);
      const name = this.app.params.meta?.fileName?.replace(/\.[a-z0-9]+$/i, '') || undefined;
      const folder = original ? original.replace(/[\\/][^\\/]*$/, '') : undefined;
      const file =
        original && !saveAs && fmt === writable
          ? await kadr.invoke('editor:save-original', { data })
          : await kadr.invoke('image:save', { data, ext: fmt, saveAs, silent: true, name: saveAs ? name : undefined, folder: saveAs ? folder : undefined });
      if (!file) return null;
      toast(t('editor.toast.saved', { name: String(file).split(/[\\/]/).pop() }));
      this.lastSaved = file;
      await this.updateLibrary(libraryPng || data);
      if (this.#key('png') === revision) this.app.dirty = false;
      return file;
    } catch (e) {
      console.error('save failed:', e?.message || e);
      toast(t('editor.toast.failed'));
      return null;
    }
  }

  async pin() {
    try {
      const data = await this.bytes('png');
      await kadr.invoke('pin:create', { data, scale: this.app.doc.scale });
    } catch (e) {
      console.warn('pin failed', e);
      toast(t('editor.toast.unavailable'));
    }
  }

  async openDefault() {
    try {
      await kadr.invoke('image:open-with-default', { data: await this.bytes('png'), ext: 'png' });
    } catch {
      toast(t('editor.toast.failed'));
    }
  }

  async exportGif() {
    toast(t('editor.toast.gifWorking'));
    try {
      const afterCanvas = this.renderCanvas();
      const beforeCanvas = this.renderCanvas({ concealOnly: true });
      const [before, after] = await Promise.all([
        canvasToBytes(beforeCanvas, 'png'), canvasToBytes(afterCanvas, 'png'),
      ]);
      const gif = await kadr.invoke('editor:export-gif', { frames: [before, after], delay: 1000, maxWidth: 1600 });
      const file = await kadr.invoke('image:save', { data: gif, ext: 'gif', saveAs: true, silent: true });
      if (file) toast(t('editor.toast.saved', { name: String(file).split(/[\\/]/).pop() }));
    } catch (e) {
      console.error('gif export failed', e);
      toast(t('editor.toast.gifFailed'));
    }
  }

  // ---- adding images -------------------------------------------------------
  // Place an image object centred on the visible area (or at doc point `at`), fitted inside the image.
  addImageObject(img, { scale = this.app.doc.scale, at = null } = {}) {
    const app = this.app;
    const f = app.doc.scale / (scale || 1);
    let w = img.width * f;
    let h = img.height * f;
    const maxW = app.doc.width * 0.8;
    const maxH = app.doc.height * 0.8;
    const fit = Math.min(1, maxW / w, maxH / h);
    w *= fit;
    h *= fit;
    let cx;
    let cy;
    if (at) [cx, cy] = at;
    else [cx, cy] = app.toDoc(app.view.w / 2, app.view.h / 2);
    const asset = app.doc.addAsset(img);
    const o = app.newObject('image', cx - w / 2, cy - h / 2, { asset });
    Object.assign(o, { w, h });
    app.doc.add(o);
    app.setTool('select');
    app.select(o.id);
    app.commit();
    return o;
  }

  async paste() {
    const app = this.app;
    try {
      const png = await readClipboardImage();
      if (png && png.length) {
        const url = bytesToObjectUrl(png);
        try {
          this.addImageObject(await loadBitmap(url));
        } finally {
          URL.revokeObjectURL(url);
        }
        return;
      }
      const text = (await kadr.invoke('clipboard:read-text')) || '';
      if (text.trim()) {
        const [cx, cy] = app.toDoc(app.view.w / 2, app.view.h / 2);
        const o = app.newObject('text', cx, cy);
        o.text = text.replace(/\r\n?/g, '\n').slice(0, 5000);
        app.doc.add(o);
        const b = bounds(o, app.objectEnv());
        o.x -= b.w / 2;
        o.y -= b.h / 2;
        app.doc.changed();
        app.setTool('select');
        app.select(o.id);
        app.commit();
        return;
      }
      toast(t('editor.toast.clipboardEmpty'));
    } catch (e) {
      console.error('paste failed', e);
      toast(t('editor.toast.failed'));
    }
  }

  async dropFiles(files, sx, sy) {
    const file = [...files].find((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
    if (!file) return toast(t('editor.toast.notAnImage'));
    try {
      const img = await createImageBitmap(file);
      this.addImageObject(img, { at: this.app.toDoc(sx, sy) });
    } catch {
      toast(t('editor.toast.notAnImage'));
    }
  }

  async addCapture() {
    const app = this.app;
    try {
      await kadr.invoke('win:hide');
      await new Promise((r) => setTimeout(r, 250));
      const res = await kadr.invoke('capture:start', { mode: 'area', return: true });
      if (res?.data) {
        const url = bytesToObjectUrl(res.data);
        try {
          this.addImageObject(await loadBitmap(url), { scale: res.scale || app.doc.scale });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch (e) {
      console.warn('capture failed', e);
      toast(t('editor.toast.unavailable'));
    } finally {
      await kadr.invoke('win:show').catch(() => {});
      await kadr.invoke('win:focus').catch(() => {});
    }
  }

  // ---- image operations ----------------------------------------------------
  transform(op) {
    const app = this.app;
    app.textEditor?.commit();
    if (app.toolId === 'crop') app.restorePrevTool();
    app.pixelSelection?.set(null);
    app.doc.transformAll(op);
    app.commit();
    app.view.fitMode = true;
    app.invalidate();
  }

  // Subject cut-out via the native helper (Vision on macOS) when available; otherwise, or when
  // it finds nothing, remove a uniform background detected from the image edges.
  async removeBackground() {
    const app = this.app;
    app.textEditor?.commit();
    const doc = app.doc;
    const revision = doc.version;
    const stale = () => app.doc !== doc || doc.version !== revision;
    const changed = () => toast(t('editor.toast.imageChanged'));
    if (app.caps.removeBackground) {
      toast(t('editor.toast.removingBg'));
      try {
        const data = await canvasToBytes(app.doc.base, 'png');
        if (stale()) return changed();
        const out = await kadr.invoke('native:remove-bg', { data });
        if (stale()) return changed();
        const url = bytesToObjectUrl(out);
        let img;
        try {
          img = await loadBitmap(url);
          if (stale()) return changed();
          const c = makeCanvas(app.doc.width, app.doc.height);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          app.doc.setBase(c);
          app.commit();
          return;
        } finally {
          img?.close?.();
          URL.revokeObjectURL(url);
        }
      } catch (e) {
        console.warn('native remove-bg failed, using uniform background removal', e?.message || e);
      }
    }
    if (stale()) return changed();
    this.removeUniformBackground();
  }

  // Flood-fill the border colours inwards (tolerance adjustable in a popover) → transparent.
  removeUniformBackground() {
    const app = this.app;
    const orig = app.doc.base;
    const pixels = readPixels(orig);
    let applied = false;
    let holes = false;
    let tolerance = app.props.bgTolerance ?? 30;
    const run = () => {
      const m = backgroundMask(pixels, tolerance, { holes });
      const c = makeCanvas(orig.width, orig.height);
      const g = c.getContext('2d');
      g.drawImage(orig, 0, 0);
      if (m) {
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(m.canvas(), 0, 0);
      }
      app.doc.setBase(c);
      if (!applied) app.commit();
      else app.history.amend();
      applied = true;
      return !!m;
    };
    if (!run()) toast(t('editor.bg.notFound'));
    openBgPopover(app, {
      value: tolerance,
      onInput: (v) => {
        tolerance = v;
        app.props.bgTolerance = v;
        app.persistEditor({ bgTolerance: v });
        run();
      },
      onHoles: (v) => {
        holes = v;
        run();
      },
      onCancel: () => applied && app.undo(),
    });
  }
}
