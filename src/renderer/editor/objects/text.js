// Text (plain / outlined / box) and numbered counters.
import { sizePx } from './common.js';
import { FONT_FAMILY } from '../consts.js';
import { contrastColor } from '../color.js';
import { roundRectPath, pointInRect, dist, union } from '../geom.js';

export const LINE_HEIGHT = 1.25;
const measureCtx = new OffscreenCanvas(4, 4).getContext('2d');

export const textFont = (px, weight = 600) => `${weight} ${px}px ${FONT_FAMILY}`;

export function measure(text, px, weight = 600) {
  measureCtx.font = textFont(px, weight);
  return measureCtx.measureText(text).width;
}

function padding(style, fs) {
  if (style === 'box') return { x: fs * 0.45, y: fs * 0.22 };
  if (style === 'outline') return { x: fs * 0.12, y: fs * 0.08 };
  return { x: fs * 0.04, y: 0 };
}

export function layoutText(o) {
  const fs = o.fontSize * (o.k || 1);
  const lh = fs * LINE_HEIGHT;
  const lines = String(o.text ?? '').split('\n');
  const widths = lines.map((l) => measure(l, fs, o.weight || 600));
  const tw = Math.max(fs * 0.35, ...widths);
  const pad = padding(o.style, fs);
  return { fs, lh, lines, widths, padX: pad.x, padY: pad.y, w: tw + pad.x * 2, h: lines.length * lh + pad.y * 2 };
}

function drawLines(ctx, lines, x, y, lh, fill, outline, outlineW) {
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    const ty = y + (i + 0.5) * lh;
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = outlineW;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, x, ty);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, x, ty);
  });
}

export const text = {
  props: ['color', 'size', 'opacity', 'textStyle', 'shadow'],
  layered: true,

  create(p, x, y) {
    return { x, y, text: '', fontSize: p.fontSize || 16, style: p.textStyle || 'outline' };
  },
  isEmpty(o) {
    return !String(o.text || '').trim();
  },
  draw(ctx, o) {
    const L = layoutText(o);
    ctx.font = textFont(L.fs, o.weight || 600);
    let fill = o.color;
    let outline = null;
    if (o.style === 'box') {
      roundRectPath(ctx, o.x, o.y, L.w, L.h, L.fs * 0.28);
      ctx.fillStyle = o.color;
      ctx.fill();
      fill = contrastColor(o.color);
    } else if (o.style === 'outline') {
      outline = contrastColor(o.color);
    }
    drawLines(ctx, L.lines, o.x + L.padX, o.y + L.padY, L.lh, fill, outline, L.fs * 0.2);
  },
  bounds(o) {
    const L = layoutText(o);
    return { x: o.x, y: o.y, w: L.w, h: L.h };
  },
  hit(o, x, y, tol) {
    return pointInRect(x, y, this.bounds(o), tol) ? 'fill' : null;
  },
  handles(o) {
    const b = this.bounds(o);
    return [
      { id: 'nw', x: b.x, y: b.y },
      { id: 'ne', x: b.x + b.w, y: b.y },
      { id: 'se', x: b.x + b.w, y: b.y + b.h },
      { id: 'sw', x: b.x, y: b.y + b.h },
    ];
  },
  // Corner handles scale the font size, keeping the opposite corner in place.
  setHandle(o, id, x, y, mods, orig) {
    const b = this.bounds(orig);
    const ax = id.includes('w') ? b.x + b.w : b.x;
    const ay = id.includes('n') ? b.y + b.h : b.y;
    const f = Math.max(Math.abs(x - ax) / (b.w || 1), Math.abs(y - ay) / (b.h || 1));
    o.fontSize = Math.max(6, Math.min(400, orig.fontSize * f));
    const nb = this.bounds(o);
    o.x = id.includes('w') ? ax - nb.w : ax;
    o.y = id.includes('n') ? ay - nb.h : ay;
  },
  translate(o, dx, dy) {
    o.x += dx;
    o.y += dy;
  },
  transform(o, map, s) {
    const b = this.bounds(o);
    const [cx, cy] = map(b.x + b.w / 2, b.y + b.h / 2);
    o.x = cx - (b.w * s) / 2;
    o.y = cy - (b.h * s) / 2;
  },
};

// ---- Counter ---------------------------------------------------------------

export function counterGeometry(o, n) {
  const R = sizePx(o, 'counter');
  const label = String(o.label || '');
  const numFs = R * (String(n).length > 2 ? 0.8 : String(n).length > 1 ? 0.95 : 1.12);
  let pill = null;
  if (label) {
    const fs = R * 0.95;
    const lines = label.split('\n');
    const w = Math.max(...lines.map((l) => measure(l, fs))) + fs * 0.9;
    const h = lines.length * fs * LINE_HEIGHT + fs * 0.44;
    pill = { x: o.x + R * 1.25, y: o.y - h / 2, w, h, fs, lines };
  }
  return { R, numFs, pill };
}

export const counter = {
  props: ['color', 'size', 'opacity', 'shadow'],
  layered: true,

  create(p, x, y) {
    return { x, y, label: '' };
  },
  isEmpty() {
    return false;
  },
  draw(ctx, o, env) {
    const n = env?.counterNumber ? env.counterNumber(o) : 1;
    const g = counterGeometry(o, n);
    const fg = contrastColor(o.color);
    if (g.pill) {
      const p = g.pill;
      roundRectPath(ctx, p.x - g.R * 0.6, p.y, p.w + g.R * 0.6, p.h, Math.min(p.h / 2, p.fs * 0.5));
      ctx.fillStyle = o.color;
      ctx.fill();
      ctx.font = textFont(p.fs, 600);
      drawLines(ctx, p.lines, p.x + p.fs * 0.45, p.y + p.fs * 0.22, p.fs * LINE_HEIGHT, fg, null, 0);
    }
    ctx.beginPath();
    ctx.arc(o.x, o.y, g.R, 0, Math.PI * 2);
    ctx.fillStyle = o.color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, g.R * 0.12);
    ctx.strokeStyle = fg;
    ctx.globalAlpha *= 0.9;
    ctx.beginPath();
    ctx.arc(o.x, o.y, g.R - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha /= 0.9;
    ctx.font = textFont(g.numFs, 700);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), o.x, o.y + g.numFs * 0.04);
    ctx.textAlign = 'left';
  },
  bounds(o, env) {
    const g = counterGeometry(o, env?.counterNumber ? env.counterNumber(o) : 1);
    const circle = { x: o.x - g.R, y: o.y - g.R, w: g.R * 2, h: g.R * 2 };
    return g.pill ? union(circle, g.pill) : circle;
  },
  hit(o, x, y, tol, env) {
    const g = counterGeometry(o, 1);
    if (dist(x, y, o.x, o.y) <= g.R + tol) return 'fill';
    return g.pill && pointInRect(x, y, g.pill, tol) ? 'fill' : null;
  },
  handles() {
    return [];
  },
  translate(o, dx, dy) {
    o.x += dx;
    o.y += dy;
  },
  transform(o, map) {
    [o.x, o.y] = map(o.x, o.y);
  },
};
