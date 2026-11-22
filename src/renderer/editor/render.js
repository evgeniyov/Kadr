// Renders a document (backdrop + base image + objects) into a canvas at full resolution.
// The same code path is used for the on-screen composite and for export.
import { typeOf } from './objects/index.js';
import { makeCanvas } from './doc.js';
import { GRADIENTS, RATIOS } from './consts.js';
import { roundRectPath, inflate, rectKey } from './geom.js';
import { readPixels, computeTrim } from './pixels.js';

const MAX_SIDE = 32000;

// Output geometry. Document coordinates map to output pixels by adding (ox, oy).
// `src` is the part of the document shown as "the screenshot" (auto-crop trims it).
export function computeLayout(doc, bd, trim) {
  const W = doc.width;
  const H = doc.height;
  const full = { x: 0, y: 0, w: W, h: H };
  if (!bd?.enabled) return { width: W, height: H, ox: 0, oy: 0, content: { ...full }, src: full, backdrop: false };
  const k = doc.scale || 1;
  const src = bd.autocrop && trim ? trim : full;
  const pad = Math.round(Math.max(0, bd.padding ?? 64) * k);
  let OW = src.w + pad * 2;
  let OH = src.h + pad * 2;
  const ratio = RATIOS.find((r) => r.id === bd.ratio);
  if (ratio?.w) {
    const r = ratio.w / ratio.h;
    if (OW / OH < r) OW = Math.round(OH * r);
    else OH = Math.round(OW / r);
  }
  OW = Math.min(MAX_SIDE, OW);
  OH = Math.min(MAX_SIDE, OH);
  const cx = Math.round((OW - src.w) / 2);
  const cy = Math.round((OH - src.h) / 2);
  return { width: OW, height: OH, ox: cx - src.x, oy: cy - src.y, content: { x: cx, y: cy, w: src.w, h: src.h }, src, backdrop: true };
}

export function gradientSpec(bd) {
  if (bd.gradient >= 0 && GRADIENTS[bd.gradient]) return GRADIENTS[bd.gradient];
  return { stops: [bd.gradientFrom || '#7F7FD5', bd.gradientTo || '#91EAE4'], angle: bd.gradientAngle ?? 135 };
}

// CSS-like linear gradient covering a W×H box.
export function linearGradient(ctx, W, H, { stops, angle }) {
  const a = ((angle ?? 135) * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
  const g = ctx.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
  stops.forEach((c, i) => g.addColorStop(stops.length > 1 ? i / (stops.length - 1) : 0, c));
  return g;
}

export class Renderer {
  constructor(doc) {
    this.doc = doc;
    this.cache = new Map(); // derived values (erase colours…), keyed by content
    this.layerCanvas = makeCanvas(1, 1);
    this.scratches = [];
    this.bgImage = null; // ImageBitmap for the backdrop "image" type
    this.frozen = null; // { key, index, canvas, spotlightDone }
    this.contentCache = null;
    this.trimCache = null;
  }

  // Uniform-border trim of the base image (for backdrop auto-crop); cached per base image.
  trimRect() {
    const v = this.doc.baseVersion;
    if (this.trimCache?.v !== v) this.trimCache = { v, rect: computeTrim(readPixels(this.doc.base)) };
    return this.trimCache.rect;
  }

  layout(bd, { raw = false } = {}) {
    const b = raw ? null : bd;
    return computeLayout(this.doc, b, b?.enabled && b.autocrop ? this.trimRect() : null);
  }

  scratch(i, w, h) {
    w = Math.max(1, Math.ceil(w));
    h = Math.max(1, Math.ceil(h));
    let s = this.scratches[i];
    if (!s) s = this.scratches[i] = { canvas: makeCanvas(w, h) };
    if (s.canvas.width < w || s.canvas.height < h) {
      s.canvas.width = Math.max(w, s.canvas.width);
      s.canvas.height = Math.max(h, s.canvas.height);
    }
    const g = (s.ctx = s.canvas.getContext('2d'));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.filter = 'none';
    g.clearRect(0, 0, w, h);
    return s;
  }

  // Draw `fn` into an offscreen layer (bounded by doc rect `r`) and composite it with alpha/blend/shadow.
  withLayer(ctx, r, off, fn, { alpha = 1, blend = null, shadow = null } = {}) {
    const T = ctx.canvas;
    const x0 = Math.max(0, Math.floor(r.x + off.x));
    const y0 = Math.max(0, Math.floor(r.y + off.y));
    const x1 = Math.min(T.width, Math.ceil(r.x + r.w + off.x));
    const y1 = Math.min(T.height, Math.ceil(r.y + r.h + off.y));
    if (x1 <= x0 || y1 <= y0) return;
    const L = this.layerCanvas;
    if (L.width < T.width || L.height < T.height) {
      L.width = Math.max(L.width, T.width);
      L.height = Math.max(L.height, T.height);
    }
    const g = L.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(x0, y0, x1 - x0, y1 - y0);
    g.save();
    g.beginPath();
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.clip();
    g.translate(off.x, off.y);
    fn(g);
    g.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    if (blend) ctx.globalCompositeOperation = blend;
    if (shadow) {
      ctx.shadowColor = shadow.color;
      ctx.shadowBlur = shadow.blur;
      ctx.shadowOffsetY = shadow.offsetY;
    }
    ctx.drawImage(L, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  drawObject(ctx, o, env) {
    const T = typeOf(o);
    if (!T) return;
    const k = o.k || 1;
    const wantsShadow = o.shadow && T.props.includes('shadow');
    ctx.save();
    try {
      if (T.layered && (o.opacity < 0.999 || wantsShadow || T.blend)) {
        const b = inflate(T.bounds(o, env), 24 * k);
        const shadow = wantsShadow ? { color: 'rgba(0, 0, 0, 0.32)', blur: 5 * k, offsetY: 1.5 * k } : null;
        this.withLayer(ctx, b, env.offset, (g) => T.draw(g, o, env), { alpha: o.opacity ?? 1, blend: T.blend, shadow });
      } else {
        ctx.globalAlpha = o.opacity ?? 1;
        T.draw(ctx, o, env);
      }
    } catch (e) {
      console.error('draw failed', o.type, e);
    } finally {
      ctx.restore();
    }
  }

  #paintBackground(ctx, L, bd) {
    const W = L.width;
    const H = L.height;
    if (bd.type === 'solid') {
      ctx.fillStyle = bd.solid || '#E9E9EF';
      ctx.fillRect(0, 0, W, H);
    } else if (bd.type === 'image' && this.bgImage) {
      const img = this.bgImage;
      const s = Math.max(W / img.width, H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    } else if (bd.type !== 'transparent') {
      ctx.fillStyle = linearGradient(ctx, W, H, gradientSpec(bd));
      ctx.fillRect(0, 0, W, H);
    }
  }

  // The screenshot clipped to the inner corner radius (cached, it only depends on the base image).
  #content(L, bd) {
    const k = this.doc.scale || 1;
    const r = Math.max(0, (bd.innerRadius || 0) * k);
    const key = `${this.doc.baseVersion}|${rectKey(L.src)}|${r}`;
    if (this.contentCache?.key === key) return this.contentCache.canvas;
    const c = makeCanvas(L.src.w, L.src.h);
    const g = c.getContext('2d');
    if (r > 0) {
      roundRectPath(g, 0, 0, c.width, c.height, r);
      g.clip();
    }
    g.drawImage(this.doc.base, -L.src.x, -L.src.y);
    this.contentCache = { key, canvas: c };
    return c;
  }

  #drawBase(ctx, L, bd) {
    if (!L.backdrop) {
      ctx.drawImage(this.doc.base, 0, 0);
      return;
    }
    const k = this.doc.scale || 1;
    ctx.save();
    const outer = Math.max(0, (bd.outerRadius || 0) * k);
    if (outer > 0) {
      roundRectPath(ctx, 0, 0, L.width, L.height, outer);
      ctx.clip();
    }
    this.#paintBackground(ctx, L, bd);
    const s = Math.max(0, Math.min(1, bd.shadow ?? 0.5));
    if (s > 0) {
      ctx.shadowColor = `rgba(0, 0, 0, ${0.12 + 0.4 * s})`;
      ctx.shadowBlur = (8 + 56 * s) * k;
      ctx.shadowOffsetY = (2 + 18 * s) * k;
    }
    ctx.drawImage(this.#content(L, bd), L.content.x, L.content.y);
    ctx.restore();
  }

  #env(target, L, objects, skip) {
    const doc = this.doc;
    const offset = { x: L.ox, y: L.oy };
    const ctx = target.getContext('2d');
    return {
      target,
      offset,
      doc,
      objects,
      skip,
      assets: doc.assets,
      cache: this.cache,
      baseVersion: doc.baseVersion,
      imageRect: L.src,
      spotlightDone: false,
      counterNumber: (o) => doc.counterNumber(o),
      scratch: (i, w, h) => this.scratch(i, w, h),
      layer: (r, fn, opts) => this.withLayer(ctx, r, offset, fn, opts),
    };
  }

  unfreeze() {
    this.frozen = null;
  }

  // opts: { layout, backdrop, concealOnly, skip:Set, freezeIndex }
  // freezeIndex: objects below this index are cached between frames during an interaction.
  render(target, { layout: L, backdrop, concealOnly = false, skip = null, freezeIndex = null }) {
    if (target.width !== L.width || target.height !== L.height) {
      target.width = L.width;
      target.height = L.height;
    }
    if (this.cache.size > 400) this.cache.clear();
    const ctx = target.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, L.width, L.height);

    const objects = concealOnly ? this.doc.objects.filter((o) => o.type === 'conceal') : this.doc.objects;
    const env = this.#env(target, L, objects, skip);
    const fkey = `${L.width}x${L.height}|${L.ox},${L.oy}|${this.doc.baseVersion}|${JSON.stringify(backdrop || {})}|${this.bgImage ? 1 : 0}`;
    let start = 0;
    const useFreeze = freezeIndex != null && freezeIndex > 0 && !concealOnly && !skip;
    if (useFreeze && this.frozen?.key === fkey && this.frozen.index === freezeIndex) {
      ctx.drawImage(this.frozen.canvas, 0, 0);
      env.spotlightDone = this.frozen.spotlightDone;
      start = freezeIndex;
    } else {
      this.#drawBase(ctx, L, backdrop || {});
      if (useFreeze) {
        ctx.setTransform(1, 0, 0, 1, L.ox, L.oy);
        for (let i = 0; i < Math.min(freezeIndex, objects.length); i++) this.drawObject(ctx, objects[i], env);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const c = this.frozen?.canvas && this.frozen.canvas.width === L.width && this.frozen.canvas.height === L.height ? this.frozen.canvas : makeCanvas(L.width, L.height);
        const g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(target, 0, 0);
        this.frozen = { key: fkey, index: freezeIndex, canvas: c, spotlightDone: env.spotlightDone };
        start = freezeIndex;
      }
    }
    ctx.setTransform(1, 0, 0, 1, L.ox, L.oy);
    for (let i = start; i < objects.length; i++) {
      const o = objects[i];
      if (skip?.has(o.id)) continue;
      this.drawObject(ctx, o, env);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
