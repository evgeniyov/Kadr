// "Translate the image" (like Google Lens / Yandex photo translation): recognise every
// text line, translate paragraph by paragraph, erase the original lines with the
// surrounding background and write the translation in their place. Everything is added
// as ordinary editor objects (smart-erase + text), so it stays editable and one ⌘Z undoes it.
import { t, kadr, toast } from '../../shared/ui.js';
import { measure, LINE_HEIGHT } from './objects/text.js';
import { dominantBorderColor } from './objects/effects.js';

const sameLine = (a, b) => Math.abs(a.h - b.h) / Math.max(a.h, b.h) < 0.35;

// Group OCR lines into paragraph segments: a line continues the previous one when it sits
// right below it (similar height, left-aligned or overlapping) and the text reads on
// (no sentence end before, lowercase start). Stacked UI labels stay separate.
export function groupLines(lines) {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const segments = [];
  for (const line of sorted) {
    const seg = segments.find((s) => {
      const last = s.lines[s.lines.length - 1];
      const gap = line.y - (last.y + last.h);
      const overlapX = Math.min(last.x + last.w, line.x + line.w) - Math.max(last.x, line.x);
      const aligned = Math.abs(line.x - s.lines[0].x) < last.h * 1.5 || overlapX > Math.min(last.w, line.w) * 0.3;
      const readsOn = !/[.!?:;…»"”)]$/.test(last.text.trim()) && /^[a-zа-яё(«"“]/.test(line.text.trim());
      return gap > -last.h * 0.3 && gap < last.h * 0.9 && sameLine(last, line) && aligned && readsOn;
    });
    if (seg) seg.lines.push(line);
    else segments.push({ lines: [line] });
  }
  for (const s of segments) {
    s.text = s.lines.reduce((acc, l) => (acc.endsWith('-') ? acc.slice(0, -1) + l.text.trim() : acc ? `${acc} ${l.text.trim()}` : l.text.trim()), '');
    const xs = s.lines.map((l) => l.x);
    const ys = s.lines.map((l) => l.y);
    s.x = Math.min(...xs);
    s.y = Math.min(...ys);
    s.w = Math.max(...s.lines.map((l) => l.x + l.w)) - s.x;
    s.h = Math.max(...s.lines.map((l) => l.y + l.h)) - s.y;
    s.lineH = s.lines.reduce((a, l) => a + l.h, 0) / s.lines.length;
  }
  return segments;
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
// '#rrggbb' or 'rgb(r, g, b)' → [r, g, b]
const parseColor = (c) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? [+m[1], +m[2], +m[3]] : [1, 3, 5].map((i) => { const n = parseInt(String(c).slice(i, i + 2), 16); return Number.isFinite(n) ? n : 255; });
};

// The text colour of a line (pixels clearly different from the background, averaged) and
// how much of the line is ink — thick strokes mean bold text.
function inkOf(pixels, box, bg) {
  const [br, bgG, bb] = parseColor(bg);
  const { data } = pixels.getContext('2d').getImageData(box.x, box.y, box.w, box.h);
  let max = 0;
  const dist = new Float32Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb);
    dist[j] = d;
    if (d > max) max = d;
  }
  if (max < 60) return { color: (br * 299 + bgG * 587 + bb * 114) / 1000 > 140 ? '#111111' : '#ffffff', density: 0.15 };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    if (dist[j] < max * 0.6) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return { color: n ? hex(r / n, g / n, b / n) : '#111111', density: n / dist.length };
}

// Free background beside a line (px), to the right (dir 1) or left (dir -1): the translation
// may grow into it. Stops at the first column that differs from the background (a button
// edge, other text, …).
function freeSide(pixels, box, bg, limit, dir) {
  const [br, bgG, bb] = parseColor(bg);
  const edge = dir > 0 ? Math.ceil(box.x + box.w) : Math.floor(box.x);
  const w = Math.max(0, Math.min(dir > 0 ? pixels.width - edge : edge, Math.ceil(limit)));
  const y0 = Math.max(0, Math.floor(box.y));
  const h = Math.max(1, Math.min(pixels.height - y0, Math.ceil(box.h)));
  if (!w) return 0;
  const x0 = dir > 0 ? edge : edge - w;
  const { data } = pixels.getContext('2d').getImageData(x0, y0, w, h);
  for (let step = 0; step < w; step++) {
    const x = dir > 0 ? step : w - 1 - step;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb) > 48) return Math.max(0, step - 8);
    }
  }
  return w;
}

// Greedy word wrap at font size fs for max width w.
function wrap(text, fs, w, weight) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, fs, weight) > w) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

// Fit the translation into the segment, starting from the original text size.
// Single lines (headings, buttons, labels) stay on one line — growing into free background on
// their right, otherwise shrinking (down to ~45%); paragraphs wrap to the original width and
// shrink (down to ~55%) until they fit the original height.
function layout(textStr, seg, weight, room = 0) {
  const fs0 = Math.max(8, seg.lineH * 0.8);
  const minFs = Math.max(8, fs0 * 0.55);
  if (seg.lines.length === 1) {
    // Buttons and labels: better a bit smaller than broken onto a second line.
    const minLineFs = Math.max(8, fs0 * 0.45);
    const maxW = seg.w + Math.max(room, seg.w * 0.1);
    const width = measure(textStr, fs0, weight);
    const fs = width <= maxW ? fs0 : Math.max(minLineFs, (fs0 * maxW) / width);
    if (measure(textStr, fs, weight) <= maxW || fs > minLineFs) return { fs, lines: [textStr] };
  }
  const maxW = seg.w * 1.05;
  const maxH = Math.max(seg.h, seg.lineH) * 1.12;
  let fs = fs0;
  let lines = wrap(textStr, fs, maxW, weight);
  while (fs > minFs && lines.length * fs * LINE_HEIGHT > maxH) {
    fs = Math.max(minFs, fs * 0.93);
    lines = wrap(textStr, fs, maxW, weight);
  }
  return { fs, lines };
}

export async function translateImage(app, { onNeedLanguages } = {}) {
  toast(t('editor.trImg.working'), 4000);
  const doc = app.doc;
  const revision = doc.version;
  const stale = () => app.doc !== doc || doc.version !== revision;
  let ocr;
  try {
    ocr = await app.ocrRegion(null);
  } catch (e) {
    console.warn('translate image: OCR failed', e);
    toast(t('editor.toast.ocrUnavailable'));
    return;
  }
  if (stale()) return toast(t('editor.trImg.changed'));
  const lines = (ocr?.lines || [])
    .filter((l) => l.box && l.text?.trim())
    .map((l) => ({ text: l.text.trim(), x: ocr.rect.x + l.box.x, y: ocr.rect.y + l.box.y, w: l.box.width, h: l.box.height }));
  if (!lines.length) return toast(t('editor.ocr.nothing'));

  const segments = groupLines(lines);
  const request = () => kadr.invoke('native:translate-list', { texts: segments.map((s) => s.text) }).catch(() => ({ error: 'failed' }));
  let res = await request();
  if (stale()) return toast(t('editor.trImg.changed'));
  if (res.error === 'not-installed') {
    if (!(await onNeedLanguages?.(res))) return;
    if (stale()) return toast(t('editor.trImg.changed'));
    // Retry the translation directly: the UI still owns its in-progress guard.
    res = await request();
    if (stale()) return toast(t('editor.trImg.changed'));
    if (res.error === 'not-installed') return toast(t('editor.ocr.setupFailed'), 4000);
  }
  if (res.error === 'unsupported') {
    toast(t('editor.trImg.unsupported'), 3500);
    return kadr.invoke('native:web-translate', { text: segments.map((s) => s.text).join('\n'), to: res.to });
  }
  if (res.error) return toast(t('editor.toast.failed'));

  const base = app.doc.base;
  const k = app.doc.scale || 1;
  const objects = [];
  let replaced = 0;
  segments.forEach((seg, i) => {
    const translated = (res.texts?.[i] || '').trim();
    // Names, numbers, codes… that don't change are left as they are on the image.
    if (!translated || translated.toLowerCase() === seg.text.toLowerCase()) return;
    replaced++;
    const first = seg.lines[0];
    const pad = Math.max(2, Math.round(first.h * 0.12));
    const box = {
      x: Math.max(0, Math.floor(first.x - pad)),
      y: Math.max(0, Math.floor(first.y - pad)),
      w: Math.ceil(first.w + pad * 2),
      h: Math.ceil(first.h + pad * 2),
    };
    const bg = dominantBorderColor(base, { ...box, w: Math.min(box.w, base.width - box.x), h: Math.min(box.h, base.height - box.y) }) || '#ffffff';
    const ink = inkOf(base, { x: Math.floor(first.x), y: Math.floor(first.y), w: Math.max(1, Math.floor(Math.min(first.w, base.width - first.x))), h: Math.max(1, Math.floor(Math.min(first.h, base.height - first.y))) }, bg);
    const weight = ink.density > 0.24 ? 700 : ink.density > 0.17 ? 600 : 400;
    // Smart erase over every original line (per line, so nothing between lines is covered).
    for (const l of seg.lines) {
      // Vision's line boxes already have some margin: keep the eraser tight so it doesn't
      // eat button borders or underlines next to the text.
      const p = Math.max(1, Math.round(l.h * 0.05));
      const e = app.newObject('conceal', l.x - p, l.y - p, { concealType: 'erase' });
      Object.assign(e, { w: l.w + p * 2, h: l.h + p * 2 });
      objects.push(e);
    }
    // Single lines may grow into empty background (never past a button edge). A line closed
    // in on both sides (button, badge, pill) is centred and may use the whole width.
    let room = 0;
    let centred = false;
    if (seg.lines.length === 1) {
      const right = freeSide(base, first, bg, first.w * 1.5, 1);
      const left = freeSide(base, first, bg, first.w * 1.5, -1);
      centred = left < first.h * 2 && right < first.h * 2;
      // Keep a little padding inside buttons.
      room = centred ? Math.max(0, left + right - first.h * 0.6) : right;
    }
    const { fs, lines: wrapped } = layout(translated, seg, weight, room);
    const o = app.newObject('text', seg.x, seg.y, { textStyle: 'plain', fontSize: fs / k, color: ink.color, shadow: false, opacity: 1 });
    o.text = wrapped.join('\n');
    o.weight = weight;
    // Centre the new block vertically on the original one.
    const blockH = wrapped.length * fs * LINE_HEIGHT;
    o.y = seg.y + (seg.h - blockH) / 2;
    o.x = centred ? seg.x + seg.w / 2 - measure(wrapped[0], fs, weight) / 2 - fs * 0.04 : seg.x - fs * 0.04;
    objects.push(o);
  });
  if (!replaced) return toast(t('editor.trImg.nothingToTranslate'));
  // Erasers first, texts on top — one undo step for everything.
  for (const o of objects.filter((x) => x.type === 'conceal')) app.doc.add(o);
  for (const o of objects.filter((x) => x.type === 'text')) app.doc.add(o);
  app.doc.changed();
  app.select(null);
  app.commit();
  toast(t('editor.trImg.done', { n: replaced, from: (res.from || '').toUpperCase(), to: (res.to || '').toUpperCase() }), 4000);
}
