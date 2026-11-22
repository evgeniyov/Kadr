// On-screen view: zoom/pan of the rendered composite inside the viewport canvas.
// `zoom` is relative to the real screen size (1 = 100% = image shown at 1/scale).
import { clamp } from './geom.js';
import { ZOOM_STEPS } from './consts.js';

export class View {
  constructor(viewport, canvas) {
    this.viewport = viewport;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.docScale = 1;
    this.contentW = 1;
    this.contentH = 1;
    this.w = 1;
    this.h = 1;
    this.dpr = window.devicePixelRatio || 1;
    this.fitMode = true;
    this.fitCap = true;
    this.margin = 48; // how far content may be panned past the viewport edge
    this.onChange = () => {};
    this.patterns = {};
  }

  // CSS px per output pixel.
  get vs() {
    return this.zoom / this.docScale;
  }

  outToScreen(x, y) {
    return [this.panX + x * this.vs, this.panY + y * this.vs];
  }
  screenToOut(sx, sy) {
    return [(sx - this.panX) / this.vs, (sy - this.panY) / this.vs];
  }

  resize() {
    const r = this.viewport.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    const cw = Math.round(this.w * this.dpr);
    const ch = Math.round(this.h * this.dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.canvas.style.width = `${this.w}px`;
      this.canvas.style.height = `${this.h}px`;
    }
    if (this.fitMode) this.fit(this.fitCap);
    else this.clampPan();
  }

  setContent(w, h, docScale) {
    const changed = w !== this.contentW || h !== this.contentH || docScale !== this.docScale;
    if (!changed) return;
    const [cx, cy] = this.screenToOut(this.w / 2, this.h / 2);
    const fx = cx / this.contentW;
    const fy = cy / this.contentH;
    this.contentW = w;
    this.contentH = h;
    this.docScale = docScale;
    if (this.fitMode) this.fit(this.fitCap);
    else {
      // keep the same relative point in the centre
      this.panX = this.w / 2 - fx * w * this.vs;
      this.panY = this.h / 2 - fy * h * this.vs;
      this.clampPan();
    }
  }

  fitZoom(cap = true) {
    const pad = 28;
    const z = Math.min((this.w - pad * 2) / (this.contentW / this.docScale), (this.h - pad * 2) / (this.contentH / this.docScale));
    return clamp(cap ? Math.min(1, z) : z, 0.02, 32);
  }

  fit(cap = true) {
    this.zoom = this.fitZoom(cap);
    this.fitMode = true;
    this.fitCap = cap;
    this.panX = (this.w - this.contentW * this.vs) / 2;
    this.panY = (this.h - this.contentH * this.vs) / 2;
    this.onChange();
  }

  setZoom(z, ax = this.w / 2, ay = this.h / 2) {
    z = clamp(z, 0.02, 32);
    const [ox, oy] = this.screenToOut(ax, ay);
    this.zoom = z;
    this.panX = ax - ox * this.vs;
    this.panY = ay - oy * this.vs;
    this.fitMode = false;
    this.clampPan();
    this.onChange();
  }

  zoomStep(dir, ax, ay) {
    const z = this.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999);
    this.setZoom(next ?? (dir > 0 ? z * 1.25 : z / 1.25), ax, ay);
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.fitMode = false;
    this.clampPan();
    this.onChange();
  }

  clampPan() {
    const cw = this.contentW * this.vs;
    const ch = this.contentH * this.vs;
    const m = this.margin;
    this.panX = cw + m * 2 <= this.w ? (this.w - cw) / 2 : clamp(this.panX, this.w - cw - m, m);
    this.panY = ch + m * 2 <= this.h ? (this.h - ch) / 2 : clamp(this.panY, this.h - ch - m, m);
  }

  #checker() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const key = `${dark}|${this.dpr}`;
    if (!this.patterns[key]) {
      const s = Math.round(8 * this.dpr);
      const c = document.createElement('canvas');
      c.width = c.height = s * 2;
      const g = c.getContext('2d');
      g.fillStyle = dark ? '#2b2b2e' : '#ffffff';
      g.fillRect(0, 0, s * 2, s * 2);
      g.fillStyle = dark ? '#36363a' : '#e6e6e9';
      g.fillRect(0, 0, s, s);
      g.fillRect(s, s, s, s);
      const p = this.ctx.createPattern(c, 'repeat');
      p.setTransform(new DOMMatrix().scale(1 / this.dpr));
      this.patterns[key] = p;
    }
    return this.patterns[key];
  }

  // Draw the composite plus the screen-space overlay (drawOverlay(ctx) in CSS px).
  draw(composite, drawOverlay) {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const [x0, y0] = this.outToScreen(0, 0);
    const cw = this.contentW * this.vs;
    const ch = this.contentH * this.vs;
    g.save();
    g.fillStyle = this.#checker();
    g.fillRect(Math.round(x0), Math.round(y0), Math.round(cw), Math.round(ch));
    g.imageSmoothingEnabled = this.vs * this.dpr < 2;
    g.imageSmoothingQuality = 'high';
    if (composite) g.drawImage(composite, x0, y0, cw, ch);
    g.restore();
    if (drawOverlay) {
      g.save();
      drawOverlay(g);
      g.restore();
    }
  }
}
