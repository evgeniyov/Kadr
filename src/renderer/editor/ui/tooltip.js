// Floating tooltips for [data-tip] elements. Replaces the CSS ::after tooltips of ui.css in the
// editor, because those get clipped by scrollable bars and at the window edges.
export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'ed-tip';
  document.body.append(tip);
  let target = null;
  let timer = 0;

  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.classList.remove('show');
  };

  const show = () => {
    if (!target?.isConnected) return hide();
    const text = target.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('show');
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    let y = target.dataset.tipPos === 'top' ? r.top - h - 6 : r.bottom + 6;
    if (y + h > window.innerHeight - 4) y = r.top - h - 6;
    x = Math.max(6, Math.min(window.innerWidth - w - 6, x));
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(Math.max(4, y))}px`;
  };

  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el === target) return;
    hide();
    if (!el || !el.dataset.tip) return;
    target = el;
    timer = setTimeout(show, tip.classList.contains('show') ? 0 : 500);
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('pointerleave', hide);
}
