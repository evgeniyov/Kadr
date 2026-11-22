// Helpers shared by object types: sizes, rectangle handles/resizing, generic transforms.
import { SIZES } from '../consts.js';
import { normRect, mapRect, rectFromDrag, pointInRect } from '../geom.js';

// Size preset (1..6) → pixels for a given table, scaled by the object's px-per-DIP factor `k`.
export function sizePx(o, table = 'stroke') {
  const arr = SIZES[table];
  const i = Math.max(0, Math.min(arr.length - 1, (o.size || 3) - 1));
  return arr[i] * (o.k || 1);
}

export const RECT_HANDLE_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function rectHandles(r, ids = RECT_HANDLE_IDS) {
  const { x, y, w, h } = r;
  const pos = {
    nw: [x, y],
    n: [x + w / 2, y],
    ne: [x + w, y],
    e: [x + w, y + h / 2],
    se: [x + w, y + h],
    s: [x + w / 2, y + h],
    sw: [x, y + h],
    w: [x, y + h / 2],
  };
  return ids.map((id) => ({ id, x: pos[id][0], y: pos[id][1] }));
}

// Resize `orig` rect by dragging handle `id` to (x,y). keepRatio applies to corner handles.
export function resizeRect(orig, id, x, y, keepRatio = false) {
  let x1 = orig.x;
  let y1 = orig.y;
  let x2 = orig.x + orig.w;
  let y2 = orig.y + orig.h;
  if (keepRatio && id.length === 2 && orig.w > 0 && orig.h > 0) {
    const ax = id.includes('w') ? x2 : x1;
    const ay = id.includes('n') ? y2 : y1;
    let w = x - ax;
    let h = y - ay;
    const ratio = orig.w / orig.h;
    if (Math.abs(w) / ratio > Math.abs(h)) h = Math.sign(h || 1) * (Math.abs(w) / ratio);
    else w = Math.sign(w || 1) * Math.abs(h) * ratio;
    return normRect(ax, ay, ax + w, ay + h);
  }
  if (id.includes('w')) x1 = x;
  if (id.includes('e')) x2 = x;
  if (id.includes('n')) y1 = y;
  if (id.includes('s')) y2 = y;
  return normRect(x1, y1, x2, y2);
}

// Mixin for objects described by {x, y, w, h}.
export const rectLike = {
  create(p, x, y) {
    return { x, y, w: 0, h: 0 };
  },
  drag(o, sx, sy, x, y, mods) {
    Object.assign(o, rectFromDrag(sx, sy, x, y, mods));
  },
  isEmpty(o) {
    return o.w < 3 * (o.k || 1) || o.h < 3 * (o.k || 1);
  },
  bounds(o) {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  },
  handles(o) {
    return rectHandles(o);
  },
  setHandle(o, id, x, y, mods, orig) {
    Object.assign(o, resizeRect(orig, id, x, y, mods.shift));
  },
  translate(o, dx, dy) {
    o.x += dx;
    o.y += dy;
  },
  transform(o, map) {
    Object.assign(o, mapRect(o, map));
  },
  hit(o, x, y, tol) {
    return pointInRect(x, y, o, tol) ? 'fill' : null;
  },
};

// Mixin for objects described by two points {x1,y1,x2,y2}.
export const segmentLike = {
  bounds(o) {
    return normRect(o.x1, o.y1, o.x2, o.y2);
  },
  handles(o) {
    return [
      { id: 'p1', x: o.x1, y: o.y1 },
      { id: 'p2', x: o.x2, y: o.y2 },
    ];
  },
  translate(o, dx, dy) {
    o.x1 += dx;
    o.y1 += dy;
    o.x2 += dx;
    o.y2 += dy;
  },
  transform(o, map) {
    [o.x1, o.y1] = map(o.x1, o.y1);
    [o.x2, o.y2] = map(o.x2, o.y2);
  },
};

// Stroke styling helper.
export function strokeStyle(ctx, color, width, cap = 'round') {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
}
