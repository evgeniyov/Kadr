// Full-screen selection overlay (one window per display, reused between sessions).
// Purposes: area | return | ocr (instant selection on mouse-up), window (click a window),
// record | scroll (adjustable selection + confirm), color (eyedropper).
import { initPage, kadr, t, $ } from '../../shared/ui.js';

const { params } = await initPage();

const layer = $('#layer');
const g = layer.getContext('2d');
const frozen = $('#frozen');
const loupe = $('#loupe');
const loupeCanvas = $('#loupe-canvas');
const lg = loupeCanvas.getContext('2d');
const sizeLabel = $('#size');
const windowLabel = $('#window-label');
const hint = $('#hint');
const confirmBar = $('#confirm');

const HANDLE = 7;
const LOUPE_PIXELS = 11; // odd → there is a center pixel

let cfg = null; // payload of overlay:start
let pixels = null; // offscreen canvas with the frozen image (for colours / loupe)
let pctx = null;
let mode = 'area'; // area | window | color
let adjustable = false;
let sel = null; // {x,y,w,h} in CSS px (= DIP, relative to this display)
let drag = null; // { kind: 'new'|'move'|handle, sx, sy, orig }
let mouse = null; // {x,y}
let hoverWin = null;
// Blocks inside the hovered window (a post, a card, a picture…), smallest first, found by
// blocks-worker.js from the frozen image. `level` picks one of them or the whole window
// (wheel, ↑/↓); `preferred` keeps that choice while the cursor stays on it.
let blocks = [];
let level = 0;
let preferred = null;
let blockWorker = null;
let blockBusy = false;
let blockAgain = false;
let wheelAcc = 0;
let wheelLock = 0;
let raf = 0;
let hintTimer = 0;

if (params.countdown) runCountdown(params.countdown);

kadr.on('overlay:start', (c) => start(c));
kadr.on('overlay:reset', () => reset());

function reset() {
  cfg = null;
  sel = null;
  drag = null;
  hoverWin = null;
  stopBlocks();
  preferred = null;
  pixels = null;
  pctx = null;
  frozen.removeAttribute('src');
  frozen.classList.add('hidden');
  loupe.classList.add('hidden');
  sizeLabel.classList.add('hidden');
  windowLabel.classList.add('hidden');
  confirmBar.classList.add('hidden');
  hint.classList.add('hidden');
  // This window stays alive between captures: give back the full-screen canvas and the
  // decoded screenshot (tens of MB on Retina) until the next session.
  layer.width = layer.height = 1;
  kadr.clearCache?.();
}

async function start(c) {
  reset();
  cfg = c;
  resizeCanvas();
  mode = c.purpose === 'color' ? 'color' : c.windowMode ? 'window' : 'area';
  adjustable = c.purpose === 'record' || c.purpose === 'scroll';
  mouse = c.cursor && c.cursor.x >= 0 && c.cursor.y >= 0 && c.cursor.x <= innerWidth && c.cursor.y <= innerHeight ? { ...c.cursor } : null;
  document.body.classList.toggle('window-mode', mode === 'window');

  if (c.imageUrl) await loadFrozen(c.imageUrl);
  if (cfg !== c) return;
  $('#btn-last').classList.toggle('hidden', !(c.lastRegion && String(c.lastRegion.displayId) === String(c.displayId)));
  $('#btn-full').classList.toggle('hidden', c.purpose !== 'record');
  showHint();
  updateHover();
  render();
  kadr.invoke('overlay:ready');
}

async function loadFrozen(url) {
  const token = cfg;
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    console.error('frozen image failed', e);
    return;
  }
  if (cfg !== token) return; // session ended meanwhile
  frozen.src = url;
  frozen.classList.remove('hidden');
  // Reused hidden overlays don't get animation frames until they're shown.
  pixels = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  pctx = pixels.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0);
  startBlocks(img);
}

// ---- blocks inside windows ---------------------------------------------------------

function startBlocks(img) {
  if (cfg?.blocks === false || cfg?.purpose === 'color') return;
  const token = cfg;
  // Analysed at CSS-pixel size: 4× less work on Retina, and results are in CSS px anyway.
  createImageBitmap(img, { resizeWidth: Math.round(innerWidth), resizeHeight: Math.round(innerHeight), resizeQuality: 'medium' })
    .then((bitmap) => {
      if (cfg !== token) return bitmap.close();
      stopBlocks();
      blockWorker = new Worker(new URL('./blocks-worker.js', import.meta.url), { type: 'module' });
      blockWorker.onmessage = (e) => onBlocks(e.data);
      blockWorker.postMessage({ type: 'image', bitmap }, [bitmap]);
      requestBlocks();
    })
    .catch((e) => console.warn('blocks: no image', e));
}

// The worker holds a copy of the screen: it goes away with the session.
function stopBlocks() {
  blockWorker?.terminate();
  blockWorker = null;
  blockBusy = false;
  blockAgain = false;
  blocks = [];
  level = 0;
}

const blocksAllowed = () => !!cfg && mode === 'area' && cfg.purpose !== 'color' && !sel && !drag;
const inside = (p, r) => !!p && p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const sameRect = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= 4 && Math.abs(a.h - b.h) <= 4;

function requestBlocks() {
  if (!blockWorker || !hoverWin || !mouse || !blocksAllowed()) return;
  // One query at a time; the latest cursor position is sent when it returns.
  if (blockBusy) {
    blockAgain = true;
    return;
  }
  blockBusy = true;
  blockWorker.postMessage({ type: 'query', x: mouse.x, y: mouse.y, rect: winRectClipped(hoverWin) });
}

function onBlocks(m) {
  blockBusy = false;
  if (!cfg) return;
  if (blockAgain) {
    blockAgain = false;
    requestBlocks();
  }
  if (!blocksAllowed() || !hoverWin || !sameRect(m.rect, winRectClipped(hoverWin))) return;
  // Found for a slightly older cursor position: they count while they contain the cursor.
  setBlocks(m.rects.filter((b) => inside(mouse, b)));
  render();
}

function setBlocks(list) {
  blocks = list;
  const all = targets();
  const i = preferred ? all.findIndex((r) => sameRect(r, preferred)) : -1;
  level = i >= 0 ? i : 0;
}

// What a click takes: blocks under the cursor (smallest first), then the whole window.
function targets() {
  return hoverWin ? [...blocks, wholeWindowRect(hoverWin)] : [];
}

function target() {
  const all = targets();
  if (!all.length) return null;
  const i = Math.min(level, all.length - 1);
  return { rect: all[i], block: i < blocks.length };
}

function stepLevel(d) {
  const all = targets();
  const next = Math.max(0, Math.min(all.length - 1, level + d));
  if (next === level) return;
  level = next;
  preferred = all[level];
  render();
}

function showHint() {
  const key = {
    color: 'overlay.hintColor',
    ocr: 'overlay.hintOcr',
    record: 'overlay.hintRecord',
    scroll: 'overlay.hintScroll',
  }[cfg.purpose] || (mode === 'window' ? 'overlay.hintWindow' : 'overlay.hintArea');
  hint.textContent = t(key);
  hint.classList.remove('hidden', 'fade');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add('fade'), 2600);
}

function resizeCanvas() {
  const dpr = devicePixelRatio || 1;
  layer.width = Math.round(innerWidth * dpr);
  layer.height = Math.round(innerHeight * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', () => {
  if (!cfg) return;
  resizeCanvas();
  render();
});

// ---- geometry --------------------------------------------------------------

const pxScale = () => (cfg?.pixelWidth ? cfg.pixelWidth / cfg.bounds.width : cfg?.scaleFactor || devicePixelRatio || 1);

function norm(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function clampSel(s) {
  const W = innerWidth;
  const H = innerHeight;
  const x = Math.max(0, Math.min(s.x, W - 1));
  const y = Math.max(0, Math.min(s.y, H - 1));
  return { x, y, w: Math.max(1, Math.min(s.w, W - x)), h: Math.max(1, Math.min(s.h, H - y)) };
}

function windowAt(p) {
  if (!cfg?.windows || !p) return null;
  return cfg.windows.find((w) => p.x >= w.rect.x && p.y >= w.rect.y && p.x < w.rect.x + w.rect.width && p.y < w.rect.y + w.rect.height) || null;
}

function winRectClipped(w) {
  const r = w.rect;
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, w: Math.min(r.x + r.width, innerWidth) - x, h: Math.min(r.y + r.height, innerHeight) - y };
}

function wholeWindowRect(win) {
  const r = win.captureRect;
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : winRectClipped(win);
}

function handles(s) {
  const { x, y, w, h } = s;
  return {
    nw: [x, y],
    n: [x + w / 2, y],
    ne: [x + w, y],
    e: [x + w, y + h / 2],
    se: [x + w, y + h],
    s: [x + w / 2, y + h],
    sw: [x, y + h],
    w: [x, y + h / 2],
  };
}

function hitHandle(p) {
  if (!sel || !adjustable) return null;
  for (const [k, [hx, hy]] of Object.entries(handles(sel))) if (Math.abs(p.x - hx) <= HANDLE + 3 && Math.abs(p.y - hy) <= HANDLE + 3) return k;
  if (p.x > sel.x && p.y > sel.y && p.x < sel.x + sel.w && p.y < sel.y + sel.h) return 'move';
  return null;
}

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

// ---- pixels ------------------------------------------------------------------

function colorAt(p) {
  if (!pctx || !p) return null;
  const s = pxScale();
  const x = Math.min(pixels.width - 1, Math.max(0, Math.floor(p.x * s)));
  const y = Math.min(pixels.height - 1, Math.max(0, Math.floor(p.y * s)));
  const d = pctx.getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], x, y };
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

export function formatColor({ r, g: gg, b }, fmt) {
  const hex = `#${hex2(r)}${hex2(gg)}${hex2(b)}`;
  const f = (v) => +(v / 255).toFixed(3);
  switch (fmt) {
    case 'HEX':
      return hex.toUpperCase();
    case 'rgb':
      return `rgb(${r}, ${gg}, ${b})`;
    case 'css-rgba':
      return `rgba(${r}, ${gg}, ${b}, 1)`;
    case 'hsl': {
      const [h, s, l] = rgbToHsl(r, gg, b);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    case 'swiftui':
      return `Color(red: ${f(r)}, green: ${f(gg)}, blue: ${f(b)})`;
    case 'uicolor':
      return `UIColor(red: ${f(r)}, green: ${f(gg)}, blue: ${f(b)}, alpha: 1.0)`;
    case 'android':
      return `0xFF${hex.slice(1).toUpperCase()}`;
    case 'csharp':
      return `Color.FromArgb(${r}, ${gg}, ${b})`;
    case 'flutter':
      return `Color(0xFF${hex.slice(1).toUpperCase()})`;
    default:
      return hex;
  }
}

function rgbToHsl(r, g2, b) {
  r /= 255;
  g2 /= 255;
  b /= 255;
  const max = Math.max(r, g2, b);
  const min = Math.min(r, g2, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g2 - b) / d + (g2 < b ? 6 : 0);
    else if (max === g2) h = (b - r) / d + 2;
    else h = (r - g2) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

// ---- rendering -----------------------------------------------------------------

function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(draw);
}

function draw() {
  if (!cfg) return;
  const W = innerWidth;
  const H = innerHeight;
  g.clearRect(0, 0, W, H);

  // Same dim for the live screen and the frozen image, so the swap is invisible.
  const dim = 'rgba(0,0,0,0.32)';
  const tgt = !sel && (mode === 'window' || (!drag && cfg.purpose !== 'color')) ? target() : null;
  const focus = sel || tgt?.rect || null;

  if (mode !== 'color') {
    g.fillStyle = dim;
    g.fillRect(0, 0, W, H);
    if (focus) g.clearRect(focus.x, focus.y, focus.w, focus.h);
  }

  if (sel) {
    g.save();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    g.setLineDash([4, 4]);
    g.strokeStyle = 'rgba(10,132,255,0.95)';
    g.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    g.restore();
    if (adjustable && !drag) {
      for (const [hx, hy] of Object.values(handles(sel))) {
        g.beginPath();
        g.arc(hx, hy, HANDLE / 1.4, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = 'rgba(10,132,255,1)';
        g.stroke();
      }
    }
  } else if (focus && hoverWin) {
    g.save();
    g.fillStyle = 'rgba(10,132,255,0.12)';
    g.fillRect(focus.x, focus.y, focus.w, focus.h);
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(10,132,255,0.9)';
    g.strokeRect(focus.x + 1.5, focus.y + 1.5, focus.w - 3, focus.h - 3);
    g.restore();
  }

  // Crosshair guides while choosing a starting point.
  if (mouse && !sel && !drag && mode === 'area') {
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(0, Math.round(mouse.y) + 0.5);
    g.lineTo(W, Math.round(mouse.y) + 0.5);
    g.moveTo(Math.round(mouse.x) + 0.5, 0);
    g.lineTo(Math.round(mouse.x) + 0.5, H);
    g.stroke();
    g.restore();
  }

  drawLabels(focus, tgt);
  drawLoupe();
  placeConfirm();
}

function drawLabels(focus, tgt) {
  const s = pxScale();
  const r = sel;
  if (r && r.w > 0) {
    sizeLabel.textContent = `${Math.round(r.w * s)} × ${Math.round(r.h * s)}`;
    sizeLabel.classList.remove('hidden');
    const ly = r.y > 26 ? r.y - 24 : r.y + r.h + 6;
    sizeLabel.style.left = `${Math.max(4, Math.min(innerWidth - 110, r.x))}px`;
    sizeLabel.style.top = `${Math.min(innerHeight - 22, ly)}px`;
  } else sizeLabel.classList.add('hidden');

  if (!sel && hoverWin && tgt && focus) {
    const s2 = pxScale();
    const name = tgt.block ? t('overlay.block') : [hoverWin.appName, hoverWin.title].filter(Boolean).join(' — ');
    const size = `${Math.round(tgt.rect.w * s2)} × ${Math.round(tgt.rect.h * s2)}`;
    const more = targets().length > 1 ? ` · ${t('overlay.levels')}` : '';
    windowLabel.textContent = `${name ? `${name} · ` : ''}${size}${more}`;
    windowLabel.classList.remove('hidden');
    // A block's label goes just above it, so it doesn't cover what is being picked.
    const above = tgt.block && focus.y >= 32;
    windowLabel.style.left = `${Math.max(6, above ? focus.x : focus.x + 8)}px`;
    windowLabel.style.top = `${above ? focus.y - 28 : Math.max(6, focus.y + 8)}px`;
  } else windowLabel.classList.add('hidden');
}

function drawLoupe() {
  if (!mouse || !pctx || (drag && drag.kind !== 'new') || (adjustable && sel && !drag)) {
    loupe.classList.add('hidden');
    return;
  }
  const s = pxScale();
  const cx = Math.floor(mouse.x * s);
  const cy = Math.floor(mouse.y * s);
  const half = (LOUPE_PIXELS - 1) / 2;
  const cell = loupeCanvas.width / LOUPE_PIXELS;
  lg.imageSmoothingEnabled = false;
  lg.fillStyle = '#000';
  lg.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height);
  lg.drawImage(pixels, cx - half, cy - half, LOUPE_PIXELS, LOUPE_PIXELS, 0, 0, loupeCanvas.width, loupeCanvas.height);
  // grid
  lg.strokeStyle = 'rgba(255,255,255,0.08)';
  lg.lineWidth = 1;
  for (let i = 1; i < LOUPE_PIXELS; i++) {
    const p = Math.round(i * cell) + 0.5;
    lg.beginPath();
    lg.moveTo(p, 0);
    lg.lineTo(p, loupeCanvas.height);
    lg.moveTo(0, p);
    lg.lineTo(loupeCanvas.width, p);
    lg.stroke();
  }
  // center pixel
  lg.strokeStyle = '#fff';
  lg.lineWidth = 1.5;
  lg.strokeRect(half * cell, half * cell, cell, cell);
  lg.strokeStyle = 'rgba(0,0,0,0.8)';
  lg.lineWidth = 1;
  lg.strokeRect(half * cell - 1.5, half * cell - 1.5, cell + 3, cell + 3);

  const c = colorAt(mouse);
  if (c) {
    const hex = formatColor(c, 'HEX');
    $('#loupe-color i').style.background = hex;
    $('#loupe-color b').textContent = hex;
  }
  $('#loupe-pos').textContent = `${cx}, ${cy}`;

  let lx = mouse.x + 22;
  let ly = mouse.y + 22;
  if (lx + 140 > innerWidth) lx = mouse.x - 22 - 132;
  if (ly + 170 > innerHeight) ly = mouse.y - 22 - 160;
  loupe.style.left = `${lx}px`;
  loupe.style.top = `${ly}px`;
  loupe.classList.remove('hidden');
}

function placeConfirm() {
  if (!adjustable || !sel || drag) {
    confirmBar.classList.add('hidden');
    return;
  }
  const s = pxScale();
  $('#confirm-size').textContent = `${Math.round(sel.w * s)} × ${Math.round(sel.h * s)}`;
  confirmBar.classList.remove('hidden');
  const bw = confirmBar.offsetWidth;
  const bh = confirmBar.offsetHeight;
  let x = sel.x + sel.w - bw;
  let y = sel.y + sel.h + 10;
  if (y + bh > innerHeight - 8) y = sel.y - bh - 10;
  if (y < 8) y = sel.y + sel.h - bh - 10;
  x = Math.max(8, Math.min(innerWidth - bw - 8, x));
  confirmBar.style.left = `${x}px`;
  confirmBar.style.top = `${y}px`;
}

// ---- interaction --------------------------------------------------------------------

function updateHover() {
  const canWindows = mode === 'window' || (mode === 'area' && cfg?.purpose !== 'color');
  const prev = hoverWin;
  hoverWin = canWindows && !sel ? windowAt(mouse) : null;
  if (hoverWin !== prev || !blocksAllowed()) setBlocks([]);
  // Until the worker answers, keep what is still under the cursor.
  else if (blocks.some((b) => !inside(mouse, b))) setBlocks(blocks.filter((b) => inside(mouse, b)));
  requestBlocks();
}

// Takes the highlighted block or window (a click, Enter).
function pickTarget() {
  const tgt = target();
  if (!tgt) return false;
  if (adjustable) {
    sel = { ...tgt.rect };
    return false;
  }
  if (tgt.block) finish({ rect: roundRect(tgt.rect) });
  else finish({ windowId: hoverWin.id, rect: roundRect(tgt.rect) });
  return true;
}

function finish(result) {
  const payload = { displayId: cfg.displayId, ...result };
  cfg = null;
  loupe.classList.add('hidden');
  kadr.invoke('overlay:done', payload);
}

function cancel() {
  cfg = null;
  kadr.invoke('overlay:cancel');
}

function finishSelection(s) {
  const r = clampSel(s);
  finish({ rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) } });
}

layer.addEventListener('pointerdown', (e) => {
  if (!cfg || e.button !== 0) return;
  const p = { x: e.clientX, y: e.clientY };
  mouse = p;
  if (mode === 'color') {
    const c = colorAt(p);
    if (c) {
      const text = formatColor(c, cfg.colorFormat);
      if (e.shiftKey) {
        kadr.invoke('overlay:copy-color', text);
        hint.textContent = `${t('overlay.copied')}: ${text}`;
        hint.classList.remove('hidden', 'fade');
      } else finish({ color: text });
    }
    return;
  }
  if (mode === 'window') {
    const w = windowAt(p);
    if (w) {
      if (adjustable) {
        sel = winRectClipped(w);
        render();
      } else finish({ windowId: w.id, rect: roundRect(wholeWindowRect(w)) });
    }
    return;
  }
  const h = hitHandle(p);
  layer.setPointerCapture(e.pointerId);
  if (h) drag = { kind: h, sx: p.x, sy: p.y, orig: { ...sel } };
  else {
    drag = { kind: 'new', sx: p.x, sy: p.y };
    sel = null;
  }
  render();
});

layer.addEventListener('pointermove', (e) => {
  if (!cfg) return;
  const p = { x: e.clientX, y: e.clientY };
  mouse = p;
  if (drag) {
    if (drag.kind === 'new') {
      let x2 = p.x;
      let y2 = p.y;
      if (e.shiftKey) {
        const d = Math.max(Math.abs(x2 - drag.sx), Math.abs(y2 - drag.sy));
        x2 = drag.sx + Math.sign(x2 - drag.sx || 1) * d;
        y2 = drag.sy + Math.sign(y2 - drag.sy || 1) * d;
      }
      sel = norm(drag.sx, drag.sy, Math.max(0, Math.min(innerWidth, x2)), Math.max(0, Math.min(innerHeight, y2)));
    } else {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      const o = drag.orig;
      let { x, y, w, h } = o;
      if (drag.kind === 'move') {
        x = Math.max(0, Math.min(innerWidth - w, o.x + dx));
        y = Math.max(0, Math.min(innerHeight - h, o.y + dy));
      } else {
        let x1 = o.x;
        let y1 = o.y;
        let x2 = o.x + o.w;
        let y2 = o.y + o.h;
        if (drag.kind.includes('w')) x1 += dx;
        if (drag.kind.includes('e')) x2 += dx;
        if (drag.kind.includes('n')) y1 += dy;
        if (drag.kind.includes('s')) y2 += dy;
        ({ x, y, w, h } = norm(x1, y1, x2, y2));
      }
      sel = clampSel({ x, y, w, h });
    }
  } else {
    const h = hitHandle(p);
    layer.style.cursor = h ? CURSORS[h] : mode === 'window' ? 'default' : 'crosshair';
    updateHover();
  }
  render();
});

layer.addEventListener('pointerup', (e) => {
  if (!cfg || !drag) return;
  const wasNew = drag.kind === 'new';
  drag = null;
  const tiny = !sel || (sel.w < 4 && sel.h < 4);
  if (wasNew && tiny) {
    // A click: take the highlighted block or window under the cursor.
    sel = null;
    mouse = { x: e.clientX, y: e.clientY };
    if (hoverWin !== windowAt(mouse)) updateHover();
    if (pickTarget()) return;
    updateHover();
    render();
    return;
  }
  if (!adjustable && sel) return finishSelection(sel);
  render();
});

layer.addEventListener('pointerleave', () => {
  if (drag) return;
  mouse = null;
  hoverWin = mode === 'window' ? null : hoverWin;
  render();
});

// Wheel: bigger / smaller block. Trackpad momentum would skip several levels, so one step
// needs some distance and the next one waits a little.
layer.addEventListener(
  'wheel',
  (e) => {
    if (!cfg || sel || drag || targets().length < 2) return;
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLock) return;
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(wheelAcc) < 24) return;
    stepLevel(wheelAcc < 0 ? 1 : -1);
    wheelAcc = 0;
    wheelLock = now + 160;
  },
  { passive: false },
);

layer.addEventListener('dblclick', () => {
  if (adjustable && sel) finishSelection(sel);
});

function roundRect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) };
}

addEventListener('keydown', (e) => {
  if (!cfg) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    return cancel();
  }
  if (e.key === ' ' && (cfg.purpose === 'area' || cfg.purpose === 'return' || cfg.purpose === 'ocr')) {
    e.preventDefault();
    mode = mode === 'window' ? 'area' : 'window';
    document.body.classList.toggle('window-mode', mode === 'window');
    sel = null;
    drag = null;
    showHint();
    updateHover();
    render();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (adjustable) {
      if (sel) finishSelection(sel);
      else if (cfg.purpose === 'record') finishSelection({ x: 0, y: 0, w: innerWidth, h: innerHeight });
    } else pickTarget();
    return;
  }
  // Blocks: ↑ — the enclosing one (up to the whole window), ↓ — back to smaller ones.
  if (!sel && !drag && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && targets().length > 1) {
    e.preventDefault();
    stepLevel(e.key === 'ArrowUp' ? 1 : -1);
    return;
  }
  if (adjustable && sel && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.altKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (e.shiftKey) sel = clampSel({ ...sel, w: Math.max(4, sel.w + d[0]), h: Math.max(4, sel.h + d[1]) });
    else sel = clampSel({ ...sel, x: sel.x + d[0], y: sel.y + d[1] });
    render();
  }
});

$('#btn-ok').addEventListener('click', () => sel && finishSelection(sel));
$('#btn-cancel').addEventListener('click', () => cancel());
$('#btn-full').addEventListener('click', () => finishSelection({ x: 0, y: 0, w: innerWidth, h: innerHeight }));
$('#btn-last').addEventListener('click', () => {
  const r = cfg?.lastRegion;
  if (!r) return;
  sel = clampSel({ x: r.x, y: r.y, w: r.width, h: r.height });
  render();
});

// ---- delayed-capture countdown (separate small window) ------------------------------
function runCountdown(n) {
  const box = $('#countdown');
  const span = box.querySelector('span');
  box.classList.remove('hidden');
  document.body.style.cursor = 'default';
  let left = n;
  span.textContent = left;
  const iv = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(iv);
      box.classList.add('hidden');
      return;
    }
    span.textContent = left;
  }, 1000);
}
