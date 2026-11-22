// Arrow: two endpoints + a point on the curve (mx,my) that bends it into a quadratic bezier.
// Styles: classic (barbed head), curved (classic, bent by default), double, thin (open head), tapered.
import { sizePx, segmentLike, strokeStyle } from './common.js';
import { dist, quadControl, sampleQuad, trimPolyline, polylineLength, distToPolyline, boundsOfPoints, inflate, snapAngle } from '../geom.js';

const isStraight = (o) => dist(o.mx, o.my, (o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2) < 0.5;

function setDefaultBend(o) {
  const len = dist(o.x1, o.y1, o.x2, o.y2);
  o.mx = (o.x1 + o.x2) / 2;
  o.my = (o.y1 + o.y2) / 2;
  if (o.style === 'curved' && len > 0) {
    const nx = (o.y2 - o.y1) / len;
    const ny = -(o.x2 - o.x1) / len;
    o.mx += nx * len * 0.2;
    o.my += ny * len * 0.2;
  }
}

function centerline(o) {
  if (isStraight(o)) return [[o.x1, o.y1], [o.x2, o.y2]];
  const [cx, cy] = quadControl(o.x1, o.y1, o.mx, o.my, o.x2, o.y2);
  return sampleQuad(o.x1, o.y1, cx, cy, o.x2, o.y2, 48);
}

// Unit direction of the curve arriving at its end (or leaving its start when atStart).
function tipDir(o, atStart) {
  const [cx, cy] = quadControl(o.x1, o.y1, o.mx, o.my, o.x2, o.y2);
  let dx;
  let dy;
  if (atStart) {
    dx = o.x1 - cx;
    dy = o.y1 - cy;
  } else {
    dx = o.x2 - cx;
    dy = o.y2 - cy;
  }
  let l = Math.hypot(dx, dy);
  if (l < 1e-3) {
    dx = atStart ? o.x1 - o.x2 : o.x2 - o.x1;
    dy = atStart ? o.y1 - o.y2 : o.y2 - o.y1;
    l = Math.hypot(dx, dy) || 1;
  }
  return [dx / l, dy / l];
}

function geometry(o) {
  const w = sizePx(o, 'arrow');
  const k = o.k || 1;
  const pts = centerline(o);
  const len = polylineLength(pts);
  let headLen;
  let halfW;
  let shaftW = w;
  if (o.style === 'thin') {
    shaftW = Math.max(k, w * 0.5);
    headLen = shaftW * 4 + 7 * k;
    halfW = headLen * 0.5;
  } else if (o.style === 'tapered') {
    headLen = w * 3 + 6 * k;
    halfW = headLen * 0.58;
  } else {
    headLen = w * 3.2 + 5 * k;
    halfW = headLen * 0.56;
  }
  const maxHead = len * (o.style === 'double' ? 0.4 : 0.6);
  if (headLen > maxHead) {
    const f = maxHead / headLen;
    headLen *= f;
    halfW *= f;
  }
  return { w, k, pts, len, headLen, halfW, shaftW };
}

function headPolygon(tx, ty, [dx, dy], headLen, halfW, notch) {
  const nx = -dy;
  const ny = dx;
  const bx = tx - dx * headLen;
  const by = ty - dy * headLen;
  const pts = [[tx, ty], [bx + nx * halfW, by + ny * halfW]];
  if (notch) pts.push([tx - dx * headLen * notch, ty - dy * headLen * notch]);
  pts.push([bx - nx * halfW, by - ny * halfW]);
  return pts;
}

function fillPoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

function strokePoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function drawTapered(ctx, o, g) {
  const shaft = trimPolyline(g.pts, 0, g.headLen * 0.85);
  const total = polylineLength(shaft) || 1;
  const w0 = g.w * 0.22;
  const w1 = g.w * 1.15;
  const left = [];
  const right = [];
  let acc = 0;
  for (let i = 0; i < shaft.length; i++) {
    const [x, y] = shaft[i];
    if (i) acc += dist(shaft[i - 1][0], shaft[i - 1][1], x, y);
    const a = shaft[Math.max(0, i - 1)];
    const b = shaft[Math.min(shaft.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / l;
    const ny = (b[0] - a[0]) / l;
    const hw = (w0 + (w1 - w0) * (acc / total)) / 2;
    left.push([x + nx * hw, y + ny * hw]);
    right.push([x - nx * hw, y - ny * hw]);
  }
  fillPoly(ctx, [...left, ...right.reverse()]);
  ctx.beginPath();
  ctx.arc(shaft[0][0], shaft[0][1], w0 / 2, 0, Math.PI * 2);
  ctx.fill();
  fillPoly(ctx, headPolygon(o.x2, o.y2, tipDir(o, false), g.headLen, g.halfW, 0));
}

const arrow = {
  props: ['color', 'size', 'opacity', 'arrowStyle', 'shadow'],
  layered: true,

  create(p, x, y) {
    return { x1: x, y1: y, x2: x, y2: y, mx: x, my: y, style: p.arrowStyle || 'classic' };
  },
  drag(o, sx, sy, x, y, mods) {
    if (mods.shift) [x, y] = snapAngle(sx, sy, x, y);
    o.x2 = x;
    o.y2 = y;
    setDefaultBend(o);
  },
  isEmpty(o) {
    return dist(o.x1, o.y1, o.x2, o.y2) < 6 * (o.k || 1);
  },
  // Called when the style changes from the toolbar: curved gets a default bend, others straighten.
  setStyle(o, style) {
    const wasCurved = o.style === 'curved';
    o.style = style;
    if (style === 'curved' && isStraight(o)) setDefaultBend(o);
    else if (wasCurved && style !== 'curved') setDefaultBend(o);
  },

  draw(ctx, o) {
    const g = geometry(o);
    ctx.fillStyle = o.color;
    if (o.style === 'tapered') return drawTapered(ctx, o, g);
    if (o.style === 'thin') {
      strokeStyle(ctx, o.color, g.shaftW);
      strokePoly(ctx, g.pts);
      const [dx, dy] = tipDir(o, false);
      const h = headPolygon(o.x2, o.y2, [dx, dy], g.headLen, g.halfW, 0);
      strokePoly(ctx, [h[1], h[0], h[2]]);
      return;
    }
    const dbl = o.style === 'double';
    const shaft = trimPolyline(g.pts, dbl ? g.headLen * 0.6 : 0, g.headLen * 0.6);
    strokeStyle(ctx, o.color, g.shaftW);
    strokePoly(ctx, shaft);
    fillPoly(ctx, headPolygon(o.x2, o.y2, tipDir(o, false), g.headLen, g.halfW, 0.78));
    if (dbl) fillPoly(ctx, headPolygon(o.x1, o.y1, tipDir(o, true), g.headLen, g.halfW, 0.78));
  },

  bounds(o) {
    const g = geometry(o);
    return inflate(boundsOfPoints(g.pts), Math.max(g.halfW, g.w));
  },
  hit(o, x, y, tol) {
    const g = geometry(o);
    if (distToPolyline(x, y, g.pts) <= tol + Math.max(g.w, g.shaftW) / 2) return 'stroke';
    if (dist(x, y, o.x2, o.y2) <= g.headLen * 0.7 + tol) return 'stroke';
    return null;
  },
  handles(o) {
    return [
      { id: 'p1', x: o.x1, y: o.y1 },
      { id: 'mid', x: o.mx, y: o.my, kind: 'mid' },
      { id: 'p2', x: o.x2, y: o.y2 },
    ];
  },
  setHandle(o, id, x, y, mods, orig) {
    if (id === 'mid') {
      const mx = (o.x1 + o.x2) / 2;
      const my = (o.y1 + o.y2) / 2;
      const snap = 4 * (o.k || 1);
      if (dist(x, y, mx, my) < snap) [x, y] = [mx, my];
      o.mx = x;
      o.my = y;
      return;
    }
    const other = id === 'p1' ? [orig.x2, orig.y2] : [orig.x1, orig.y1];
    if (mods.shift) [x, y] = snapAngle(other[0], other[1], x, y);
    const key = id === 'p1' ? ['x1', 'y1'] : ['x2', 'y2'];
    const dx = x - orig[key[0]];
    const dy = y - orig[key[1]];
    o[key[0]] = x;
    o[key[1]] = y;
    if (isStraight(orig)) {
      o.mx = (o.x1 + o.x2) / 2;
      o.my = (o.y1 + o.y2) / 2;
    } else {
      o.mx = orig.mx + dx / 2;
      o.my = orig.my + dy / 2;
    }
  },
  translate(o, dx, dy) {
    segmentLike.translate(o, dx, dy);
    o.mx += dx;
    o.my += dy;
  },
  transform(o, map) {
    segmentLike.transform(o, map);
    [o.mx, o.my] = map(o.mx, o.my);
  },
};

export default arrow;
