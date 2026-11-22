// Small geometry helpers (all coordinates are plain numbers in document pixels).

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const lerp = (a, b, t) => a + (b - a) * t;

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyline(px, py, pts) {
  if (pts.length === 1) return dist(px, py, pts[0][0], pts[0][1]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, distToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  return best;
}

export function normRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// Rectangle from a drag: shift → square, alt → from the centre.
export function rectFromDrag(sx, sy, x, y, { shift = false, alt = false } = {}) {
  let w = x - sx;
  let h = y - sy;
  if (shift) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  if (alt) return { x: sx - Math.abs(w), y: sy - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 };
  return normRect(sx, sy, sx + w, sy + h);
}

export const pointInRect = (px, py, r, pad = 0) => px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;

export function ellipseValue(px, py, r) {
  const rx = r.w / 2 || 1e-6;
  const ry = r.h / 2 || 1e-6;
  const nx = (px - (r.x + rx)) / rx;
  const ny = (py - (r.y + ry)) / ry;
  return nx * nx + ny * ny;
}

// Approximate distance from a point to an ellipse outline.
export function distToEllipse(px, py, r) {
  const v = Math.sqrt(ellipseValue(px, py, r));
  return Math.abs(v - 1) * Math.min(r.w, r.h) / 2;
}

export function inflate(r, d) {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

export function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

export function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function boundsOfPoints(pts) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Map a rectangle through a point transform (only axis-preserving maps: 90° rotations, flips, scaling).
export function mapRect(r, map) {
  const [ax, ay] = map(r.x, r.y);
  const [bx, by] = map(r.x + r.w, r.y + r.h);
  return normRect(ax, ay, bx, by);
}

// Snap (x,y) so that the segment from (sx,sy) has an angle multiple of `step` degrees.
export function snapAngle(sx, sy, x, y, step = 15) {
  const len = dist(sx, sy, x, y);
  const a = Math.atan2(y - sy, x - sx);
  const s = (step * Math.PI) / 180;
  const sa = Math.round(a / s) * s;
  return [sx + Math.cos(sa) * len, sy + Math.sin(sa) * len];
}

// Quadratic bezier helpers. The curve is defined by endpoints and a point `m` ON the curve at t=0.5.
export function quadControl(x1, y1, mx, my, x2, y2) {
  return [2 * mx - (x1 + x2) / 2, 2 * my - (y1 + y2) / 2];
}

export function quadAt(x1, y1, cx, cy, x2, y2, t) {
  const u = 1 - t;
  return [u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2];
}

export function sampleQuad(x1, y1, cx, cy, x2, y2, n = 40) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(quadAt(x1, y1, cx, cy, x2, y2, i / n));
  return pts;
}

export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return len;
}

// Cut `fromStart` / `fromEnd` arc length off a polyline.
export function trimPolyline(pts, fromStart, fromEnd) {
  const total = polylineLength(pts);
  const a = clamp(fromStart, 0, total);
  const b = clamp(total - fromEnd, a, total);
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const seg = dist(x0, y0, x1, y1);
    const s0 = acc;
    const s1 = acc + seg;
    acc = s1;
    if (s1 < a || s0 > b || seg === 0) continue;
    const t0 = clamp((a - s0) / seg, 0, 1);
    const t1 = clamp((b - s0) / seg, 0, 1);
    if (!out.length) out.push([lerp(x0, x1, t0), lerp(y0, y1, t0)]);
    out.push([lerp(x0, x1, t1), lerp(y0, y1, t1)]);
  }
  if (!out.length && pts.length) out.push(pts[0].slice());
  return out;
}

// Ramer–Douglas–Peucker polyline simplification.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  if (rr > 0.01) ctx.roundRect(x, y, w, h, rr);
  else ctx.rect(x, y, w, h);
}

export const rectKey = (r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`;
