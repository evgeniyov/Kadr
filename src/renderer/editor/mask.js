// Pixel selection masks (8-bit, one byte per image pixel) and the algorithms that build them:
// magic wand flood fill, lasso/marquee rasterization, uniform-background detection.
// Masks are immutable: every operation returns a new Mask.

let seq = 0;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export class Mask {
  constructor(w, h, data = new Uint8ClampedArray(w * h)) {
    this.w = w;
    this.h = h;
    this.data = data;
    this.id = ++seq;
    this._bbox = undefined;
    this._canvas = null;
    this._outline = undefined;
  }

  static all(w, h) {
    return new Mask(w, h, new Uint8ClampedArray(w * h).fill(255));
  }

  // Bounding box of selected pixels (null when empty).
  get bbox() {
    if (this._bbox !== undefined) return this._bbox;
    const { w, h, data } = this;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let first = -1;
      let last = -1;
      for (let x = 0; x < w; x++) {
        if (data[row + x]) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first >= 0) {
        if (first < x0) x0 = first;
        if (last > x1) x1 = last;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    this._bbox = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    return this._bbox;
  }

  get empty() {
    return !this.bbox;
  }

  // Canvas whose alpha channel is the mask (for compositing with destination-in/out).
  canvas() {
    if (this._canvas) return this._canvas;
    const c = makeCanvas(this.w, this.h);
    const img = new ImageData(this.w, this.h);
    const d = img.data;
    const m = this.data;
    for (let i = 0, j = 0; i < m.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = m[i];
    }
    c.getContext('2d').putImageData(img, 0, 0);
    this._canvas = c;
    return c;
  }

  // Outline (pixel edges at 50% coverage) as a Path2D in image coordinates, for marching ants.
  outline() {
    if (this._outline !== undefined) return this._outline;
    const b = this.bbox;
    if (!b) return (this._outline = null);
    const { w, h, data } = this;
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 128;
    const path = new Path2D();
    let n = 0;
    const boundingOutline = () => {
      const p = new Path2D();
      p.rect(b.x, b.y, b.w, b.h);
      return (this._outline = p);
    };
    const x0 = b.x;
    const x1 = b.x + b.w;
    const y0 = b.y;
    const y1 = b.y + b.h;
    for (let y = y0; y <= y1; y++) {
      let run = -1;
      for (let x = x0; x <= x1; x++) {
        const edge = x < x1 && on(x, y - 1) !== on(x, y);
        if (edge && run < 0) run = x;
        else if (!edge && run >= 0) {
          path.moveTo(run, y);
          path.lineTo(x, y);
          run = -1;
          if (++n > 250000) return boundingOutline();
        }
      }
    }
    for (let x = x0; x <= x1; x++) {
      let run = -1;
      for (let y = y0; y <= y1; y++) {
        const edge = y < y1 && on(x - 1, y) !== on(x, y);
        if (edge && run < 0) run = y;
        else if (!edge && run >= 0) {
          path.moveTo(x, run);
          path.lineTo(x, y);
          run = -1;
          if (++n > 250000) return boundingOutline();
        }
      }
    }
    return (this._outline = n ? path : null);
  }

  invert() {
    const out = new Uint8ClampedArray(this.data.length);
    for (let i = 0; i < out.length; i++) out[i] = 255 - this.data[i];
    return new Mask(this.w, this.h, out);
  }

  // mode: 'replace' | 'add' | 'subtract'
  combine(other, mode = 'replace') {
    if (mode === 'replace' || !other) return other || this;
    const a = this.data;
    const b = other.data;
    const out = new Uint8ClampedArray(a.length);
    if (mode === 'add') for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
    else for (let i = 0; i < a.length; i++) out[i] = Math.min(a[i], 255 - b[i]);
    return new Mask(this.w, this.h, out);
  }

  // Blur the mask (feather) and optionally re-threshold it (grow / shrink).
  // threshold: null → keep soft edge; low value → grow; high value → shrink.
  // keep: never lower existing values (anti-aliases the outer edge only, image borders stay intact).
  blurred(radius, threshold = null, keep = false) {
    const c = makeCanvas(this.w, this.h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.filter = `blur(${radius}px)`;
    g.drawImage(this.canvas(), 0, 0);
    const d = g.getImageData(0, 0, this.w, this.h).data;
    const out = new Uint8ClampedArray(this.w * this.h);
    for (let i = 0, j = 3; i < out.length; i++, j += 4) {
      const v = threshold == null ? d[j] : d[j] >= threshold ? 255 : 0;
      out[i] = keep && this.data[i] > v ? this.data[i] : v;
    }
    return new Mask(this.w, this.h, out);
  }
}

// Rasterize a closed shape into a mask. drawPath(ctx) builds the path in image coordinates;
// bounds limits the work area.
export function maskFromPath(w, h, bounds, drawPath) {
  const x0 = Math.max(0, Math.floor(bounds.x) - 1);
  const y0 = Math.max(0, Math.floor(bounds.y) - 1);
  const x1 = Math.min(w, Math.ceil(bounds.x + bounds.w) + 1);
  const y1 = Math.min(h, Math.ceil(bounds.y + bounds.h) + 1);
  const out = new Uint8ClampedArray(w * h);
  if (x1 <= x0 || y1 <= y0) return new Mask(w, h, out);
  const bw = x1 - x0;
  const bh = y1 - y0;
  const c = makeCanvas(bw, bh);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.translate(-x0, -y0);
  g.beginPath();
  drawPath(g);
  g.fillStyle = '#fff';
  g.fill('evenodd');
  const d = g.getImageData(0, 0, bw, bh).data;
  for (let y = 0; y < bh; y++) {
    const row = (y + y0) * w + x0;
    for (let x = 0, j = y * bw * 4 + 3; x < bw; x++, j += 4) out[row + x] = d[j];
  }
  return new Mask(w, h, out);
}

// Colour distance test against a reference colour (max channel difference incl. alpha).
function matcher(d, r, g, b, a, t) {
  return (i) => {
    const j = i * 4;
    if (a < 8 && d[j + 3] < 8) return true; // both (almost) transparent
    return Math.abs(d[j] - r) <= t && Math.abs(d[j + 1] - g) <= t && Math.abs(d[j + 2] - b) <= t && Math.abs(d[j + 3] - a) <= t;
  };
}

// Scanline flood fill from seed indices; `match(i)` decides whether pixel i belongs.
function flood(w, h, seeds, match) {
  const mask = new Uint8ClampedArray(w * h);
  const stack = [];
  for (const s of seeds) if (match(s)) stack.push(s);
  while (stack.length) {
    const i = stack.pop();
    if (mask[i]) continue;
    const y = (i / w) | 0;
    const row = y * w;
    let xl = i - row;
    let xr = xl;
    while (xl > 0 && !mask[row + xl - 1] && match(row + xl - 1)) xl--;
    while (xr < w - 1 && !mask[row + xr + 1] && match(row + xr + 1)) xr++;
    for (let x = xl; x <= xr; x++) mask[row + x] = 255;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let x = xl; x <= xr; x++) {
        const j = nrow + x;
        if (!mask[j] && match(j)) {
          if (!inRun) {
            stack.push(j);
            inRun = true;
          }
        } else inRun = false;
      }
    }
  }
  return mask;
}

// Reference colour for the wand: the clicked pixel, or the average of an n×n square around
// it (Photoshop's "Sample Size"), which makes noisy / JPEG images behave predictably.
function sampleColor(img, x, y, size) {
  const { width: w, height: h, data: d } = img;
  const r = Math.max(0, (size - 1) >> 1);
  let n = 0;
  const sum = [0, 0, 0, 0];
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const j = (yy * w + xx) * 4;
      for (let c = 0; c < 4; c++) sum[c] += d[j + c];
      n++;
    }
  }
  return sum.map((v) => v / n);
}

// Magic wand, Photoshop semantics: tolerance 0..255 (default 32) — a pixel is selected when
// every channel is within ±tolerance levels of the sampled colour. contiguous = flood fill
// from the seed, otherwise every matching pixel of the image. sample = 1 | 3 | 5 | 11 | 31.
export function wandMask(img, x, y, { tolerance = 32, contiguous = true, antialias = true, sample = 1 } = {}) {
  const w = img.width;
  const h = img.height;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return new Mask(w, h);
  const d = img.data;
  const [r, g, b, a] = sampleColor(img, x, y, sample);
  const match = matcher(d, r, g, b, a, Math.max(0, Math.min(255, tolerance)));
  let data;
  // With an averaged sample the clicked pixel itself may fall outside the range; the
  // flood must still start from it.
  if (contiguous) data = flood(w, h, [y * w + x], (i) => i === y * w + x || match(i));
  else {
    data = new Uint8ClampedArray(w * h);
    for (let i = 0; i < data.length; i++) if (match(i)) data[i] = 255;
  }
  const m = new Mask(w, h, data);
  return antialias ? m.blurred(0.6, null, true) : m;
}

// Uniform background: dominant colours of the image border, flood-filled inwards from every
// edge pixel that matches one of them. holes: also enclosed areas of the same colours.
// Returns a Mask of the background, or null.
export function backgroundMask(img, tolerance = 30, { holes = false } = {}) {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const buckets = new Map();
  for (const i of border) {
    const j = i * 4;
    const key = d[j + 3] < 8 ? -1 : ((d[j] >> 3) << 10) | ((d[j + 1] >> 3) << 5) | (d[j + 2] >> 3);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0, a: 0 }));
    b.n++;
    b.r += d[j];
    b.g += d[j + 1];
    b.b += d[j + 2];
    b.a += d[j + 3];
  }
  const palette = [...buckets.values()]
    .filter((b) => b.n >= border.length * 0.06)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((b) => [b.r / b.n, b.g / b.n, b.b / b.n, b.a / b.n]);
  if (!palette.length) return null;
  const t = Math.max(0, Math.min(255, tolerance)); // 0..255, like the wand
  const tests = palette.map(([r, g, b, a]) => matcher(d, r, g, b, a, t));
  const match = (i) => tests.some((fn) => fn(i));
  const data = flood(w, h, border, match);
  if (holes) for (let i = 0; i < data.length; i++) if (!data[i] && match(i)) data[i] = 255;
  const m = new Mask(w, h, data);
  return m.empty ? null : m.blurred(0.8, null, true);
}
