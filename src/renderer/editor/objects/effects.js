// Objects that read the pixels beneath them: conceal (pixelate / blur / smart erase),
// spotlight (dims everything outside its areas) and magnifier (loupe).
// They draw directly onto the render target: env.target is the canvas being rendered and
// env.offset converts document coordinates into target pixels.
import { sizePx, rectLike } from './common.js';
import { rectKey, inflate, intersect, dist, union, roundRectPath, pointInRect, ellipseValue } from '../geom.js';

export function parseConcealType(t = 'pixelate') {
  const [mode, suffix] = String(t).split('-');
  return { mode: ['pixelate', 'blur', 'erase'].includes(mode) ? mode : 'pixelate', textOnly: suffix === 'text' };
}

// Integer target-pixel rect for a document rect, clamped to the target. null when empty.
function targetRect(r, env) {
  const x0 = Math.max(0, Math.floor(r.x + env.offset.x));
  const y0 = Math.max(0, Math.floor(r.y + env.offset.y));
  const x1 = Math.min(env.target.width, Math.ceil(r.x + r.w + env.offset.x));
  const y1 = Math.min(env.target.height, Math.ceil(r.y + r.h + env.offset.y));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, dx: x0 - env.offset.x, dy: y0 - env.offset.y };
}

// Most common colour of a 2px ring around the rect (the "smart erase" fill colour).
// The four strips are resampled (nearest) into one small CPU canvas → a single readback.
const RING = 256;
let ringCanvas = null;

export function dominantBorderColor(target, t) {
  if (!ringCanvas) ringCanvas = new OffscreenCanvas(RING + 4, RING);
  const g = ringCanvas.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, RING + 4, RING);
  g.imageSmoothingEnabled = false;
  const W = target.width;
  const H = target.height;
  // [sx, sy, sw, sh] in target px → [dx, dy, dw, dh] in the ring canvas
  const strips = [
    [[t.x - 2, t.y - 2, t.w + 4, 2], [0, 0, RING, 2]],
    [[t.x - 2, t.y + t.h, t.w + 4, 2], [0, 2, RING, 2]],
    [[t.x - 2, t.y, 2, t.h], [RING, 0, 2, RING]],
    [[t.x + t.w, t.y, 2, t.h], [RING + 2, 0, 2, RING]],
  ];
  const used = [];
  for (const [[sx, sy, sw, sh], d] of strips) {
    // only strips fully inside the target (partial ones would be stretched)
    if (sx < 0 || sy < 0 || sx + sw > W || sy + sh > H || sw < 1 || sh < 1) continue;
    g.drawImage(target, sx, sy, sw, sh, d[0], d[1], d[2], d[3]);
    used.push(d);
  }
  if (!used.length) {
    // The area touches every edge: fall back to its own outermost rows.
    g.drawImage(target, t.x, t.y, t.w, 1, 0, 0, RING, 1);
    g.drawImage(target, t.x, t.y + t.h - 1, t.w, 1, 0, 1, RING, 1);
    used.push([0, 0, RING, 2]);
  }
  const data = g.getImageData(0, 0, RING + 4, RING).data;
  const buckets = new Map();
  for (const [dx, dy, dw, dh] of used) {
    for (let y = dy; y < dy + dh; y++) {
      for (let x = dx; x < dx + dw; x++) {
        const i = (y * (RING + 4) + x) * 4;
        const key = data[i + 3] < 128 ? -1 : ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
        b.n++;
        b.r += data[i];
        b.g += data[i + 1];
        b.b += data[i + 2];
      }
    }
  }
  let best = null;
  let bestKey = null;
  for (const [key, b] of buckets) {
    if (!best || b.n > best.n) {
      best = b;
      bestKey = key;
    }
  }
  if (!best || bestKey === -1) return null; // transparent surroundings
  return `rgb(${Math.round(best.r / best.n)}, ${Math.round(best.g / best.n)}, ${Math.round(best.b / best.n)})`;
}

function pixelate(ctx, o, r, t, env) {
  const block = Math.max(2, Math.round(sizePx(o, 'conceal') * 1.4));
  const cols = Math.ceil(t.w / block);
  const rows = Math.ceil(t.h / block);
  const s = env.scratch(0, cols, rows);
  s.ctx.imageSmoothingEnabled = true;
  s.ctx.imageSmoothingQuality = 'medium';
  s.ctx.drawImage(env.target, t.x, t.y, cols * block, rows * block, 0, 0, cols, rows);
  ctx.save();
  ctx.beginPath();
  ctx.rect(t.dx, t.dy, t.w, t.h);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s.canvas, 0, 0, cols, rows, t.dx, t.dy, cols * block, rows * block);
  ctx.restore();
}

function blur(ctx, o, r, t, env) {
  const rad = Math.max(2, sizePx(o, 'conceal') * 1.1);
  const pad = Math.ceil(rad * 2);
  const src = targetRect(inflate({ x: t.dx, y: t.dy, w: t.w, h: t.h }, pad), env);
  if (!src) return;
  const s = env.scratch(0, src.w, src.h);
  s.ctx.drawImage(env.target, src.x, src.y, src.w, src.h, 0, 0, src.w, src.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(t.dx, t.dy, t.w, t.h);
  ctx.clip();
  ctx.filter = `blur(${rad}px)`;
  ctx.drawImage(s.canvas, 0, 0, src.w, src.h, src.dx, src.dy, src.w, src.h);
  // A second pass hides remaining structure of large text.
  ctx.filter = `blur(${rad * 0.6}px)`;
  s.ctx.clearRect(0, 0, src.w, src.h);
  s.ctx.drawImage(env.target, src.x, src.y, src.w, src.h, 0, 0, src.w, src.h);
  ctx.drawImage(s.canvas, 0, 0, src.w, src.h, src.dx, src.dy, src.w, src.h);
  ctx.restore();
}

function erase(ctx, o, r, t, env) {
  const key = `erase:${rectKey(t)}:${env.baseVersion}`;
  let color = env.cache.get(key);
  if (color === undefined) {
    color = dominantBorderColor(env.target, t);
    env.cache.set(key, color);
  }
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(t.dx, t.dy, t.w, t.h);
  } else {
    ctx.clearRect(t.dx, t.dy, t.w, t.h);
  }
}

const EFFECTS = { pixelate, blur, erase };

// Regions actually concealed: the text lines found by OCR (text-only modes) or the whole area.
export function concealRegions(o) {
  if (o.textOnly && Array.isArray(o.boxes) && o.ocrKey === rectKey(o)) {
    const k = o.k || 1;
    return o.boxes.map((b) => intersect(inflate(b, 2 * k), o)).filter(Boolean);
  }
  return [o];
}

export const conceal = {
  ...rectLike,
  props: ['concealMode', 'size'],
  layered: false,
  create(p, x, y) {
    const { mode, textOnly } = parseConcealType(p.concealType);
    return { x, y, w: 0, h: 0, mode, textOnly, boxes: null, ocrKey: '' };
  },
  draw(ctx, o, env) {
    const fx = EFFECTS[o.mode] || pixelate;
    for (const r of concealRegions(o)) {
      const t = targetRect(r, env);
      if (t) fx(ctx, o, r, t, env);
    }
  },
};

// ---- Spotlight ---------------------------------------------------------------

export const spotlight = {
  ...rectLike,
  props: ['spotlightShape', 'dim'],
  layered: false,
  create(p, x, y) {
    return { x, y, w: 0, h: 0, shape: p.spotlightShape || 'rect', dim: p.spotlightDim ?? 0.55 };
  },
  // All spotlights are drawn together (as holes in one dim layer) at the first one's position.
  draw(ctx, o, env) {
    if (env.spotlightDone) return;
    env.spotlightDone = true;
    const spots = env.objects.filter((s) => s.type === 'spotlight' && !env.skip?.has(s.id));
    if (!spots.length) return;
    const dim = Math.max(...spots.map((s) => s.dim ?? 0.55));
    const R = env.imageRect;
    env.layer(R, (l) => {
      l.fillStyle = `rgba(0, 0, 0, ${dim})`;
      l.fillRect(R.x, R.y, R.w, R.h);
      l.globalCompositeOperation = 'destination-out';
      l.fillStyle = '#000';
      for (const s of spots) {
        if (s.shape === 'oval') {
          l.beginPath();
          l.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
        } else {
          roundRectPath(l, s.x, s.y, s.w, s.h, 3 * (s.k || 1));
        }
        l.fill();
      }
      l.globalCompositeOperation = 'source-over';
    });
  },
  hit(o, x, y, tol) {
    if (o.shape === 'oval') return ellipseValue(x, y, o) <= 1 + tol / Math.max(1, Math.min(o.w, o.h)) ? 'fill' : null;
    return pointInRect(x, y, o, tol) ? 'fill' : null;
  },
};

// ---- Magnifier ---------------------------------------------------------------

const linked = (o) => dist(o.sx, o.sy, o.tx, o.ty) < Math.max(2, o.r * 0.08);

export const magnifier = {
  props: ['color', 'size', 'magnifierZoom'],
  layered: false,
  defaultRadius: 64,

  create(p, x, y) {
    return { sx: x, sy: y, tx: x, ty: y, r: 0, zoom: p.magnifierZoom || 2 };
  },
  drag(o, sx, sy, x, y) {
    const k = o.k || 1;
    o.r = this.defaultRadius * k;
    if (dist(sx, sy, x, y) < 12 * k) {
      o.tx = sx;
      o.ty = sy;
    } else {
      o.tx = x;
      o.ty = y;
    }
  },
  isEmpty() {
    return false;
  },
  finish(o) {
    if (!o.r) o.r = this.defaultRadius * (o.k || 1);
  },
  draw(ctx, o, env) {
    if (!o.r) return;
    const k = o.k || 1;
    const ring = sizePx(o, 'stroke');
    const rs = o.r / o.zoom;
    const size = Math.ceil(rs * 2) + 2;
    const sx0 = Math.floor(o.sx - rs + env.offset.x);
    const sy0 = Math.floor(o.sy - rs + env.offset.y);
    const s = env.scratch(1, size, size);
    s.ctx.drawImage(env.target, sx0, sy0, size, size, 0, 0, size, size);
    ctx.save();
    if (!linked(o)) {
      const d = dist(o.sx, o.sy, o.tx, o.ty);
      const ux = (o.tx - o.sx) / d;
      const uy = (o.ty - o.sy) / d;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = Math.max(k, ring * 0.6);
      ctx.beginPath();
      ctx.arc(o.sx, o.sy, rs, 0, Math.PI * 2);
      ctx.stroke();
      if (d > rs + o.r) {
        ctx.beginPath();
        ctx.moveTo(o.sx + ux * rs, o.sy + uy * rs);
        ctx.lineTo(o.tx - ux * o.r, o.ty - uy * o.r);
        ctx.stroke();
      }
    }
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 14 * k;
    ctx.shadowOffsetY = 3 * k;
    ctx.beginPath();
    ctx.arc(o.tx, o.ty, o.r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(o.tx, o.ty, o.r, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = o.zoom < 3;
    ctx.imageSmoothingQuality = 'high';
    const docX0 = sx0 - env.offset.x;
    const docY0 = sy0 - env.offset.y;
    ctx.drawImage(s.canvas, 0, 0, size, size, o.tx + (docX0 - o.sx) * o.zoom, o.ty + (docY0 - o.sy) * o.zoom, size * o.zoom, size * o.zoom);
    ctx.restore();

    ctx.strokeStyle = o.color;
    ctx.lineWidth = ring;
    ctx.beginPath();
    ctx.arc(o.tx, o.ty, o.r - ring / 2, 0, Math.PI * 2);
    ctx.stroke();
  },
  bounds(o) {
    const pad = sizePx(o, 'stroke') + 16 * (o.k || 1);
    const t = inflate({ x: o.tx - o.r, y: o.ty - o.r, w: o.r * 2, h: o.r * 2 }, pad);
    if (linked(o)) return t;
    const rs = o.r / o.zoom;
    return union(t, { x: o.sx - rs, y: o.sy - rs, w: rs * 2, h: rs * 2 });
  },
  hit(o, x, y, tol) {
    if (dist(x, y, o.tx, o.ty) <= o.r + tol) return 'fill';
    if (!linked(o) && Math.abs(dist(x, y, o.sx, o.sy) - o.r / o.zoom) <= tol + 2) return 'stroke';
    return null;
  },
  handles(o) {
    const a = Math.PI / 4;
    const hs = [{ id: 'r', x: o.tx + Math.cos(a) * o.r, y: o.ty + Math.sin(a) * o.r }];
    hs.push({ id: 'src', x: o.sx, y: o.sy, kind: 'mid' });
    return hs;
  },
  setHandle(o, id, x, y, mods, orig) {
    if (id === 'r') o.r = Math.max(10 * (o.k || 1), dist(o.tx, o.ty, x, y));
    else if (id === 'src') {
      o.sx = x;
      o.sy = y;
    }
  },
  // Dragging the loupe moves only the loupe; the magnified source stays where it is.
  moveBody(o, dx, dy, orig) {
    o.tx = orig.tx + dx;
    o.ty = orig.ty + dy;
  },
  translate(o, dx, dy) {
    o.sx += dx;
    o.sy += dy;
    o.tx += dx;
    o.ty += dy;
  },
  transform(o, map, s) {
    [o.sx, o.sy] = map(o.sx, o.sy);
    [o.tx, o.ty] = map(o.tx, o.ty);
    o.r *= s;
  },
};

