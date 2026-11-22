// Freehand pen and highlighter (marker drawn with a multiply blend by the renderer).
import { sizePx, rectHandles, resizeRect, strokeStyle } from './common.js';
import { boundsOfPoints, inflate, distToPolyline, simplify, dist, snapAngle } from '../geom.js';

function tracePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    return;
  }
  if (pts.length === 2) {
    ctx.lineTo(pts[1][0], pts[1][1]);
    return;
  }
  // Quadratic curves through the midpoints give a smooth line without overshoot.
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function makeStroke(type) {
  const table = type === 'highlighter' ? 'highlighter' : 'stroke';
  return {
    props: type === 'highlighter' ? ['color', 'size', 'opacity'] : ['color', 'size', 'opacity', 'shadow'],
    layered: true,
    blend: type === 'highlighter' ? 'multiply' : null,

    create(p, x, y) {
      return { points: [[x, y]] };
    },
    drag(o, sx, sy, x, y, mods) {
      if (mods.shift) {
        // Straight line from the first point (angle snapped).
        const [ex, ey] = snapAngle(sx, sy, x, y, 45);
        o.points = [[sx, sy], [ex, ey]];
        o.straight = true;
        return;
      }
      if (o.straight) {
        o.points = [[sx, sy]];
        o.straight = false;
      }
      const last = o.points[o.points.length - 1];
      if (dist(last[0], last[1], x, y) >= 1) o.points.push([x, y]);
    },
    finish(o) {
      if (o.points.length > 2) o.points = simplify(o.points, 0.45 * (o.k || 1));
      delete o.straight;
    },
    isEmpty(o) {
      return false;
    },
    draw(ctx, o) {
      if (!o.points?.length) return;
      const lw = sizePx(o, table);
      const cap = type === 'highlighter' && o.points.length === 2 ? 'butt' : 'round';
      strokeStyle(ctx, o.color, lw, cap);
      tracePath(ctx, o.points);
      ctx.stroke();
    },
    bounds(o) {
      return inflate(boundsOfPoints(o.points), sizePx(o, table) / 2);
    },
    hit(o, x, y, tol) {
      return distToPolyline(x, y, o.points) <= tol + sizePx(o, table) / 2 ? 'stroke' : null;
    },
    handles(o) {
      const b = boundsOfPoints(o.points);
      if (b.w < 1 && b.h < 1) return [];
      return rectHandles(b, ['nw', 'ne', 'se', 'sw']);
    },
    // Scale the points from the original bounds into the new bounds.
    setHandle(o, id, x, y, mods, orig) {
      const b = boundsOfPoints(orig.points);
      const nb = resizeRect(b, id, x, y, !mods.shift);
      const sx = b.w ? nb.w / b.w : 1;
      const sy = b.h ? nb.h / b.h : 1;
      o.points = orig.points.map(([px, py]) => [nb.x + (px - b.x) * sx, nb.y + (py - b.y) * sy]);
    },
    translate(o, dx, dy) {
      o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
    },
    transform(o, map) {
      o.points = o.points.map(([x, y]) => map(x, y));
    },
  };
}

export const freehand = makeStroke('freehand');
export const highlighter = makeStroke('highlighter');
