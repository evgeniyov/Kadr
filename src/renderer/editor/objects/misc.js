// Measurement (ruler) and pasted/captured image objects.
import { rectLike, segmentLike, resizeRect } from './common.js';
import { textFont, measure } from './text.js';
import { contrastColor } from '../color.js';
import { dist, distToSegment, pointInRect, snapAngle, union } from '../geom.js';

export function formatLength(px, unit, k) {
  if (unit === 'pt') {
    const v = px / (k || 1);
    return `${Math.round(v * 10) / 10} pt`;
  }
  return `${Math.round(px)} px`;
}

function rulerLabel(o) {
  const len = o.value ?? dist(o.x1, o.y1, o.x2, o.y2);
  const k = o.k || 1;
  const text = formatLength(len, o.unit, k);
  const fs = 11.5 * k;
  const w = measure(text, fs) + fs * 1.1;
  const h = fs * 1.7;
  const mx = (o.x1 + o.x2) / 2;
  const my = (o.y1 + o.y2) / 2;
  return { text, fs, box: { x: mx - w / 2, y: my - h / 2, w, h } };
}

export const ruler = {
  ...segmentLike,
  props: ['color', 'opacity', 'shadow', 'rulerUnit'],
  layered: true,
  create(p, x, y) {
    return { x1: x, y1: y, x2: x, y2: y, unit: p.rulerUnit || 'px' };
  },
  drag(o, sx, sy, x, y, mods) {
    if (mods.shift) [x, y] = snapAngle(sx, sy, x, y, 45);
    o.x2 = x;
    o.y2 = y;
    o.value = null;
  },
  isEmpty(o) {
    return dist(o.x1, o.y1, o.x2, o.y2) < 3 * (o.k || 1);
  },
  draw(ctx, o) {
    const k = o.k || 1;
    const lw = Math.max(1, 1.5 * k);
    const len = dist(o.x1, o.y1, o.x2, o.y2) || 1;
    const nx = -(o.y2 - o.y1) / len;
    const ny = (o.x2 - o.x1) / len;
    const tick = 6 * k;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(o.x1, o.y1);
    ctx.lineTo(o.x2, o.y2);
    for (const [x, y] of [[o.x1, o.y1], [o.x2, o.y2]]) {
      ctx.moveTo(x + nx * tick, y + ny * tick);
      ctx.lineTo(x - nx * tick, y - ny * tick);
    }
    ctx.stroke();
    const L = rulerLabel(o);
    ctx.beginPath();
    ctx.roundRect(L.box.x, L.box.y, L.box.w, L.box.h, L.box.h / 2);
    ctx.fillStyle = o.color;
    ctx.fill();
    ctx.font = textFont(L.fs, 600);
    ctx.fillStyle = contrastColor(o.color);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(L.text, L.box.x + L.box.w / 2, L.box.y + L.box.h / 2 + L.fs * 0.03);
    ctx.textAlign = 'left';
  },
  bounds(o) {
    const k = o.k || 1;
    const seg = segmentLike.bounds(o);
    return union({ x: seg.x - 7 * k, y: seg.y - 7 * k, w: seg.w + 14 * k, h: seg.h + 14 * k }, rulerLabel(o).box);
  },
  hit(o, x, y, tol) {
    if (distToSegment(x, y, o.x1, o.y1, o.x2, o.y2) <= tol + 3 * (o.k || 1)) return 'stroke';
    return pointInRect(x, y, rulerLabel(o).box, tol) ? 'stroke' : null;
  },
  setHandle(o, id, x, y, mods, orig) {
    const other = id === 'p1' ? [orig.x2, orig.y2] : [orig.x1, orig.y1];
    if (mods.shift) [x, y] = snapAngle(other[0], other[1], x, y, 45);
    if (id === 'p1') [o.x1, o.y1] = [x, y];
    else [o.x2, o.y2] = [x, y];
    o.value = null;
  },
  transform(o, map, s) {
    segmentLike.transform(o, map);
    if (o.value != null) o.value *= s;
  },
};

export const image = {
  ...rectLike,
  props: ['opacity', 'shadow'],
  layered: true,
  create(p, x, y) {
    return { x, y, w: 0, h: 0, asset: p.asset };
  },
  draw(ctx, o, env) {
    const img = env.assets.get(o.asset);
    if (!img) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, o.x, o.y, o.w, o.h);
  },
  // Corners keep the aspect ratio unless Shift is held.
  setHandle(o, id, x, y, mods, orig) {
    Object.assign(o, resizeRect(orig, id, x, y, !mods.shift));
  },
  transform(o, map, s, op, env) {
    rectLike.transform(o, map);
    if (op && op.kind !== 'resize' && env?.transformAsset) o.asset = env.transformAsset(o.asset, op);
  },
};
