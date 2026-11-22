// Document model: the base image (a canvas), the ordered annotation objects, image assets,
// plus whole-image operations (crop/uncrop, rotate, flip, resize) and undo/redo history.
import { typeOf } from './objects/index.js';
import { mapRect, rectKey } from './geom.js';

let baseSeq = 0; // unique id per base canvas, used as a cache key
let assetSeq = 0;

// Objects that belong "under" the annotations: blurring/dimming never swallows arrows drawn earlier.
const UNDERLAY = new Set(['image', 'conceal', 'spotlight']);

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Draw `src` into a new canvas of size (w,h) using good downscaling (halving steps).
export function resampleCanvas(src, w, h) {
  let cur = src;
  let cw = src.width;
  let ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const half = makeCanvas(cw / 2, ch / 2);
    const g = half.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
    cw = half.width;
    ch = half.height;
  }
  const out = makeCanvas(w, h);
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

// Apply a rotate/flip operation to an image and return a new canvas.
function transformImage(img, op) {
  const w = img.width;
  const h = img.height;
  const rot = op.kind === 'rotate';
  const c = makeCanvas(rot ? h : w, rot ? w : h);
  const g = c.getContext('2d');
  if (rot && op.dir === 'cw') {
    g.translate(c.width, 0);
    g.rotate(Math.PI / 2);
  } else if (rot) {
    g.translate(0, c.height);
    g.rotate(-Math.PI / 2);
  } else if (op.axis === 'h') {
    g.translate(w, 0);
    g.scale(-1, 1);
  } else {
    g.translate(0, h);
    g.scale(1, -1);
  }
  g.drawImage(img, 0, 0);
  return c;
}

export class Doc extends EventTarget {
  constructor(base, scale = 1) {
    super();
    this.base = base;
    this.baseVersion = ++baseSeq;
    this.scale = scale; // image pixels per DIP
    this.objects = [];
    this.assets = new Map(); // id → canvas | ImageBitmap (immutable, never removed during a session)
    this.version = 0;
  }

  get width() {
    return this.base.width;
  }
  get height() {
    return this.base.height;
  }

  changed(detail = {}) {
    this.version++;
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  get(id) {
    return this.objects.find((o) => o.id === id) || null;
  }
  indexOf(id) {
    return this.objects.findIndex((o) => o.id === id);
  }

  insertIndexFor(type) {
    if (!UNDERLAY.has(type)) return this.objects.length;
    let i = 0;
    this.objects.forEach((o, j) => {
      if (UNDERLAY.has(o.type)) i = j + 1;
    });
    return i;
  }

  add(o, index = this.insertIndexFor(o.type)) {
    this.objects.splice(index, 0, o);
    this.changed();
    return o;
  }

  remove(id) {
    const i = this.indexOf(id);
    if (i < 0) return null;
    const [o] = this.objects.splice(i, 1);
    this.changed();
    return o;
  }

  arrange(id, dir) {
    const i = this.indexOf(id);
    if (i < 0) return false;
    const list = this.objects;
    let j = i;
    if (dir === 'forward') j = Math.min(list.length - 1, i + 1);
    else if (dir === 'backward') j = Math.max(0, i - 1);
    else if (dir === 'front') j = list.length - 1;
    else if (dir === 'back') j = 0;
    if (j === i) return false;
    const [o] = list.splice(i, 1);
    list.splice(j, 0, o);
    this.changed();
    return true;
  }

  // 1-based number of a counter among all counters (so deleting one renumbers the rest).
  counterNumber(o) {
    let n = 0;
    for (const x of this.objects) {
      if (x.type === 'counter') n++;
      if (x.id === o.id) return n;
    }
    return n + 1;
  }

  addAsset(img) {
    const id = `a${++assetSeq}`;
    this.assets.set(id, img);
    return id;
  }

  setBase(canvas, { preserveOcr = false } = {}) {
    // Pixel edits can move/remove text even when the canvas dimensions stay unchanged.
    // Until OCR is refreshed, conceal falls back to covering its entire area.
    if (!preserveOcr) {
      for (const o of this.objects) if (o.type === 'conceal') {
        o.boxes = null;
        o.ocrKey = '';
      }
    }
    this.base = canvas;
    this.baseVersion = ++baseSeq;
    this.changed({ base: true });
  }

  // Crop (or expand = "uncrop") to rect r in document coordinates. Outside the image stays transparent.
  crop(r) {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    const c = makeCanvas(Math.round(r.w), Math.round(r.h));
    c.getContext('2d').drawImage(this.base, -x, -y);
    for (const o of this.objects) {
      const ocrValid = this.#ocrValid(o);
      typeOf(o).translate(o, -x, -y);
      this.#mapBoxes(o, (px, py) => [px - x, py - y], ocrValid);
    }
    this.setBase(c, { preserveOcr: true });
  }

  // op: { kind: 'rotate', dir: 'cw'|'ccw' } | { kind: 'flip', axis: 'h'|'v' } | { kind: 'resize', width, height }
  transformAll(op) {
    const W = this.width;
    const H = this.height;
    let map;
    let s = 1;
    let canvas;
    if (op.kind === 'rotate') {
      map = op.dir === 'cw' ? (x, y) => [H - y, x] : (x, y) => [y, W - x];
      canvas = transformImage(this.base, op);
    } else if (op.kind === 'flip') {
      map = op.axis === 'h' ? (x, y) => [W - x, y] : (x, y) => [x, H - y];
      canvas = transformImage(this.base, op);
    } else {
      const fx = op.width / W;
      const fy = op.height / H;
      map = (x, y) => [x * fx, y * fy];
      s = Math.sqrt(fx * fy);
      canvas = resampleCanvas(this.base, op.width, op.height);
      this.scale *= s;
    }
    const env = { transformAsset: (id) => this.#transformAsset(id, op) };
    for (const o of this.objects) {
      const ocrValid = this.#ocrValid(o);
      typeOf(o).transform(o, map, s, op, env);
      o.k = (o.k || 1) * s;
      this.#mapBoxes(o, map, ocrValid);
    }
    this.setBase(canvas, { preserveOcr: true });
  }

  // Keep OCR text boxes of "conceal text" objects in sync with geometry changes.
  #ocrValid(o) {
    return Array.isArray(o.boxes) && o.ocrKey === rectKey(o);
  }
  #mapBoxes(o, map, wasValid) {
    if (!Array.isArray(o.boxes)) return;
    o.boxes = o.boxes.map((b) => mapRect(b, map));
    o.ocrKey = wasValid ? rectKey(o) : '';
  }

  #transformAsset(id, op) {
    const img = this.assets.get(id);
    if (!img) return id;
    return this.addAsset(transformImage(img, op));
  }

  snapshot() {
    return { base: this.base, baseVersion: this.baseVersion, scale: this.scale, objects: structuredClone(this.objects) };
  }

  restore(s) {
    const baseChanged = s.base !== this.base;
    this.base = s.base;
    this.baseVersion = s.baseVersion;
    this.scale = s.scale;
    this.objects = structuredClone(s.objects);
    this.changed({ base: baseChanged, restore: true });
  }
}

// Snapshot-based undo/redo. Base canvases are shared by reference (they are never mutated).
export class History {
  constructor(doc, { limit = 120, onChange } = {}) {
    this.doc = doc;
    this.limit = limit;
    this.onChange = onChange || (() => {});
    this.undoStack = [];
    this.redoStack = [];
    this.current = doc.snapshot();
    this.lastKey = null;
    this.lastTime = 0;
  }

  // Record the document state as a new step. Steps with the same `key` within ~1.2 s merge
  // (e.g. dragging the opacity slider).
  commit(key = null) {
    const snap = this.doc.snapshot();
    const now = performance.now();
    if (key && key === this.lastKey && now - this.lastTime < 1200) {
      this.current = snap;
    } else {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.current = snap;
    }
    this.lastKey = key;
    this.lastTime = now;
    this.redoStack.length = 0;
    this.onChange();
  }

  // Update the current step in place (e.g. OCR results that arrive asynchronously).
  amend() {
    this.current = this.doc.snapshot();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo) return false;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop();
    this.doc.restore(this.current);
    this.lastKey = null;
    this.onChange();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop();
    this.doc.restore(this.current);
    this.lastKey = null;
    this.onChange();
    return true;
  }
}
