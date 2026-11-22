// Pinned image: drag to move, wheel to zoom, ⌥/Alt+wheel for opacity, right-click menu.
import { initPage, kadr, $ } from '../../shared/ui.js';

const { params } = await initPage();
const img = $('#img');
const badge = $('#badge');
img.src = params.imageUrl;

let drag = null;
let badgeTimer = 0;

function flash(text) {
  badge.textContent = text;
  badge.classList.remove('hidden');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => badge.classList.add('hidden'), 900);
}

img.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  img.setPointerCapture(e.pointerId);
  drag = { x: e.screenX, y: e.screenY, pending: null };
  document.body.classList.add('dragging');
});

img.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!dx && !dy) return;
  drag.x = e.screenX;
  drag.y = e.screenY;
  kadr.invoke('pin:move-by', { dx, dy });
});

img.addEventListener('pointerup', () => {
  drag = null;
  document.body.classList.remove('dragging');
});

img.addEventListener('dblclick', () => kadr.invoke('pin:reset-size'));

addEventListener('contextmenu', (e) => {
  e.preventDefault();
  kadr.invoke('pin:menu');
});

addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.altKey) {
      kadr.invoke('pin:opacity-by', e.deltaY > 0 ? -0.05 : 0.05);
      return;
    }
    const factor = Math.exp(-e.deltaY * 0.0025);
    kadr.invoke('pin:zoom', { factor, anchor: { x: e.clientX, y: e.clientY } });
  },
  { passive: false }
);

addEventListener('resize', () => {
  const pct = Math.round((innerWidth / params.naturalWidth) * 100);
  flash(`${pct}%`);
});

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape' || (mod && e.key.toLowerCase() === 'w')) kadr.invoke('win:close');
  else if (mod && e.key.toLowerCase() === 'c') kadr.invoke('pin:copy').then(() => flash('✓'));
  else if (mod && e.key.toLowerCase() === 's') kadr.invoke('pin:save');
  else if (mod && e.key.toLowerCase() === 'e') kadr.invoke('pin:edit');
  else if (mod && e.key === '0') kadr.invoke('pin:reset-size');
});
