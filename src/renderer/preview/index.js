// After-capture thumbnail: click = edit, drag = drop the file anywhere, hover = actions.
import { initPage, kadr, $, toast, t } from '../../shared/ui.js';

const { params } = await initPage();
const img = $('#img');
const card = $('#card');
img.src = params.imageUrl;

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  document.body.classList.add('leaving');
  setTimeout(() => kadr.invoke('win:close'), 220);
}

// Auto-dismiss (paused while hovered, via CSS animation-play-state).
const bar = $('#progress');
if (params.timeout > 0) {
  bar.style.animation = `shrink ${params.timeout}s linear forwards`;
  bar.addEventListener('animationend', close);
} else bar.parentElement.classList.add('hidden');

img.addEventListener('dragstart', (e) => {
  e.preventDefault();
  kadr.send('preview:start-drag');
  setTimeout(close, 300);
});

card.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  kadr.invoke('preview:edit');
});

$('#edit').addEventListener('click', () => kadr.invoke('preview:edit'));
$('#copy').addEventListener('click', async () => {
  await kadr.invoke('preview:copy');
  toast(t('notify.copied'), 900);
  setTimeout(close, 700);
});
$('#save').addEventListener('click', async () => {
  const file = await kadr.invoke('preview:save');
  if (file) close();
});
$('#pin').addEventListener('click', () => kadr.invoke('preview:pin'));
$('#close').addEventListener('click', close);
addEventListener('keydown', (e) => e.key === 'Escape' && close());
