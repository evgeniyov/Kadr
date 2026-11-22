// Status bar: image size (px/pt toggle), zoom, cursor position, colour under the cursor, hints.
import { el, $, t, kadr, toast, getSettings, setSettings } from '../../../shared/ui.js';
import { formatColor } from '../color.js';
import { openMenu } from './popover.js';
import { sc } from './toolbar.js';

export function buildStatusBar(app) {
  const host = $('#statusbar');
  const dims = el('button.sb-item.sb-btn', { dataset: { tip: t('editor.status.toggleUnit'), tipPos: 'top' } });
  const zoom = el('button.sb-item.sb-btn', { dataset: { tip: t('editor.status.zoom'), tipPos: 'top' } });
  const pos = el('span.sb-item.sb-pos');
  const swatch = el('i.sb-swatch', { style: { display: 'none' } });
  const colorText = el('span');
  const color = el('button.sb-item.sb-btn.sb-color', { dataset: { tip: t('editor.status.copyColor'), tipPos: 'top' } }, swatch, colorText);
  const hint = el('span.sb-hint');
  const esc = el('span.sb-esc', el('kbd', 'Esc'), el('span', t('editor.hint.escCopiesShort')));
  host.replaceChildren(el('div.sb-left', dims, el('span.sb-dot'), zoom, el('span.sb-dot'), pos, color), el('div.sb-right', hint, esc));

  let lastColor = null;
  const unitK = () => (app.unit === 'pt' ? app.doc.scale : 1);
  const fmtLen = (v) => {
    const n = v / unitK();
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  };

  const syncDims = () => {
    const L = app.layout;
    const w = L ? L.width : app.doc.width;
    const h = L ? L.height : app.doc.height;
    dims.textContent = `${fmtLen(w)} × ${fmtLen(h)} ${app.unit}`;
  };
  const syncZoom = () => {
    zoom.textContent = `${Math.round(app.view.zoom * 100)}%`;
  };
  const syncCursor = () => {
    const c = app.cursor;
    if (!c) {
      pos.textContent = '';
      return;
    }
    const x = Math.floor(c.x);
    const y = Math.floor(c.y);
    pos.textContent = `${fmtLen(x)}, ${fmtLen(y)} ${app.unit}`;
    const px = app.colorAtScreen(c.sx, c.sy);
    if (px) {
      lastColor = px;
      swatch.style.display = '';
      swatch.style.background = `rgba(${px.r},${px.g},${px.b},${px.a / 255})`;
      colorText.textContent = formatColor(px, getSettings()?.colorFormat || 'hex');
    }
  };
  const syncHint = () => {
    const tool = app.toolId;
    const key = { crop: 'editor.hint.crop', picker: 'editor.hint.picker', ruler: 'editor.hint.ruler', ocr: 'editor.ocr.hint', text: 'editor.hint.text', counter: 'editor.hint.counter', magnifier: 'editor.hint.magnifier', highlighter: 'editor.hint.shift', freehand: 'editor.hint.shift', arrow: 'editor.hint.shiftAngle', line: 'editor.hint.shiftAngle', spotlight: 'editor.hint.spotlight', wand: 'editor.hint.wand', lasso: app.props.lassoShape === 'polygon' ? 'editor.hint.polygon' : 'editor.hint.lasso' }[tool];
    hint.textContent = key ? t(key) : '';
  };

  dims.addEventListener('click', () => {
    app.unit = app.unit === 'px' ? 'pt' : 'px';
    setSettings({ editor: { unit: app.unit } }).catch(() => {});
    syncDims();
    syncCursor();
  });
  zoom.addEventListener('click', () => {
    const z = (v) => () => app.view.setZoom(v);
    openMenu(zoom, [
      { label: t('editor.zoom.fit'), shortcut: sc('0'), onClick: () => app.view.fit(false) },
      { label: '50%', onClick: z(0.5) },
      { label: t('editor.zoom.actual'), shortcut: sc('1'), onClick: z(1) },
      { label: '200%', onClick: z(2) },
      { label: '400%', onClick: z(4) },
      'sep',
      { label: t('editor.zoom.in'), shortcut: sc('+'), onClick: () => app.view.zoomStep(1) },
      { label: t('editor.zoom.out'), shortcut: sc('−'), onClick: () => app.view.zoomStep(-1) },
    ]);
  });
  color.addEventListener('click', async () => {
    if (!lastColor) return;
    const text = formatColor(lastColor, getSettings()?.colorFormat || 'hex');
    await kadr.invoke('clipboard:write-text', text).catch(() => {});
    toast(t('editor.toast.colorCopied', { color: text }));
  });

  app.on('zoom', syncZoom);
  app.on('cursor', syncCursor);
  app.on('tool', syncHint);
  app.on('props', syncHint);
  app.on('frame', syncDims);
  syncDims();
  syncZoom();
  syncHint();
}
