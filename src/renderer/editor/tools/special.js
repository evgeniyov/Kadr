// Tools that don't simply create objects: crop/uncrop, colour picker, smart ruler, OCR area.
import { kadr, t, toast, getSettings } from '../../../shared/ui.js';
import { ObjectTool } from './object-tool.js';
import { rectHandles, resizeRect } from '../objects/common.js';
import { formatLength } from '../objects/misc.js';
import { formatColor, toHex } from '../color.js';
import { readPixels, pixelAt, scanEdges } from '../pixels.js';
import { rectFromDrag, dist, pointInRect } from '../geom.js';

const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const MAX_SIDE = 20000;

function roundRect(r) {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.max(1, Math.min(MAX_SIDE, Math.round(r.x + r.w) - x)), h: Math.max(1, Math.min(MAX_SIDE, Math.round(r.y + r.h) - y)) };
}

function pill(g, text, cx, cy, { bg = 'rgba(20,20,22,0.86)', fg = '#fff' } = {}) {
  g.font = '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const w = g.measureText(text).width + 14;
  const h = 20;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(cx - w / 2, cy - h / 2, w, h, 6);
  g.fill();
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy + 0.5);
  g.textAlign = 'left';
}

// ---- Crop / uncrop -------------------------------------------------------------

export class CropTool {
  constructor(app) {
    this.app = app;
    this.id = 'crop';
    this.transient = true;
    this.rect = null;
    this.drag = null;
    this.ratio = 'free';
  }
  get busy() {
    return !!this.drag;
  }
  activate() {
    const d = this.app.doc;
    this.rect = { x: 0, y: 0, w: d.width, h: d.height };
    this.ratio = 'free';
    this.app.view.margin = 180;
    this.app.select(null);
  }
  deactivate() {
    this.rect = null;
    this.drag = null;
    this.app.view.margin = 48;
    this.app.view.clampPan();
  }
  handleAt(p) {
    for (const h of rectHandles(this.rect)) {
      const [hx, hy] = this.app.toScreen(h.x, h.y);
      if (dist(hx, hy, p.sx, p.sy) <= 10) return h;
    }
    return null;
  }
  cursorFor(p) {
    const h = this.handleAt(p);
    if (h) return HANDLE_CURSORS[h.id];
    return pointInRect(p.x, p.y, this.rect) ? 'move' : 'crosshair';
  }
  onDown(p) {
    const h = this.handleAt(p);
    const orig = { ...this.rect };
    if (h) this.drag = { kind: 'handle', id: h.id, orig, start: p };
    else if (pointInRect(p.x, p.y, this.rect)) this.drag = { kind: 'move', orig, start: p };
    else this.drag = { kind: 'new', orig, start: p };
  }
  #ratioValue() {
    const m = /^(\d+):(\d+)$/.exec(this.ratio);
    return m ? +m[1] / +m[2] : null;
  }
  onMove(p) {
    const d = this.drag;
    if (!d) return;
    const ratio = this.#ratioValue();
    let r;
    if (d.kind === 'handle') {
      r = resizeRect(d.orig, d.id, p.x, p.y, p.shift || !!ratio);
    } else if (d.kind === 'move') {
      r = { ...d.orig, x: d.orig.x + p.x - d.start.x, y: d.orig.y + p.y - d.start.y };
    } else {
      if (Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) < 3) return;
      r = rectFromDrag(d.start.x, d.start.y, p.x, p.y, { shift: p.shift });
      if (ratio) {
        const h = r.w / ratio;
        r = { ...r, h, y: p.y < d.start.y ? d.start.y - h : d.start.y };
      }
    }
    this.rect = roundRect(r);
    this.app.invalidate(false);
    this.app.emit('crop');
  }
  onUp() {
    this.drag = null;
    if (this.rect.w < 2 || this.rect.h < 2) this.reset();
  }
  onEnter() {
    this.apply();
    return true;
  }
  reset() {
    const d = this.app.doc;
    this.rect = { x: 0, y: 0, w: d.width, h: d.height };
    this.app.invalidate(false);
    this.app.emit('crop');
  }
  // Largest rect of the chosen ratio centred in the current one.
  setRatio(id) {
    this.ratio = id;
    const ratio = this.#ratioValue();
    if (ratio) {
      const r = this.rect;
      let w = r.w;
      let h = w / ratio;
      if (h > r.h) {
        h = r.h;
        w = h * ratio;
      }
      this.rect = roundRect({ x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h });
    }
    this.app.invalidate(false);
    this.app.emit('crop');
  }
  setSize(w, h) {
    this.rect = roundRect({ ...this.rect, w: Math.max(1, w), h: Math.max(1, h) });
    this.app.invalidate(false);
    this.app.emit('crop');
  }
  apply() {
    const app = this.app;
    const r = roundRect(this.rect);
    const unchanged = r.x === 0 && r.y === 0 && r.w === app.doc.width && r.h === app.doc.height;
    if (!unchanged) {
      app.doc.crop(r);
      app.commit();
    }
    app.restorePrevTool();
  }
  cancel() {
    if (this.drag) {
      this.rect = this.drag.orig;
      this.drag = null;
      this.app.invalidate(false);
      return true;
    }
    this.app.restorePrevTool();
    return true;
  }
  drawOverlay(g) {
    const app = this.app;
    const r = this.rect;
    if (!r) return;
    const [x0, y0] = app.toScreen(r.x, r.y);
    const [x1, y1] = app.toScreen(r.x + r.w, r.y + r.h);
    const W = app.view.w;
    const H = app.view.h;
    g.fillStyle = 'rgba(0, 0, 0, 0.5)';
    g.beginPath();
    g.rect(0, 0, W, H);
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.fill('evenodd');
    // image outline, so it is visible while uncropping
    const [ix0, iy0] = app.toScreen(0, 0);
    const [ix1, iy1] = app.toScreen(app.doc.width, app.doc.height);
    g.setLineDash([4, 4]);
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1;
    g.strokeRect(ix0 + 0.5, iy0 + 0.5, ix1 - ix0 - 1, iy1 - iy0 - 1);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    g.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = x0 + ((x1 - x0) * i) / 3;
      const y = y0 + ((y1 - y0) * i) / 3;
      g.moveTo(x, y0);
      g.lineTo(x, y1);
      g.moveTo(x0, y);
      g.lineTo(x1, y);
    }
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // corner brackets + edge bars (dark halo keeps them visible on light images)
    g.save();
    g.shadowColor = 'rgba(0, 0, 0, 0.55)';
    g.shadowBlur = 3;
    g.lineWidth = 4;
    g.lineCap = 'round';
    const L = Math.min(18, (x1 - x0) / 3, (y1 - y0) / 3);
    g.beginPath();
    for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) {
      g.moveTo(cx, cy + dy * L);
      g.lineTo(cx, cy);
      g.lineTo(cx + dx * L, cy);
    }
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    g.moveTo(mx - L / 2, y0);
    g.lineTo(mx + L / 2, y0);
    g.moveTo(mx - L / 2, y1);
    g.lineTo(mx + L / 2, y1);
    g.moveTo(x0, my - L / 2);
    g.lineTo(x0, my + L / 2);
    g.moveTo(x1, my - L / 2);
    g.lineTo(x1, my + L / 2);
    g.stroke();
    g.restore();
    const label = `${r.w} × ${r.h}`;
    pill(g, label, mx, y0 > 30 ? y0 - 16 : y0 + 18);
  }
}

// ---- Colour picker ---------------------------------------------------------------

export class PickerTool {
  constructor(app) {
    this.app = app;
    this.id = 'picker';
    this.pos = null;
  }
  cursorFor() {
    return 'crosshair';
  }
  onHover(p) {
    this.pos = p;
    this.app.invalidate(false);
  }
  deactivate() {
    this.pos = null;
  }
  pixel(p) {
    const app = this.app;
    if (!app.compositePixels) app.compositePixels = readPixels(app.composite);
    const [ox, oy] = app.view.screenToOut(p.sx, p.sy);
    return pixelAt(app.compositePixels, ox, oy);
  }
  async onDown(p) {
    const c = this.pixel(p);
    if (!c) return;
    const text = formatColor(c, getSettings()?.colorFormat || 'hex');
    try {
      await kadr.invoke('clipboard:write-text', text);
      toast(t('editor.toast.colorCopied', { color: text }));
    } catch {
      toast(t('editor.toast.failed'));
    }
    if (p.shift) this.app.setProp('color', toHex(c));
  }
  onMove() {}
  onUp() {}
  drawOverlay(g) {
    const app = this.app;
    const p = app.cursor && this.pos;
    if (!p || !app.compositePixels) return;
    const N = 11;
    const cell = 9;
    const size = N * cell;
    const [ox, oy] = app.view.screenToOut(p.sx, p.sy);
    let bx = p.sx + 22;
    let by = p.sy + 22;
    if (bx + size > app.view.w - 8) bx = p.sx - 22 - size;
    if (by + size + 26 > app.view.h - 8) by = p.sy - 22 - size - 26;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 12;
    g.fillStyle = '#000';
    g.beginPath();
    g.roundRect(bx - 1, by - 1, size + 2, size + 2, 8);
    g.fill();
    g.restore();
    g.save();
    g.beginPath();
    g.roundRect(bx, by, size, size, 7);
    g.clip();
    const half = (N - 1) / 2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = pixelAt(app.compositePixels, ox + i - half, oy + j - half);
        g.fillStyle = c ? `rgba(${c.r},${c.g},${c.b},${c.a / 255})` : '#808080';
        g.fillRect(bx + i * cell, by + j * cell, cell, cell);
      }
    }
    g.restore();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.strokeRect(bx + half * cell, by + half * cell, cell, cell);
    const c = pixelAt(app.compositePixels, ox, oy);
    if (c) pill(g, formatColor(c, getSettings()?.colorFormat || 'hex'), bx + size / 2, by + size + 15);
  }
}

// ---- Smart ruler ---------------------------------------------------------------

export class RulerTool extends ObjectTool {
  constructor(app) {
    super(app, 'ruler', { creates: 'ruler' });
    this.live = null;
  }
  deactivate() {
    this.live = null;
  }
  cursorFor(p) {
    const c = super.cursorFor(p);
    return c === 'crosshair' ? 'cell' : c;
  }
  // Distance between the nearest colour edges around the cursor.
  measure(p) {
    const px = this.app.getBasePixels();
    const axis = this.app.props.rulerAxis;
    const s = scanEdges(px, p.x, p.y, axis);
    if (!s) return null;
    const value = s.b - s.a + 1;
    if (axis === 'h') {
      const y = Math.floor(p.y) + 0.5;
      return { x1: s.a, y1: y, x2: s.b + 1, y2: y, value };
    }
    const x = Math.floor(p.x) + 0.5;
    return { x1: x, y1: s.a, x2: x, y2: s.b + 1, value };
  }
  onHover(p) {
    super.onHover(p);
    this.live = this.app.hoverId ? null : this.measure(p);
    this.app.invalidate(false);
  }
  onDown(p) {
    const app = this.app;
    const sel = app.selected;
    if ((sel && app.handleAt(sel, p)) || app.hitTest(p, this.hitMode)) return super.onDown(p);
    this.drag = { kind: 'measure', start: p, moved: false };
  }
  onMove(p) {
    const d = this.drag;
    if (d?.kind === 'measure') {
      if (Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) < 4) return;
      this.live = null;
      this.startCreate(d.start);
    }
    super.onMove(p);
  }
  onUp(p) {
    const d = this.drag;
    if (d?.kind === 'measure') {
      this.drag = null;
      const m = this.measure(p);
      if (!m) return;
      const app = this.app;
      const o = app.newObject('ruler', m.x1, m.y1);
      Object.assign(o, m);
      app.doc.add(o);
      app.select(o.id);
      app.commit();
      return;
    }
    super.onUp(p);
  }
  drawOverlay(g) {
    const m = this.live;
    const app = this.app;
    if (!m || this.drag || !app.cursor) return;
    const [x1, y1] = app.toScreen(m.x1, m.y1);
    const [x2, y2] = app.toScreen(m.x2, m.y2);
    const vertical = app.props.rulerAxis === 'v';
    g.strokeStyle = '#FF2D55';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      if (vertical) {
        g.moveTo(x - 6, y);
        g.lineTo(x + 6, y);
      } else {
        g.moveTo(x, y - 6);
        g.lineTo(x, y + 6);
      }
    }
    g.stroke();
    const text = formatLength(m.value, app.props.rulerUnit, app.doc.scale);
    if (vertical) pill(g, text, x1 + 44, app.cursor.sy, { bg: '#FF2D55' });
    else pill(g, text, app.cursor.sx, y1 - 16, { bg: '#FF2D55' });
  }
}

// ---- OCR area selection ------------------------------------------------------------

export class OcrTool {
  constructor(app, onResult) {
    this.app = app;
    this.id = 'ocr';
    this.transient = true;
    this.onResult = onResult;
    this.drag = null;
  }
  get busy() {
    return !!this.drag;
  }
  cursorFor() {
    return 'crosshair';
  }
  onDown(p) {
    this.drag = { start: p, rect: null };
  }
  onMove(p) {
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) < 3) return;
    d.rect = rectFromDrag(d.start.x, d.start.y, p.x, p.y);
    this.app.invalidate(false);
  }
  onUp() {
    const d = this.drag;
    this.drag = null;
    this.app.restorePrevTool();
    this.onResult(d?.rect || null);
  }
  cancel() {
    this.drag = null;
    this.app.restorePrevTool();
    return true;
  }
  drawOverlay(g) {
    const app = this.app;
    const r = this.drag?.rect;
    if (!r) {
      if (app.cursor) pill(g, t('editor.ocr.hint'), app.view.w / 2, 22);
      return;
    }
    const [x0, y0] = app.toScreen(r.x, r.y);
    const [x1, y1] = app.toScreen(r.x + r.w, r.y + r.h);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.rect(0, 0, app.view.w, app.view.h);
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.fill('evenodd');
    g.setLineDash([5, 4]);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.setLineDash([]);
  }
}

