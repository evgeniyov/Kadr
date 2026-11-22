// Countdown overlay: shows N…1 once main says "go" (main owns the timing).
import { initPage, kadr, $ } from '../../../shared/ui.js';

const { params } = await initPage();
const total = Math.max(1, Number(params.seconds) || 3);
const CIRC = 2 * Math.PI * 92;
const num = $('#num');
const progress = $('#progress');

function show(n) {
  num.textContent = String(n);
  num.classList.remove('tick');
  void num.offsetWidth; // restart the animation
  num.classList.add('tick');
}

show(total);

kadr.on('recorder:countdown-go', () => {
  const t0 = performance.now();
  let shown = total;
  show(total);
  const frame = () => {
    const elapsed = (performance.now() - t0) / 1000;
    progress.style.strokeDashoffset = String(Math.min(1, elapsed / total) * CIRC);
    const n = Math.max(1, total - Math.floor(elapsed));
    if (n !== shown) show((shown = n));
    if (elapsed < total) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
