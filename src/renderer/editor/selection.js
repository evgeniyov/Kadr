// Pixel selection over the base image: state, marching ants, and the operations that edit
// pixels (erase to transparent, keep only, crop to selection, fill, copy). Pixel edits create a
// new base canvas and a history step, so they are undoable; the selection itself is not.
import { t, toast, canvasToBytes } from '../../shared/ui.js';
import { Mask } from './mask.js';
import { makeCanvas } from './doc.js';

export class PixelSelection {
  constructor(app, { writeClipboardImage }) {
    this.app = app;
    this.mask = null;
    this.timer = 0;
    this.writeClipboardImage = writeClipboardImage;
    // A selection only makes sense for the image it was made on.
    app.doc.addEventListener('change', () => {
      const m = this.mask;
      if (m && (m.w !== app.doc.width || m.h !== app.doc.height)) this.set(null);
    });
  }

  get active() {
    return !!this.mask;
  }

  set(mask) {
    this.mask = mask && !mask.empty ? mask : null;
    if (this.mask && !this.timer) this.timer = setInterval(() => this.app.invalidate(false), 110);
    if (!this.mask && this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
    this.app.emit('pixelselection');
    this.app.invalidate(false);
  }

  // mode: 'replace' | 'add' | 'subtract'
  apply(mask, mode = 'replace') {
    if (mode === 'replace') return this.set(mask);
    if (!this.mask) return this.set(mode === 'add' ? mask : null);
    this.set(this.mask.combine(mask, mode));
  }

  selectAll() {
    this.set(Mask.all(this.app.doc.width, this.app.doc.height));
  }

  invert() {
    const d = this.app.doc;
    this.set(this.mask ? this.mask.invert() : Mask.all(d.width, d.height));
  }

  deselect() {
    if (!this.mask) return false;
    this.set(null);
    return true;
  }

  // kind: 'expand' | 'contract' | 'feather'; px in image pixels
  refine(kind, px) {
    if (!this.mask) return;
    if (kind === 'expand') this.set(this.mask.blurred(px, 24));
    else if (kind === 'contract') this.set(this.mask.blurred(px, 232));
    else this.set(this.mask.blurred(px));
  }

  // ---- pixel operations ---------------------------------------------------------
  #editBase(draw) {
    const d = this.app.doc;
    const c = makeCanvas(d.width, d.height);
    const g = c.getContext('2d');
    g.drawImage(d.base, 0, 0);
    draw(g);
    return c;
  }

  erase() {
    if (!this.mask) return false;
    const c = this.#editBase((g) => {
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(this.mask.canvas(), 0, 0);
    });
    this.app.doc.setBase(c);
    this.app.commit();
    return true;
  }

  keepOnly() {
    if (!this.mask) return;
    const c = this.#editBase((g) => {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(this.mask.canvas(), 0, 0);
    });
    this.app.doc.setBase(c);
    this.app.commit();
  }

  fill(color) {
    if (!this.mask) return;
    const d = this.app.doc;
    const layer = makeCanvas(d.width, d.height);
    const lg = layer.getContext('2d');
    lg.drawImage(this.mask.canvas(), 0, 0);
    lg.globalCompositeOperation = 'source-in';
    lg.fillStyle = color;
    lg.fillRect(0, 0, d.width, d.height);
    this.app.doc.setBase(this.#editBase((g) => g.drawImage(layer, 0, 0)));
    this.app.commit();
  }

  // Crop to the selection's bounding box; pixels outside the mask become transparent.
  cropTo() {
    if (!this.mask) return;
    const b = this.mask.bbox;
    const app = this.app;
    const masked = this.#editBase((g) => {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(this.mask.canvas(), 0, 0);
    });
    app.doc.base = masked; // becomes a real base (and one undo step) through crop() below
    app.doc.crop(b);
    app.commit();
  }

  // Copy the selected pixels (annotations included, transparent outside the mask).
  async copy() {
    if (!this.mask) return false;
    const app = this.app;
    const b = this.mask.bbox;
    const L = app.renderer.layout(null, { raw: true });
    const flat = makeCanvas(L.width, L.height);
    app.renderer.render(flat, { layout: L, backdrop: null });
    const out = makeCanvas(b.w, b.h);
    const g = out.getContext('2d');
    g.drawImage(flat, -b.x, -b.y);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.mask.canvas(), -b.x, -b.y);
    try {
      await this.writeClipboardImage(await canvasToBytes(out, 'png'));
      toast(t('editor.toast.selCopied'));
      return true;
    } catch (e) {
      console.error('copy selection failed', e?.message || e);
      toast(t('editor.toast.failed'));
      return false;
    }
  }

  // Marching ants in screen space.
  drawAnts(g) {
    const path = this.mask?.outline();
    if (!path) return;
    const app = this.app;
    const vs = app.vs;
    const [ox, oy] = app.toScreen(0, 0);
    g.save();
    g.translate(ox, oy);
    g.scale(vs, vs);
    g.lineWidth = 1 / vs;
    g.strokeStyle = '#fff';
    g.stroke(path);
    g.strokeStyle = '#000';
    g.setLineDash([4 / vs, 4 / vs]);
    g.lineDashOffset = -((performance.now() / 70) % 8) / vs;
    g.stroke(path);
    g.restore();
  }
}
