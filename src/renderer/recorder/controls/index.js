// Floating recording controls: timer, pause/resume, stop, mic mute, discard.
import { initPage, kadr, $, t, formatDuration } from '../../../shared/ui.js';
import { icon } from '../shared/icons.js';

await initPage();

let state = await kadr.invoke('recorder:get-state');
let receivedAt = performance.now();

const setIcon = (btn, name) => btn.replaceChildren(icon(name));
setIcon($('#stop'), 'stop');
setIcon($('#discard'), 'trash');
$('#grip').append(icon('grip'));

function tip(btn, key) {
  btn.dataset.tip = t(key);
  btn.setAttribute('aria-label', t(key));
}

function elapsed() {
  return state.elapsedMs + (state.status === 'recording' ? performance.now() - receivedAt : 0);
}

function render() {
  const paused = state.status === 'paused';
  const saving = state.status === 'processing';
  document.body.classList.toggle('paused', paused);
  $('#timer').textContent = paused ? `${formatDuration(elapsed())} · ${t('recorder.controls.paused')}` : formatDuration(elapsed());
  setIcon($('#pause'), paused ? 'play' : 'pause');
  tip($('#pause'), paused ? 'recorder.controls.resume' : 'recorder.controls.pause');
  tip($('#stop'), 'recorder.controls.stop');
  tip($('#discard'), 'recorder.controls.discard');
  const mic = $('#mic');
  mic.disabled = !state.hasMic;
  mic.classList.toggle('muted', state.hasMic && state.micMuted);
  setIcon(mic, !state.hasMic || state.micMuted ? 'micOff' : 'mic');
  tip(mic, !state.hasMic ? 'recorder.controls.noMic' : state.micMuted ? 'recorder.controls.unmute' : 'recorder.controls.mute');
  if (saving) showView('saving');
}

function showView(id) {
  for (const v of ['main', 'confirm', 'saving']) $(`#${v}`).classList.toggle('hidden', v !== id);
}

const control = (action) => kadr.invoke('recorder:control', action).then((s) => s && ((state = s), (receivedAt = performance.now()), render()));

$('#pause').addEventListener('click', () => control(state.status === 'paused' ? 'resume' : 'pause'));
$('#stop').addEventListener('click', () => control('stop'));
$('#mic').addEventListener('click', () => state.hasMic && control(state.micMuted ? 'unmute' : 'mute'));
$('#discard').addEventListener('click', () => showView('confirm'));
$('#discard-no').addEventListener('click', () => showView('main'));
$('#discard-yes').addEventListener('click', () => control('discard'));

kadr.on('recorder:state', (s) => {
  state = s;
  receivedAt = performance.now();
  render();
});
kadr.on('recorder:level', (level) => {
  const v = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(level, 1e-5)) + 50) / 50));
  $('#pill').style.setProperty('--level', v.toFixed(3));
});

// The window is click-through except while the pointer is over the pill.
let over = false;
function setOver(v) {
  if (v === over) return;
  over = v;
  kadr.invoke('win:set-ignore-mouse', !v, true);
}
document.addEventListener('mousemove', (e) => setOver(!!e.target.closest?.('#pill')));
document.addEventListener('mouseleave', () => setOver(false));

setInterval(() => {
  if (state.status === 'recording') $('#timer').textContent = formatDuration(elapsed());
}, 250);
render();
