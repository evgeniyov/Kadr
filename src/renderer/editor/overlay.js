// Screen-space overlay: hover outline, selection box and handles, conceal OCR state, tool overlay.
import { typeOf } from './objects/index.js';
import { rectKey } from './geom.js';

const ACCENT = '#0A84FF';
const RECT_TYPES = new Set(['rect', 'oval', 'conceal', 'spotlight', 'image']);
const SEGMENT_TYPES = new Set(['arrow', 'line', 'ruler']);

function screenRect(app, b) {
  const [x0, y0] = app.toScreen(b.x, b.y);
  const [x1, y1] = app.toScreen(b.x + b.w, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function drawHandle(g, x, y, kind) {
  g.beginPath();
  if (kind === 'mid') {
    g.arc(x, y, 4.5, 0, Math.PI * 2);
    g.fillStyle = ACCENT;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = '#fff';
    g.stroke();
    return;
  }
  g.arc(x, y, 5, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = ACCENT;
  g.stroke();
}

export function drawOverlay(app, g) {
  const env = app.objectEnv();
  const editing = app.textEditor?.obj?.id;
  const busy = app.tool?.busy;

  if (app.hoverId && app.hoverId !== app.selectedId && !busy) {
    const o = app.doc.get(app.hoverId);
    if (o) {
      const r = screenRect(app, typeOf(o).bounds(o, env));
      g.strokeStyle = 'rgba(10, 132, 255, 0.55)';
      g.lineWidth = 1;
      g.setLineDash([]);
      g.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
    }
  }

  const o = app.selected;
  if (o && o.id !== editing) {
    const T = typeOf(o);
    if (!SEGMENT_TYPES.has(o.type)) {
      const b = RECT_TYPES.has(o.type) ? { x: o.x, y: o.y, w: o.w, h: o.h } : T.bounds(o, env);
      const r = screenRect(app, b);
      g.lineWidth = 1;
      g.strokeStyle = ACCENT;
      g.setLineDash(RECT_TYPES.has(o.type) ? [] : [4, 3]);
      g.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      g.setLineDash([]);
    }
    if (o.type === 'conceal' && o.textOnly && o.ocrKey !== rectKey(o)) {
      const [x, y] = app.toScreen(o.x + o.w / 2, o.y + o.h / 2);
      g.fillStyle = 'rgba(20,20,22,0.8)';
      g.beginPath();
      g.roundRect(x - 14, y - 9, 28, 18, 9);
      g.fill();
      g.fillStyle = '#fff';
      const phase = Math.floor(performance.now() / 250) % 3;
      for (let i = 0; i < 3; i++) {
        g.globalAlpha = i === phase ? 1 : 0.4;
        g.beginPath();
        g.arc(x - 7 + i * 7, y, 2, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      requestAnimationFrame(() => app.invalidate(false));
    }
    if (!busy || app.tool?.drag?.kind === 'handle') {
      for (const h of T.handles?.(o, env) || []) {
        const [x, y] = app.toScreen(h.x, h.y);
        drawHandle(g, x, y, h.kind);
      }
    }
  }

  app.pixelSelection?.drawAnts(g);
  app.tool?.drawOverlay?.(g);
}
