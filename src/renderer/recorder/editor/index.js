// Video editor / exporter: trim, crop, resize, format, fps, quality, speed, mute.
// Opened after a recording (as the result window) or for any video file.
import { initPage, kadr, $, t, el, toast, isMac, formatDuration } from '../../../shared/ui.js';
import { icon, formatBytes } from '../shared/icons.js';
import * as plan from '../shared/export-plan.mjs';
import { Timeline } from './timeline.js';
import { CropTool } from './crop.js';

const { params: P } = await initPage();
const video = $('#video');

const S = {
  src: null, // { file, name, size, durationMs, width, height, fps, video, audio, raw }
  url: null,
  dur: 0,
  trim: { start: 0, end: 0 },
  cropOn: false,
  crop: null,
  cropAspect: 'free',
  format: 'mp4',
  sizePreset: 'original',
  custom: null,
  lockAspect: true,
  fps: null,
  quality: 'high',
  speed: 1,
  mute: false,
  // Kadr recordings with separate tracks: which sources to keep.
  keepMic: true,
  keepSystem: true,
  precise: false,
  exporting: false,
  preciseShown: false,
};

const ASPECTS = { free: null, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };

function fmtTime(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

const kind = () => plan.FORMATS[S.format].kind;
const trimmed = () => S.trim.start > 0.001 || S.trim.end < S.dur - 0.001;
const cropRect = () => (S.cropOn && kind() !== 'audio' ? S.crop : null);
const baseSize = () => plan.baseSize(S.src, { crop: cropRect() });
const outSize = () => plan.presetSize(baseSize(), S.sizePreset, S.custom);

// Separate microphone / system tracks written by Kadr (see recording/post.js).
function sourceTracks() {
  const tracks = S.src?.audioTracks || [];
  const mic = tracks.findIndex((a) => a.role === 'mic');
  const system = tracks.findIndex((a) => a.role === 'system');
  return mic >= 0 && system >= 0 ? { mic, system } : null;
}

// → { mute, audioTrack } for the export and the preview.
function audioChoice() {
  const src = sourceTracks();
  if (!src) return { mute: kind() === 'video' && S.mute, audioTrack: 0 };
  if (S.keepMic && S.keepSystem) return { mute: false, audioTrack: 0 }; // the mix
  if (S.keepMic) return { mute: false, audioTrack: src.mic };
  if (S.keepSystem) return { mute: false, audioTrack: src.system };
  return { mute: true, audioTrack: 0 };
}

function audioExportUnavailable() {
  return kind() === 'audio' && !!sourceTracks() && !S.keepMic && !S.keepSystem;
}

// Let the preview sound like the export will (mute / only one source).
function applyPreviewAudio() {
  const { mute, audioTrack } = audioChoice();
  const off = mute || (!sourceTracks() && S.mute);
  video.muted = off;
  const list = video.audioTracks;
  if (list && list.length > 1) for (let i = 0; i < list.length; i++) list[i].enabled = i === audioTrack;
}

function spec() {
  const audioOnly = kind() === 'audio';
  const audio = audioChoice();
  return {
    format: S.format,
    trim: trimmed() ? { ...S.trim } : null,
    crop: cropRect(),
    size: audioOnly ? null : outSize(),
    fps: audioOnly ? null : S.fps,
    quality: S.quality,
    mute: audio.mute,
    audioTrack: audio.audioTrack,
    speed: S.speed,
    precise: S.precise,
  };
}

// ---- player -------------------------------------------------------------------------------

const timeline = new Timeline($('#timeline'), {
  onSeek: (time) => seek(time),
  onTrim: (trim, previewAt) => {
    S.trim = trim;
    if (video.paused) seek(previewAt);
    renderTrim();
    renderExport();
  },
});

function seek(time) {
  video.currentTime = Math.max(0, Math.min(S.dur, time));
  renderTime();
}

function renderTime() {
  $('#time').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(S.dur)}`;
  timeline.set({ time: video.currentTime });
}

function renderPlay() {
  const playing = !video.paused;
  $('#play').replaceChildren(icon(playing ? 'pause' : 'play'));
  $('#play').dataset.tip = t(playing ? 'recorder.editor.pause' : 'recorder.editor.play');
}

function togglePlay() {
  if (video.paused) {
    if (video.currentTime < S.trim.start - 0.05 || video.currentTime >= S.trim.end - 0.05) video.currentTime = S.trim.start;
    video.play().catch(() => {});
  } else video.pause();
}

// Loop inside the selected clip while playing. rAF gives smooth UI; timeupdate/ended
// keep the loop working when the window isn't rendering (occluded, other space).
function wrapToClip() {
  if (!video.paused && video.currentTime >= S.trim.end - 0.03) video.currentTime = S.trim.start;
}
function tick() {
  wrapToClip();
  renderTime();
  if (!video.paused) requestAnimationFrame(tick);
}

video.addEventListener('play', () => (renderPlay(), requestAnimationFrame(tick)));
video.addEventListener('timeupdate', wrapToClip);
video.addEventListener('ended', () => {
  if (!trimmed()) return renderPlay();
  video.currentTime = S.trim.start;
  video.play().catch(() => {});
});
video.addEventListener('pause', renderPlay);
video.addEventListener('seeked', renderTime);
video.addEventListener('click', togglePlay);
video.addEventListener('loadedmetadata', () => {
  applyPreviewAudio();
  if (!S.dur && Number.isFinite(video.duration)) {
    S.dur = video.duration;
    S.trim = { start: 0, end: S.dur };
    timeline.set({ duration: S.dur, trim: S.trim });
  }
  layoutCrop();
  renderTime();
  timeline.buildThumbs(S.url, S.src.width / S.src.height);
});
video.addEventListener('error', () => {
  if (video.getAttribute('src')) stageMessage(t('recorder.result.noPreview'));
});

function stageMessage(text) {
  const box = $('#stage-msg');
  box.replaceChildren(icon('warning'), el('span', text));
  box.classList.toggle('hidden', !text);
}

function setIn() {
  S.trim.start = Math.min(video.currentTime, S.trim.end - 0.1);
  afterTrimChange();
}
function setOut() {
  S.trim.end = Math.max(video.currentTime, S.trim.start + 0.1);
  afterTrimChange();
}
function afterTrimChange() {
  timeline.set({ trim: S.trim });
  renderTrim();
  renderExport();
}

function renderTrim() {
  $('#clip').textContent = t('recorder.editor.selection', { d: fmtTime(S.trim.end - S.trim.start) });
  $('#reset-trim').disabled = !trimmed();
}

// ---- crop ----------------------------------------------------------------------------------

const cropTool = new CropTool($('#crop-layer'), {
  onChange: (rect) => {
    S.crop = rect;
    renderExport();
  },
});

function layoutCrop() {
  if (!S.src) return;
  const vw = video.videoWidth || S.src.width;
  const vh = video.videoHeight || S.src.height;
  const w = video.clientWidth;
  const h = video.clientHeight;
  if (!vw || !vh || !w || !h) return;
  const k = Math.min(w / vw, h / vh);
  cropTool.layout({ left: (w - vw * k) / 2, top: (h - vh * k) / 2, width: vw * k, height: vh * k });
}

function setCrop(on) {
  S.cropOn = on;
  if (on) {
    cropTool.show({ width: S.src.width, height: S.src.height }, S.crop);
    cropTool.aspect = ASPECTS[S.cropAspect];
    layoutCrop();
    if (!S.crop) cropTool.reset();
  } else cropTool.hide();
  renderOptions();
  renderExport();
}

// ---- export options ---------------------------------------------------------------------------

function opt(iconName, label, control, body = null) {
  return el('div.opt', el('div.opt-head', el('div.opt-label', icon(iconName), el('span', label)), control), body && el('div.opt-body', body));
}

function seg(options, value, onChange) {
  return el(
    'div.seg',
    options.map(([v, label]) => el('button', { 'aria-pressed': String(v === value), onclick: () => onChange(v) }, label)),
  );
}

function toggle(checked, onChange, disabled = false) {
  return el('label.switch', el('input', { type: 'checkbox', checked, disabled, onchange: (e) => onChange(e.target.checked) }), el('span'));
}

function formatSelect() {
  const groups = [
    ['recorder.editor.groupVideo', ['mp4', 'webm', 'mov', 'mkv']],
    ['recorder.editor.groupAnim', ['gif']],
    ['recorder.editor.groupAudio', ['m4a', 'mp3']],
  ];
  const sel = el('select.input', { onchange: (e) => setFormat(e.target.value) });
  for (const [label, list] of groups) {
    const g = el('optgroup', { label: t(label) });
    for (const f of list) g.append(el('option', { value: f, disabled: plan.FORMATS[f].kind === 'audio' && !S.src.audio }, plan.FORMATS[f].label));
    sel.append(g);
  }
  sel.value = S.format;
  return sel;
}

function setFormat(f) {
  const was = kind();
  S.format = f;
  if (kind() === 'gif' && was !== 'gif') {
    // Sensible GIF defaults: ≤ 960 px wide, 15 fps.
    if (!S.fps) S.fps = 15;
    const b = baseSize();
    if (S.sizePreset === 'original' && b.width > 960) {
      S.sizePreset = 'custom';
      S.custom = { width: 960, height: plan.even((960 * b.height) / b.width) };
    }
  }
  renderOptions();
  renderExport();
}

function sizeControls() {
  const b = baseSize();
  const short = Math.min(b.width, b.height);
  const label = (p) => {
    const s = plan.presetSize(b, p, S.custom);
    const dims = `${s.width}×${s.height}`;
    if (p === 'original') return `${t('recorder.editor.sizeOriginal')} — ${dims}`;
    if (p === 'half') return `${t('recorder.editor.sizeHalf')} — ${dims}`;
    if (p === 'custom') return t('recorder.editor.sizeCustom');
    return `${p}p — ${dims}`;
  };
  const sel = el('select.input', {
    onchange: (e) => {
      const v = e.target.value;
      S.sizePreset = /^\d+$/.test(v) ? Number(v) : v;
      if (S.sizePreset === 'custom' && !S.custom) S.custom = { ...plan.presetSize(b, 'original') };
      renderOptions();
      renderExport();
    },
  });
  for (const p of plan.SIZE_PRESETS) sel.append(el('option', { value: String(p), disabled: typeof p === 'number' && p >= short }, label(p)));
  sel.value = String(S.sizePreset);
  if (S.sizePreset !== 'custom') return { control: null, body: sel };

  const ratio = b.width / b.height;
  const w = el('input.input', { type: 'number', min: 2, step: 2, value: S.custom.width });
  const h = el('input.input', { type: 'number', min: 2, step: 2, value: S.custom.height });
  const apply = (changed) => {
    let width = Math.max(2, Number(w.value) || 2);
    let height = Math.max(2, Number(h.value) || 2);
    if (S.lockAspect) {
      if (changed === 'w') height = width / ratio;
      else width = height * ratio;
    }
    S.custom = { width: plan.even(width), height: plan.even(height) };
    w.value = S.custom.width;
    h.value = S.custom.height;
    renderExport();
  };
  w.addEventListener('change', () => apply('w'));
  h.addEventListener('change', () => apply('h'));
  const lock = el(
    'button.ibtn',
    {
      'aria-pressed': String(S.lockAspect),
      title: t('recorder.editor.keepAspect'),
      onclick: () => {
        S.lockAspect = !S.lockAspect;
        if (S.lockAspect) apply('w');
        renderOptions();
      },
    },
    icon(S.lockAspect ? 'link' : 'unlink'),
  );
  return { control: null, body: el('div', sel, el('div.dims', { style: { marginTop: '6px' } }, w, el('span.x', '×'), h, lock)) };
}

function renderOptions() {
  if (!S.src) return;
  const k = kind();
  const nodes = [el('div.side-title', t('recorder.editor.export'))];
  nodes.push(opt('film', t('recorder.editor.format'), formatSelect()));
  if (k !== 'audio') {
    const size = sizeControls();
    nodes.push(opt('screen', t('recorder.editor.size'), size.control, size.body));
    const aspects = seg(
      Object.keys(ASPECTS).map((a) => [a, a === 'free' ? t('recorder.editor.cropFree') : a]),
      S.cropAspect,
      (a) => {
        S.cropAspect = a;
        cropTool.setAspect(ASPECTS[a]);
        renderOptions();
      },
    );
    const cropBody = S.cropOn ? el('div', aspects, el('div.hint', el('button.link-btn', { onclick: () => cropTool.reset() }, t('recorder.editor.cropReset')))) : null;
    nodes.push(opt('region', t('recorder.editor.crop'), toggle(S.cropOn, setCrop), cropBody));
    const fpsOptions = plan.FPS_OPTIONS.map((f) => [f, f ? String(f) : t('recorder.editor.fpsKeep')]);
    nodes.push(opt('gauge', t('recorder.editor.fps'), null, seg(fpsOptions, S.fps, (v) => ((S.fps = v), renderOptions(), renderExport()))));
  }
  const quality = el(
    'select.input',
    { onchange: (e) => ((S.quality = e.target.value), renderExport()) },
    plan.QUALITIES.map((q) => el('option', { value: q, selected: q === S.quality }, t(`recorder.quality.${q}`))),
  );
  nodes.push(opt('quality', t('recorder.editor.quality'), quality));
  nodes.push(opt('timer', t('recorder.editor.speed'), null, seg(plan.SPEEDS.map((v) => [v, `${v}×`]), S.speed, (v) => ((S.speed = v), renderOptions(), renderExport()))));
  const audioChanged = () => (applyPreviewAudio(), renderExport());
  if (S.src.audio && sourceTracks()) {
    nodes.push(opt('mic', t('recorder.editor.keepMic'), toggle(S.keepMic, (v) => ((S.keepMic = v), audioChanged()))));
    nodes.push(opt('speaker', t('recorder.editor.keepSystem'), toggle(S.keepSystem, (v) => ((S.keepSystem = v), audioChanged()))));
  } else if (k === 'video' && S.src.audio) nodes.push(opt('micOff', t('recorder.editor.mute'), toggle(S.mute, (v) => ((S.mute = v), audioChanged()))));
  S.preciseShown = trimmed() && plan.canStreamCopy(S.src, spec());
  if (S.preciseShown) {
    const hint = el('div.hint', t(S.precise ? 'recorder.editor.preciseExact' : 'recorder.editor.preciseFast'));
    nodes.push(opt('check', t('recorder.editor.precise'), toggle(S.precise, (v) => ((S.precise = v), renderOptions(), renderExport())), hint));
  }
  $('#options').replaceChildren(...nodes);
}

function renderExport() {
  if (!S.src) return;
  const sp = spec();
  const f = plan.FORMATS[S.format];
  const dur = plan.outputDuration(S.src, sp);
  const size = sp.size ? `${sp.size.width}×${sp.size.height} · ` : '';
  const mode = plan.willStreamCopy(S.src, sp) ? t('recorder.editor.modeCopy') : t('recorder.editor.modeEncode');
  const unavailable = audioExportUnavailable();
  if (unavailable) $('#summary').replaceChildren(t('recorder.editor.selectAudioSource'));
  else $('#summary').replaceChildren(el('b', f.label), ` · ${size}${fmtTime(dur)} · ${mode}`);
  for (const id of ['#export-new', '#export-as']) $(id).disabled = S.exporting || unavailable;
  // The precise-cut option only exists while stream copy is possible: keep it in sync.
  if (S.preciseShown !== (trimmed() && plan.canStreamCopy(S.src, sp))) renderOptions();
  const srcExt = S.src.file.split('.').pop().toLowerCase();
  const replace = $('#export-replace');
  const sameFormat = f.ext === srcExt;
  replace.disabled = !sameFormat || S.exporting || unavailable;
  replace.dataset.tip = sameFormat ? '' : t('recorder.editor.replaceUnavailable', { ext: srcExt.toUpperCase() });
  if (sameFormat) delete replace.dataset.tip;
}

// ---- export -----------------------------------------------------------------------------------

function setExporting(on) {
  S.exporting = on;
  document.body.classList.toggle('exporting', on);
  $('#progress').classList.toggle('hidden', !on);
  if (on) {
    $('#done').classList.add('hidden');
    progress(0);
  }
  renderExport();
}

function progress(p) {
  const pct = Math.round(p * 100);
  $('#progress-bar').style.width = `${pct}%`;
  $('#progress-text').textContent = t('recorder.editor.progress', { p: pct });
}
kadr.on('recorder:export-progress', (p) => S.exporting && progress(p));

function releaseVideo() {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

async function attachVideo() {
  S.url = await kadr.invoke('recorder:video-url', S.src.file);
  if (!S.url) return stageMessage(t('recorder.result.noPreview'));
  stageMessage('');
  video.src = S.url;
}

function showDone(res) {
  const box = $('#done');
  const title = res.replaced ? t('recorder.editor.replaced') : t('recorder.editor.saved', { name: res.name });
  const actions = res.replaced
    ? []
    : [
        el('button.btn.sm', { onclick: () => kadr.invoke('app:reveal', res.path) }, t('recorder.editor.show')),
        el('button.btn.sm', { onclick: () => kadr.invoke('app:open-path', res.path) }, t('recorder.editor.open')),
        plan.FORMATS[S.format].kind === 'video' ? el('button.btn.sm', { onclick: () => kadr.invoke('recorder:open-editor', res.path) }, t('recorder.editor.openInEditor')) : null,
      ];
  box.replaceChildren(el('div.done-title', { title: res.path }, `${title} · ${formatBytes(res.size, t)}`), el('div.done-actions', actions));
  box.classList.remove('hidden');
}

async function doExport(target) {
  if (S.exporting || !S.src) return;
  if (audioExportUnavailable()) return toast(t('recorder.editor.selectAudioSource'), 4000);
  if (target === 'replace') {
    const ok = await kadr.invoke('app:confirm', {
      message: t('recorder.editor.replaceConfirm'),
      detail: t('recorder.editor.replaceDetail'),
      ok: t('recorder.editor.replace'),
      danger: true,
    });
    if (!ok) return;
    releaseVideo(); // Windows can't replace a file that the player keeps open
  }
  const sp = spec();
  setExporting(true);
  let res;
  try {
    res = await kadr.invoke('recorder:export', sp, target);
  } catch (e) {
    res = { error: 'failed', message: e.message };
  }
  setExporting(false);
  if (res?.replaced) {
    const info = await kadr.invoke('recorder:editor-info');
    if (info) await loadSource(info);
    return showDone(res);
  }
  if (target === 'replace') attachVideo();
  if (!res || res.cancelled) return;
  if (res.error) {
    const msg = res.error === 'no-audio' ? t('recorder.editor.noAudio') : t('recorder.editor.failed', { msg: res.message || res.error });
    return toast(msg, 4000);
  }
  showDone(res);
}

// ---- loading a file ------------------------------------------------------------------------------

async function loadSource(info) {
  S.src = info;
  S.dur = (info.durationMs || 0) / 1000;
  S.trim = { start: 0, end: S.dur };
  S.crop = null;
  S.cropAspect = 'free';
  S.sizePreset = 'original';
  S.custom = null;
  S.fps = null;
  S.speed = 1;
  S.mute = false;
  S.keepMic = true;
  S.keepSystem = true;
  S.precise = false;
  const ext = info.file.split('.').pop().toLowerCase();
  S.format = plan.FORMATS[ext]?.kind === 'video' ? ext : 'mp4';
  setCrop(false);
  document.title = info.name;
  $('#title').textContent = info.name;
  $('#name').textContent = info.name;
  const meta = [formatDuration(info.durationMs || 0), info.width && `${info.width} × ${info.height}`, info.fps && t('recorder.editor.fpsValue', { n: Math.round(info.fps) }), info.size && formatBytes(info.size, t)];
  $('#meta').textContent = meta.filter(Boolean).join(' · ');
  const warn = $('#warning');
  warn.classList.toggle('hidden', !info.raw);
  if (info.raw) warn.replaceChildren(icon('warning'), el('span', t('recorder.result.rawWarning')));
  $('#done').classList.add('hidden');
  timeline.set({ duration: S.dur, trim: S.trim, time: 0 });
  $('#time').textContent = `${fmtTime(0)} / ${fmtTime(S.dur)}`;
  renderTrim();
  renderOptions();
  renderExport();
  await attachVideo();
  if (!(await kadr.invoke('recorder:file-exists'))) stageMessage(t('recorder.result.missing'));
}

// ---- static UI --------------------------------------------------------------------------------------

const label = (id, iconName, key, extra) => $(id).replaceChildren(...[icon(iconName), el('span', t(key)), extra].filter(Boolean));
label('#open', 'open', 'recorder.result.open');
label('#reveal', 'folder', 'recorder.result.reveal');
$('#copy').replaceChildren(icon('copy'));
$('#copy').dataset.tip = t('recorder.result.copyPath');
$('#delete').replaceChildren(icon('trash'));
$('#delete').dataset.tip = t('recorder.result.delete');
$('#reset-trim').replaceChildren(icon('refresh'));
$('#reset-trim').dataset.tip = t('recorder.editor.resetTrim');
$('#set-in').replaceChildren(el('span', `⟦ ${t('recorder.editor.setIn')}`), el('kbd', 'I'));
$('#set-in').dataset.tip = t('recorder.editor.setInTip');
$('#set-out').replaceChildren(el('span', `${t('recorder.editor.setOut')} ⟧`), el('kbd', 'O'));
$('#set-out').dataset.tip = t('recorder.editor.setOutTip');
$('#file-icon').append(icon('film'));
$('#file').title = t('recorder.result.dragHint');
$('#export-new').textContent = t('recorder.editor.saveNew');
$('#export-as').textContent = t('recorder.editor.saveAs');
$('#export-replace').textContent = t('recorder.editor.replace');
$('#export-cancel').textContent = t('recorder.editor.cancel');
$('#drop-hint span').textContent = t('recorder.editor.dropHint');
renderPlay();

$('#play').addEventListener('click', togglePlay);
$('#set-in').addEventListener('click', setIn);
$('#set-out').addEventListener('click', setOut);
$('#reset-trim').addEventListener('click', () => {
  S.trim = { start: 0, end: S.dur };
  afterTrimChange();
});
$('#open').addEventListener('click', () => kadr.invoke('app:open-path', S.src.file));
$('#reveal').addEventListener('click', () => kadr.invoke('app:reveal', S.src.file));
$('#copy').addEventListener('click', async () => {
  await kadr.invoke('clipboard:write-text', S.src.file);
  toast(t('recorder.result.pathCopied'));
});
$('#delete').addEventListener('click', async () => {
  const ok = await kadr.invoke('app:confirm', { message: t('recorder.result.deleteConfirm'), detail: S.src.name, ok: t('recorder.result.delete'), danger: true });
  if (!ok) return;
  releaseVideo();
  if (await kadr.invoke('recorder:delete')) kadr.invoke('win:close');
  else {
    toast(t('recorder.result.deleteFailed'), 3000);
    attachVideo();
  }
});
$('#file').addEventListener('dragstart', (e) => {
  e.preventDefault();
  kadr.send('image:start-drag', { path: S.src.file });
});
$('#export-new').addEventListener('click', () => doExport('new'));
$('#export-as').addEventListener('click', () => doExport('saveAs'));
$('#export-replace').addEventListener('click', () => doExport('replace'));
$('#export-cancel').addEventListener('click', () => kadr.invoke('recorder:export-cancel'));

// Drop any video file onto the window to edit it instead.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  $('#drop-hint').classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-hint').classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').classList.add('hidden');
  const file = e.dataTransfer?.files?.[0];
  const p = file && kadr.pathForFile(file);
  if (!p || S.exporting) return;
  const info = await kadr.invoke('recorder:editor-open', p);
  if (!info || info.error) return toast(t('recorder.editor.notVideo'), 3000);
  releaseVideo();
  loadSource(info);
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, select, textarea')) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const frame = 1 / (S.src?.fps || 30);
  if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'i' || e.key === 'I' || e.code === 'KeyI') setIn();
  else if (e.key === 'o' || e.key === 'O' || e.code === 'KeyO') setOut();
  else if (e.key === 'ArrowLeft') seek(video.currentTime - (e.shiftKey ? 1 : frame));
  else if (e.key === 'ArrowRight') seek(video.currentTime + (e.shiftKey ? 1 : frame));
  else if (e.key === 'Home') seek(S.trim.start);
  else if (e.key === 'End') seek(S.trim.end);
  else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    doExport(e.shiftKey ? 'saveAs' : 'new');
  } else if (e.key === 'Escape' && !S.exporting) kadr.invoke('win:close');
});

let resizeTimer;
new ResizeObserver(() => {
  layoutCrop();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => S.url && timeline.buildThumbs(S.url, S.src.width / S.src.height), 350);
}).observe($('#stage'));

await loadSource(P);
