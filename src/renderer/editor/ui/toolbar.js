// Top toolbar: tool buttons (left), output actions (right), secondary actions in the property bar.
import { el, $, t, isMac, kadr } from '../../../shared/ui.js';
import { TOOLS } from '../consts.js';
import { icon } from '../icons.js';
import { openMenu } from './popover.js';

const GROUPS = [['select', 'crop'], ['wand', 'lasso'], ['arrow', 'rect', 'oval', 'line'], ['text', 'counter'], ['freehand', 'highlighter'], ['conceal', 'spotlight', 'magnifier'], ['ruler', 'picker']];

// Shortcut label: sc('C') → ⌘C / Ctrl+C, sc('S', true) → ⇧⌘S / Ctrl+Shift+S
export function sc(key, shift = false) {
  if (isMac) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

function tip(label, key) {
  return key ? `${label}  ${key}` : label;
}

function ibtn(name, tipText, onclick, cls = '') {
  return el(`button.ibtn${cls}`, { html: icon(name), dataset: { tip: tipText }, onclick, 'aria-label': tipText });
}

export function buildToolbar(app, actions, output) {
  const host = $('#tools');
  host.textContent = '';
  const buttons = new Map();
  GROUPS.forEach((group, gi) => {
    if (gi) host.append(el('div.sep'));
    for (const id of group) {
      const def = TOOLS.find((x) => x.id === id);
      const key = def.key2 ? `${def.key} / ${def.key2}` : def.key;
      const b = ibtn(id, tip(t(`editor.tool.${id}`), key), () => app.setTool(id), '.tool');
      b.dataset.tool = id;
      buttons.set(id, b);
      host.append(b);
    }
  });
  const syncTools = () => {
    for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(app.toolId === id));
  };
  app.on('tool', syncTools);
  syncTools();

  // ---- right side: drag-out, copy, save, pin, more ----
  const right = $('#actions');
  right.textContent = '';
  const thumb = el('canvas.drag-thumb', { width: 64, height: 44 });
  const drag = el('div.drag-out', { draggable: 'true', dataset: { tip: t('editor.action.drag'), tipAlign: 'right' } }, thumb);
  drag.addEventListener('pointerenter', () => output.prepare());
  drag.addEventListener('pointerdown', () => output.prepare());
  drag.addEventListener('dragstart', (e) => {
    e.preventDefault();
    const name = app.params.meta?.fileName?.replace(/\.[a-z0-9]+$/i, '') || undefined;
    const bytes = output.cachedPng();
    if (bytes) kadr.send('image:start-drag', { data: bytes, ext: 'png', name });
    else output.bytes('png').then((b) => kadr.send('image:start-drag', { data: b, ext: 'png', name }));
  });
  let thumbTimer = 0;
  const drawThumb = () => {
    thumbTimer = 0;
    const src = app.composite;
    const g = thumb.getContext('2d');
    g.clearRect(0, 0, thumb.width, thumb.height);
    if (!src.width) return;
    const s = Math.min(thumb.width / src.width, thumb.height / src.height);
    const w = src.width * s;
    const h = src.height * s;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
  };
  app.on('frame', () => {
    if (!thumbTimer) thumbTimer = setTimeout(drawThumb, 400);
  });

  const copy = el(
    'button.btn.primary.copy-btn',
    { dataset: { tip: `${t('editor.action.copy')}  ${sc('C')} · ${t('editor.hint.escCopies')}`, tipAlign: 'right' }, onclick: () => actions.copy() },
    el('span', { html: icon('copy') }),
    el('span.copy-label', t('editor.action.copyShort')),
  );
  const more = ibtn('more', t('editor.action.more'), () => openMenu(more, actions.moreItems(), { align: 'end' }));
  more.dataset.tipAlign = 'right';
  right.append(
    drag,
    ibtn('pin', tip(t('editor.action.pin'), sc('P')), () => actions.pin()),
    ibtn('save', tip(t('editor.action.save'), sc('S')), () => actions.save()),
    copy,
    more,
  );

  // ---- property bar, right side: OCR, add capture, backdrop, undo/redo ----
  const pr = $('#props-right');
  pr.textContent = '';
  const backdropBtn = ibtn('backdrop', tip(t('editor.action.backdrop'), 'K'), () => actions.toggleBackdrop());
  const undo = ibtn('undo', tip(t('editor.action.undo'), sc('Z')), () => app.undo());
  const redo = ibtn('redo', tip(t('editor.action.redo'), isMac ? sc('Z', true) : sc('Y')), () => app.redo());
  redo.dataset.tipAlign = 'right';
  pr.append(
    ibtn('ocr', t('editor.action.ocr'), () => actions.ocr()),
    ibtn('translate', t('editor.action.translateImage'), () => actions.translateImage()),
    ibtn('addCapture', t('editor.action.addCapture'), () => actions.addCapture()),
    backdropBtn,
    el('div.sep'),
    undo,
    redo,
  );
  const syncHistory = () => {
    undo.disabled = !app.history.canUndo;
    redo.disabled = !app.history.canRedo;
  };
  const syncBackdrop = () => backdropBtn.setAttribute('aria-pressed', String(!!app.backdrop.enabled));
  app.on('history', syncHistory);
  app.on('backdrop', syncBackdrop);
  syncHistory();
  syncBackdrop();
}
