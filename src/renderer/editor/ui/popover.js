// Popovers, menus and modal dialogs.
import { el } from '../../../shared/ui.js';
import { iconNode } from '../icons.js';

const open = []; // close functions, innermost last
let modal = null;

export function closePopovers() {
  const n = open.length;
  while (open.length) open.pop()();
  return n > 0;
}

export const hasPopover = () => open.length > 0;
export const isModalOpen = () => !!modal;

function place(pop, anchor, { align = 'start', gap = 6, at = null } = {}) {
  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let x = align === 'end' ? r.right - pw : align === 'center' ? (r.left + r.right) / 2 - pw / 2 : r.left;
  let y = r.bottom + gap;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - gap - ph);
  x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
}

// Show `content` in a floating panel next to `anchor` (or at {x,y}). Returns { el, close }.
export function openPopover(anchor, content, { className = '', align = 'start', at = null, onClose, keep = false } = {}) {
  if (!keep) closePopovers();
  const pop = el(`div.popover.panel${className ? '.' + className : ''}`, content);
  document.body.append(pop);
  place(pop, anchor, { align, at });
  const onDown = (e) => {
    if (!pop.contains(e.target) && !(anchor && anchor.contains?.(e.target))) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    const i = open.indexOf(close);
    if (i >= 0) open.splice(i, 1);
    anchor?.classList?.remove('open');
    onClose?.();
  }
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  window.addEventListener('keydown', onKey, true);
  anchor?.classList?.add('open');
  open.push(close);
  return { el: pop, close, reposition: () => place(pop, anchor, { align, at }) };
}

// items: [{ label, icon, shortcut, disabled, checked, danger, onClick } | 'sep' | { header }]
export function openMenu(anchor, items, opts = {}) {
  let ref;
  const rows = items.map((it) => {
    if (it === 'sep') return el('div.menu-sep');
    if (it.header) return el('div.menu-header', it.header);
    return el(
      `button.menu-item${it.danger ? '.danger' : ''}`,
      {
        disabled: !!it.disabled,
        onclick: () => {
          ref.close();
          it.onClick?.();
        },
      },
      el('span.menu-icon', it.checked ? iconNode('check') : it.icon ? iconNode(it.icon) : null),
      el('span.menu-label', it.label),
      it.shortcut ? el('span.menu-shortcut', it.shortcut) : null,
    );
  });
  ref = openPopover(anchor, el('div.menu', rows), { className: 'menu-pop', ...opts });
  return ref;
}

// Modal dialog. buttons: [{ label, primary, danger, onClick → false keeps the dialog open }]
export function openDialog({ title, body, buttons = [], onClose, width = 360 }) {
  closePopovers();
  if (modal) modal.close();
  const box = el('div.dialog.panel', { style: { width: `${width}px` } }, el('div.dialog-title', title), el('div.dialog-body', body));
  const footer = el('div.dialog-footer');
  let primary = null;
  const close = () => {
    if (!modal) return;
    shade.remove();
    window.removeEventListener('keydown', onKey, true);
    modal = null;
    onClose?.();
  };
  for (const b of buttons) {
    const btn = el(`button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`, {
      onclick: async () => {
        if ((await b.onClick?.()) !== false) close();
      },
    }, b.label);
    if (b.primary) primary = btn;
    footer.append(btn);
  }
  box.append(footer);
  const shade = el('div.dialog-shade', box);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && primary && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      e.stopPropagation();
      primary.click();
    }
  };
  window.addEventListener('keydown', onKey, true);
  shade.addEventListener('pointerdown', (e) => {
    if (e.target === shade) close();
  });
  document.body.append(shade);
  modal = { close };
  setTimeout(() => box.querySelector('input, select, button.primary')?.focus());
  return modal;
}

