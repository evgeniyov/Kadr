// Finds UI blocks inside a window from the frozen screenshot: a post on the chat background,
// a card on a page, a picture, a panel with its own background. Works on pixels only, so it
// doesn't depend on what the app tells the system.
//
// A "surface" is a flat background area (grown from a seed while neighbouring pixels stay
// close in colour, so gentle gradients and soft shadows belong to it). A block is a connected
// region of everything that is *not* a given surface, fully enclosed by it, solid enough and
// not touching the window edges. Every surface around the cursor gives at most one block, and
// together they nest: text line ⊂ quote ⊂ message ⊂ … ⊂ window.
//
// Coordinates are CSS px of the display (the image is scaled to that size first).

const STEP = 6; // max colour step between neighbouring pixels of one surface (sum of |ΔR|+|ΔG|+|ΔB|)
const RANGE = 60; // max distance from the seed colour (lets gradients through, not other surfaces)
const MIN_SURFACE = 400; // px; smaller flat patches (inside letters, photos) are no background
const MIN_W = 60;
const MIN_H = 36;
const MIN_AREA = 5000;
const MIN_FILL = 0.72; // block pixels / bounding box: drops sparse things like a line of text
const MAX_COMPS = 12; // cached component maps per window

let W = 0;
let H = 0;
let px = null; // RGBA of the whole display
const contexts = new Map(); // window rect → analysis state

/** The display image: RGBA bytes, width, height (CSS px). Drops everything computed before. */
export function setImage(rgba, w, h) {
  px = rgba;
  W = w;
  H = h;
  contexts.clear();
}

function context(r) {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const w = Math.min(W, Math.round(r.x + r.w)) - x0;
  const h = Math.min(H, Math.round(r.y + r.h)) - y0;
  if (w < MIN_W || h < MIN_H) return null;
  const key = `${x0},${y0},${w},${h}`;
  let c = contexts.get(key);
  if (!c) {
    // Other windows' state is not needed while the cursor is over this one.
    for (const k of [...contexts.keys()].slice(0, Math.max(0, contexts.size - 2))) contexts.delete(k);
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0, o = ((y0 + y) * W + x0) * 4; x < w; x++, o += 4, i += 3) {
        rgb[i] = px[o];
        rgb[i + 1] = px[o + 1];
        rgb[i + 2] = px[o + 2];
      }
    }
    c = { x0, y0, w, h, rgb, surf: new Int32Array(w * h), sizes: [0], comps: new Map(), stack: new Int32Array(w * h) };
    contexts.set(key, c);
  }
  return c;
}

function isFlat(c, i) {
  const { w, h, rgb } = c;
  const x = i % w;
  const y = (i / w) | 0;
  if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return false;
  const o = i * 3;
  for (const j of [i - 1, i + 1, i - w, i + w]) {
    const oj = j * 3;
    if (Math.abs(rgb[o] - rgb[oj]) + Math.abs(rgb[o + 1] - rgb[oj + 1]) + Math.abs(rgb[o + 2] - rgb[oj + 2]) > STEP) return false;
  }
  return true;
}

// 4-neighbour of pixel i in direction k (0..3), or -1 outside the window.
function neighbour(i, k, w, h) {
  if (k === 0) return i % w === 0 ? -1 : i - 1;
  if (k === 1) return i % w === w - 1 ? -1 : i + 1;
  if (k === 2) return i < w ? -1 : i - w;
  return i >= w * (h - 1) ? -1 : i + w;
}

// Grows a surface from a seed pixel → its id.
function grow(c, seed) {
  const { w, h, surf, stack, rgb } = c;
  const id = c.sizes.length;
  const sr = rgb[seed * 3];
  const sg = rgb[seed * 3 + 1];
  const sb = rgb[seed * 3 + 2];
  let sp = 0;
  let n = 1;
  surf[seed] = id;
  stack[sp++] = seed;
  while (sp) {
    const i = stack[--sp];
    const o = i * 3;
    const r = rgb[o];
    const g = rgb[o + 1];
    const b = rgb[o + 2];
    for (let k = 0; k < 4; k++) {
      const j = neighbour(i, k, w, h);
      if (j < 0 || surf[j]) continue;
      const oj = j * 3;
      const r2 = rgb[oj];
      const g2 = rgb[oj + 1];
      const b2 = rgb[oj + 2];
      if (Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2) > STEP) continue;
      if (Math.abs(sr - r2) + Math.abs(sg - g2) + Math.abs(sb - b2) > RANGE) continue;
      surf[j] = id;
      stack[sp++] = j;
      n++;
    }
  }
  c.sizes.push(n);
  return id;
}

// The connected region of non-`sid` pixels around pixel p → { x0, y0, x1, y1, n, edge }.
// Regions that reach the window edge are no blocks: the search stops right there (breadth
// first, so that happens early), and a later search that runs into such a region stops too.
function component(c, sid, p) {
  const { w, h, surf, stack: queue } = c;
  let cm = c.comps.get(sid);
  if (!cm) {
    if (c.comps.size >= MAX_COMPS) c.comps.delete(c.comps.keys().next().value);
    cm = { map: new Uint16Array(w * h), info: [null] };
    c.comps.set(sid, cm);
  }
  if (cm.map[p]) return cm.info[cm.map[p]];
  if (cm.info.length >= 65535) {
    cm.map.fill(0);
    cm.info.length = 1;
  }
  const id = cm.info.length;
  const r = { x0: w, y0: h, x1: -1, y1: -1, n: 0, edge: false };
  cm.info.push(r);
  let head = 0;
  let tail = 0;
  cm.map[p] = id;
  queue[tail++] = p;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    r.n++;
    if (x < r.x0) r.x0 = x;
    if (x > r.x1) r.x1 = x;
    if (y < r.y0) r.y0 = y;
    if (y > r.y1) r.y1 = y;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
      r.edge = true;
      return r;
    }
    for (let k = 0; k < 4; k++) {
      const j = neighbour(i, k, w, h);
      if (j < 0 || surf[j] === sid) continue;
      const l = cm.map[j];
      if (l) {
        if (l !== id) {
          // Part of a region already known to reach the edge.
          r.edge = true;
          return r;
        }
        continue;
      }
      cm.map[j] = id;
      queue[tail++] = j;
    }
  }
  return r;
}

export function findBlocks(x, y, rect) {
  if (!px) return [];
  const c = context(rect);
  if (!c) return [];
  const lx = Math.floor(x) - c.x0;
  const ly = Math.floor(y) - c.y0;
  if (lx < 0 || ly < 0 || lx >= c.w || ly >= c.h) return [];
  const p = ly * c.w + lx;

  // Every surface that encloses the cursor is crossed by any ray from it to the window edge.
  // Four rays make it robust against thin spots where a surface is not flat enough to seed.
  const found = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    for (let qx = lx + dx, qy = ly + dy; qx >= 0 && qy >= 0 && qx < c.w && qy < c.h; qx += dx, qy += dy) {
      const q = qy * c.w + qx;
      let sid = c.surf[q];
      if (!sid && isFlat(c, q)) sid = grow(c, q);
      if (sid && c.sizes[sid] >= MIN_SURFACE && !found.includes(sid)) found.push(sid);
    }
  }

  const rects = [];
  const own = c.surf[p];
  for (const sid of found) {
    if (sid === own) continue; // the cursor is on this surface, not inside something on it
    const r = component(c, sid, p);
    if (r.edge) continue;
    const bw = r.x1 - r.x0 + 1;
    const bh = r.y1 - r.y0 + 1;
    if (bw < MIN_W || bh < MIN_H || bw * bh < MIN_AREA) continue;
    if (r.n / (bw * bh) < MIN_FILL) continue;
    if (bw * bh > c.w * c.h * 0.9) continue;
    const rr = { x: c.x0 + r.x0, y: c.y0 + r.y0, w: bw, h: bh };
    if (!rects.some((o) => Math.abs(o.x - rr.x) <= 2 && Math.abs(o.y - rr.y) <= 2 && Math.abs(o.w - rr.w) <= 4 && Math.abs(o.h - rr.h) <= 4)) rects.push(rr);
  }
  return rects.sort((a, b) => a.w * a.h - b.w * b.h);
}
