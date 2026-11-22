// Pixel selection tools: magic wand (W) and lasso (Q) with freehand / polygon / rectangle /
// ellipse shapes. Shift adds to the selection, Alt/Option subtracts, ⌘/Ctrl-click deselects.
import { wandMask, maskFromPath } from '../mask.js';
import { rectFromDrag, boundsOfPoints, dist } from '../geom.js';

const modeFor = (p) => (p.shift ? 'add' : p.alt ? 'subtract' : 'replace');

function strokeAnts(g, build) {
  g.save();
  g.lineWidth = 1;
  g.strokeStyle = '#fff';
  g.beginPath();
  build(g);
  g.stroke();
  g.strokeStyle = '#000';
  g.setLineDash([4, 4]);
  g.lineDashOffset = -((performance.now() / 70) % 8);
  g.stroke();
  g.restore();
}

export class WandTool {
  constructor(app) {
    this.app = app;
    this.id = 'wand';
  }
  cursorFor() {
    return 'crosshair';
  }
  onDown(p) {
    const app = this.app;
    const sel = app.pixelSelection;
    const d = app.doc;
    if (p.meta) return sel.deselect();
    if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) {
      if (modeFor(p) === 'replace') sel.deselect();
      return;
    }
    const pr = app.props;
    const m = wandMask(app.getBasePixels(), p.x, p.y, { tolerance: pr.wandTolerance, contiguous: pr.wandContiguous, antialias: pr.wandAntialias, sample: pr.wandSample || 1 });
    sel.apply(m, modeFor(p));
  }
}

export class LassoTool {
  constructor(app) {
    this.app = app;
    this.id = 'lasso';
    this.drag = null; // freehand / rect / ellipse in progress
    this.poly = null; // polygon in progress: { points, mode, last }
    this.hover = null;
  }
  get busy() {
    return !!(this.drag || this.poly);
  }
  get shape() {
    return this.app.props.lassoShape || 'free';
  }
  cursorFor() {
    return 'crosshair';
  }
  deactivate() {
    this.drag = null;
    this.poly = null;
  }

  #commit(mode, bounds, draw) {
    const d = this.app.doc;
    const m = maskFromPath(d.width, d.height, bounds, draw);
    this.app.pixelSelection.apply(m, mode);
  }

  #closePolygon() {
    const poly = this.poly;
    this.poly = null;
    if (!poly || poly.points.length < 3) return this.app.invalidate(false);
    const pts = poly.points;
    this.#commit(poly.mode, boundsOfPoints(pts), (g) => {
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    });
  }

  onDown(p) {
    const app = this.app;
    if (p.meta) {
      this.poly = null;
      return app.pixelSelection.deselect();
    }
    if (this.shape === 'polygon') {
      const now = performance.now();
      if (!this.poly) {
        this.poly = { points: [[p.x, p.y]], mode: modeFor(p), last: now, lastPos: [p.sx, p.sy] };
        return;
      }
      const [fx, fy] = app.toScreen(...this.poly.points[0]);
      const nearStart = this.poly.points.length > 2 && dist(fx, fy, p.sx, p.sy) < 9;
      const dbl = now - this.poly.last < 350 && dist(this.poly.lastPos[0], this.poly.lastPos[1], p.sx, p.sy) < 6;
      if (nearStart || dbl) return this.#closePolygon();
      this.poly.points.push([p.x, p.y]);
      this.poly.last = now;
      this.poly.lastPos = [p.sx, p.sy];
      return;
    }
    this.drag = { start: p, cur: p, mode: modeFor(p), points: [[p.x, p.y]], moved: false };
  }

  onMove(p) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) < 3) return;
    d.moved = true;
    d.cur = p;
    const last = d.points[d.points.length - 1];
    if (dist(last[0], last[1], p.x, p.y) >= 1 / this.app.vs) d.points.push([p.x, p.y]);
    this.app.invalidate(false);
  }

  onHover(p) {
    if (this.poly) {
      this.hover = p;
      this.app.invalidate(false);
    }
  }

  onUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved) {
      if (d.mode === 'replace') this.app.pixelSelection.deselect();
      return;
    }
    if (this.shape === 'free') {
      if (d.points.length < 3) return;
      this.#commit(d.mode, boundsOfPoints(d.points), (g) => {
        d.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
      });
      return;
    }
    const r = rectFromDrag(d.start.x, d.start.y, p.x, p.y, { shift: p.shift });
    if (r.w < 1 || r.h < 1) return;
    this.#commit(d.mode, r, (g) => {
      if (this.shape === 'ellipse') g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else g.rect(r.x, r.y, r.w, r.h);
    });
  }

  onEnter() {
    if (!this.poly) return false;
    this.#closePolygon();
    return true;
  }

  cancel() {
    if (!this.busy) return false;
    this.drag = null;
    this.poly = null;
    this.app.invalidate(false);
    return true;
  }

  drawOverlay(g) {
    const app = this.app;
    const S = (x, y) => app.toScreen(x, y);
    if (this.poly) {
      const pts = this.poly.points.map(([x, y]) => S(x, y));
      if (this.hover) pts.push([this.hover.sx, this.hover.sy]);
      strokeAnts(g, (c) => pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))));
      const [fx, fy] = pts[0];
      g.fillStyle = '#fff';
      g.strokeStyle = '#0A84FF';
      g.beginPath();
      g.arc(fx, fy, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      requestAnimationFrame(() => app.invalidate(false));
      return;
    }
    const d = this.drag;
    if (!d?.moved) return;
    if (this.shape === 'free') {
      strokeAnts(g, (c) => d.points.forEach(([x, y], i) => (i ? c.lineTo(...S(x, y)) : c.moveTo(...S(x, y)))));
    } else {
      const r = rectFromDrag(d.start.x, d.start.y, d.cur.x, d.cur.y, { shift: d.cur.shift });
      const [x0, y0] = S(r.x, r.y);
      const [x1, y1] = S(r.x + r.w, r.y + r.h);
      strokeAnts(g, (c) => {
        if (this.shape === 'ellipse') c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
        else c.rect(x0, y0, x1 - x0, y1 - y0);
      });
    }
  }
}
