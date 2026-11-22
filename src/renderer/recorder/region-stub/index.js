// STUB region selector (fallback when ctx.modules.capture.selectRegion is missing):
// drag to select, Enter = whole display, Esc = cancel. Coordinates are DIP relative
// to this display-sized window.
import { initPage, kadr, $ } from '../../../shared/ui.js';

await initPage();
const sel = $('#sel');
let start = null;
let rect = null;

const done = (r) => kadr.invoke('recorder:stub-done', r);
const cancel = () => kadr.invoke('win:close');

function draw() {
  sel.classList.toggle('hidden', !rect);
  document.body.classList.toggle('selecting', !!rect);
  if (!rect) return;
  Object.assign(sel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  $('#size').textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

window.addEventListener('mousedown', (e) => {
  start = { x: e.clientX, y: e.clientY };
  rect = null;
  draw();
});
window.addEventListener('mousemove', (e) => {
  if (!start) return;
  rect = {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    width: Math.abs(e.clientX - start.x),
    height: Math.abs(e.clientY - start.y),
  };
  draw();
});
window.addEventListener('mouseup', () => {
  start = null;
  if (rect && rect.width >= 16 && rect.height >= 16) done(rect);
  else {
    rect = null;
    draw();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
  else if (e.key === 'Enter') done({ x: 0, y: 0, width: innerWidth, height: innerHeight });
});
