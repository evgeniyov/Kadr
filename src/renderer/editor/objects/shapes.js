// Rectangle, oval and straight line.
import { sizePx, rectLike, segmentLike, strokeStyle } from './common.js';
import { rgba } from '../color.js';
import { roundRectPath, pointInRect, distToEllipse, ellipseValue, distToSegment, dist, snapAngle } from '../geom.js';

function shapePath(ctx, o, inset) {
  const x = o.x + inset;
  const y = o.y + inset;
  const w = Math.max(0, o.w - inset * 2);
  const h = Math.max(0, o.h - inset * 2);
  if (o.type === 'oval') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, x, y, w, h, Math.max(0, (o.radius || 0) * (o.k || 1) - inset));
  }
}

function drawShape(ctx, o) {
  const lw = sizePx(o, 'stroke');
  if (o.fill === 'solid') {
    shapePath(ctx, o, 0);
    ctx.fillStyle = o.color;
    ctx.fill();
    return;
  }
  if (o.fill === 'semi') {
    shapePath(ctx, o, lw / 2);
    ctx.fillStyle = rgba(o.color, 0.28);
    ctx.fill();
  }
  shapePath(ctx, o, lw / 2);
  strokeStyle(ctx, o.color, lw);
  ctx.stroke();
}

// Interior of an outline shape is a 'weak' hit: strokes of objects below it win.
function hitShape(o, x, y, tol) {
  const lw = sizePx(o, 'stroke');
  const inside = o.fill === 'outline' ? 'weak' : 'fill';
  if (o.type === 'oval') {
    if (distToEllipse(x, y, o) <= tol + lw) return 'stroke';
    return ellipseValue(x, y, o) <= 1 ? inside : null;
  }
  if (!pointInRect(x, y, o, tol)) return null;
  const inner = { x: o.x + lw + tol, y: o.y + lw + tol, w: o.w - 2 * (lw + tol), h: o.h - 2 * (lw + tol) };
  if (inner.w > 0 && inner.h > 0 && pointInRect(x, y, inner)) return inside;
  return 'stroke';
}

function makeShape(type) {
  return {
    ...rectLike,
    props: type === 'rect' ? ['color', 'size', 'opacity', 'fill', 'radius', 'shadow'] : ['color', 'size', 'opacity', 'fill', 'shadow'],
    layered: true,
    create(p, x, y) {
      const o = { x, y, w: 0, h: 0, fill: type === 'rect' ? p.rectFill || 'outline' : p.ovalFill || 'outline' };
      if (type === 'rect') o.radius = p.rectRadius || 0;
      return o;
    },
    draw: drawShape,
    hit: hitShape,
  };
}

export const rect = makeShape('rect');
export const oval = makeShape('oval');

export const line = {
  ...segmentLike,
  props: ['color', 'size', 'opacity', 'lineStyle', 'shadow'],
  layered: true,
  create(p, x, y) {
    return { x1: x, y1: y, x2: x, y2: y, dash: p.lineStyle || 'solid' };
  },
  drag(o, sx, sy, x, y, mods) {
    if (mods.shift) [x, y] = snapAngle(sx, sy, x, y);
    o.x2 = x;
    o.y2 = y;
  },
  isEmpty(o) {
    return dist(o.x1, o.y1, o.x2, o.y2) < 4 * (o.k || 1);
  },
  draw(ctx, o) {
    const lw = sizePx(o, 'stroke');
    strokeStyle(ctx, o.color, lw, o.dash === 'dashed' ? 'butt' : 'round');
    if (o.dash === 'dashed') ctx.setLineDash([lw * 3, lw * 2]);
    else if (o.dash === 'dotted') ctx.setLineDash([0.001, lw * 2]);
    ctx.beginPath();
    ctx.moveTo(o.x1, o.y1);
    ctx.lineTo(o.x2, o.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  },
  hit(o, x, y, tol) {
    return distToSegment(x, y, o.x1, o.y1, o.x2, o.y2) <= tol + sizePx(o, 'stroke') / 2 ? 'stroke' : null;
  },
  setHandle(o, id, x, y, mods, orig) {
    if (id === 'p1') {
      if (mods.shift) [x, y] = snapAngle(orig.x2, orig.y2, x, y);
      o.x1 = x;
      o.y1 = y;
    } else {
      if (mods.shift) [x, y] = snapAngle(orig.x1, orig.y1, x, y);
      o.x2 = x;
      o.y2 = y;
    }
  },
};
