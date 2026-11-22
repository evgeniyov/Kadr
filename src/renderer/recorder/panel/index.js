// Recording source picker: Screen / Window / Area, audio and video options.
import { initPage, t, $, $$, el, kadr, isMac, isWin, setSettings, getSettings, formatAccelerator } from '../../../shared/ui.js';
import { icon } from '../shared/icons.js';

const { params } = await initPage({
  onSettings: (s, patch) => {
    if (patch && 'recording' in patch) renderOptions();
  },
});
const info = await kadr.invoke('recorder:panel-init');
const fakeDevices = !!params.dev?.fakeDevices;
const rs = () => getSettings().recording;

const state = {
  mode: ['screen', 'window', 'region'].includes(params.mode) ? params.mode : rs().lastMode || 'screen',
  screens: null,
  windows: null,
  loading: null,
  sourceError: null,
  displayId: rs().lastDisplayId,
  windowId: null,
  windowName: rs().lastWindowName || '',
  filter: '',
  region: info.lastRegion,
  lastRegion: info.lastRegion,
  perms: info.permissions,
  devices: [],
  starting: false,
};

// ---- small builders ------------------------------------------------------------

function row(iconName, label, control, cls = '') {
  return el(`div.row${cls}`, el('div.row-label', icon(iconName), typeof label === 'string' ? el('span', label) : label), control);
}

function toggle(checked, onChange, { disabled = false } = {}) {
  const input = el('input', { type: 'checkbox', checked: !!checked, disabled, onchange: (e) => onChange(e.target.checked) });
  return el('label.switch', input, el('span'));
}

function seg(options, value, onChange) {
  return el(
    'div.seg.sm',
    options.map(([v, label]) =>
      el('button', { 'aria-pressed': String(String(v) === String(value)), onclick: () => onChange(v) }, label),
    ),
  );
}

const needsScreenPermission = () => isMac && state.perms.screen !== 'granted';

function micPermission() {
  const m = state.perms.microphone;
  if (m === 'granted' || (!isMac && m !== 'denied' && m !== 'restricted')) return 'granted';
  return m === 'not-determined' ? 'prompt' : 'denied';
}

// ---- source area -----------------------------------------------------------------

function renderModes() {
  const labels = { screen: ['screen', 'recorder.mode.screen'], window: ['window', 'recorder.mode.window'], region: ['region', 'recorder.mode.region'] };
  for (const b of $$('#modes button')) {
    const [ic, key] = labels[b.dataset.mode];
    b.replaceChildren(icon(ic), el('span', t(key)));
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
}

function renderSource() {
  const box = $('#source');
  box.dataset.mode = state.mode;
  if (needsScreenPermission()) return box.replaceChildren(permissionCard());
  if (state.mode === 'screen') box.replaceChildren(screensView());
  else if (state.mode === 'window') box.replaceChildren(windowsView());
  else box.replaceChildren(regionView());
}

const loadingView = () => el('div.placeholder', el('span.spinner'), el('span', t('recorder.loading')));
const emptyView = (text, iconName = 'screen') => el('div.placeholder', icon(iconName, 'big'), el('span', text));

function sourceErrorView() {
  if (state.sourceError?.error === 'screen-permission') {
    state.perms.screen = 'denied';
    return permissionCard();
  }
  return emptyView(t('recorder.error.capture', { msg: state.sourceError?.message || '' }), 'warning');
}

function screensView() {
  if (state.sourceError) return sourceErrorView();
  if (!state.screens) return loadingView();
  if (!state.screens.length) return emptyView(t('recorder.screen.empty'));
  const wrap = el(`div.screens${state.screens.length === 1 ? '.single' : ''}`);
  for (const s of state.screens) {
    const selected = String(s.displayId) === String(state.displayId);
    const pick = () => {
      state.displayId = s.displayId;
      renderSource();
    };
    wrap.append(
      el(
        'button.src-card',
        { 'aria-pressed': String(selected), onclick: pick, ondblclick: () => (pick(), start()) },
        el(
          'div.thumb',
          { style: { aspectRatio: String(s.width / s.height) } },
          s.thumbnail ? el('img', { src: s.thumbnail, alt: '', draggable: false }) : icon('screen', 'big'),
          el('span.check', icon('check')),
        ),
        el('div.meta', el('span.name', s.name), s.primary ? el('span.badge', t('recorder.screen.main')) : null),
        el('div.sub', `${s.width} × ${s.height}${s.scaleFactor > 1 ? ` · @${s.scaleFactor}x` : ''}`),
      ),
    );
  }
  return wrap;
}

function windowsView() {
  const grid = el('div.win-grid');
  const search = el('input.input.search', {
    type: 'search',
    placeholder: t('recorder.window.search'),
    value: state.filter,
    oninput: (e) => {
      state.filter = e.target.value;
      renderWindowGrid(grid);
    },
  });
  const refresh = el('button.ibtn', { 'data-tip': t('recorder.window.refresh'), onclick: () => loadSources('window') }, icon('refresh'));
  renderWindowGrid(grid);
  return el('div.windows-view', el('div.win-bar', el('label.search-wrap', icon('search'), search), refresh), grid);
}

function renderWindowGrid(grid) {
  if (state.sourceError) return grid.replaceChildren(sourceErrorView());
  if (!state.windows) return grid.replaceChildren(loadingView());
  if (!state.windows.length) return grid.replaceChildren(emptyView(t('recorder.window.empty'), 'window'));
  const q = state.filter.trim().toLowerCase();
  const list = q ? state.windows.filter((w) => w.name.toLowerCase().includes(q)) : state.windows;
  if (!list.length) return grid.replaceChildren(emptyView(t('recorder.window.noMatch'), 'search'));
  grid.replaceChildren(
    ...list.map((w) => {
      const pick = () => {
        state.windowId = w.id;
        state.windowName = w.name;
        renderWindowGrid(grid);
        renderFooter();
      };
      return el(
        'button.src-card.win-card',
        { 'aria-pressed': String(w.id === state.windowId), title: w.name, onclick: pick, ondblclick: () => (pick(), start()) },
        el('div.thumb', el('img', { src: w.thumbnail, alt: '', draggable: false }), w.appIcon ? el('img.app-icon', { src: w.appIcon, alt: '' }) : null, el('span.check', icon('check'))),
        el('div.meta', el('span.name', w.name)),
      );
    }),
  );
}

const sameRegion = (a, b) => a && b && ['displayId', 'x', 'y', 'width', 'height'].every((k) => String(a[k]) === String(b[k]));

function regionView() {
  const r = state.region;
  const last = state.lastRegion && !sameRegion(state.lastRegion, r) ? state.lastRegion : null;
  const useLast = last && el('button.btn', { onclick: () => ((state.region = last), renderSource(), renderFooter()) }, t('recorder.region.useLast'));
  if (!r) {
    return el(
      'div.region-empty',
      icon('region', 'big'),
      el('p.muted', t('recorder.region.hint')),
      el('div.actions', el('button.btn.primary', { onclick: selectRegion }, t('recorder.region.select')), useLast),
    );
  }
  // Miniature of the display with the area highlighted.
  const maxW = 220;
  const maxH = 138;
  const k = Math.min(maxW / r.displayWidth, maxH / r.displayHeight);
  const pct = (v, total) => `${(v / total) * 100}%`;
  const map = el(
    'div.minimap',
    { style: { width: `${Math.round(r.displayWidth * k)}px`, height: `${Math.round(r.displayHeight * k)}px` } },
    el('div.minirect', { style: { left: pct(r.x, r.displayWidth), top: pct(r.y, r.displayHeight), width: pct(r.width, r.displayWidth), height: pct(r.height, r.displayHeight) } }),
  );
  const px = r.scaleFactor > 1 ? el('div.faint.small', `${Math.round(r.width * r.scaleFactor)} × ${Math.round(r.height * r.scaleFactor)} px`) : null;
  return el(
    'div.region-view',
    map,
    el(
      'div.region-info',
      sameRegion(r, state.lastRegion) ? el('div.eyebrow', t('recorder.region.last')) : null,
      el('div.region-size', `${r.width} × ${r.height}`),
      el('div.muted', t('recorder.region.onDisplay', { name: r.displayName })),
      px,
      el('div.actions', el('button.btn', { onclick: selectRegion }, icon('region'), el('span', t('recorder.region.reselect'))), useLast),
    ),
  );
}

function permissionCard() {
  const recheck = async () => {
    state.perms = await kadr.invoke('app:permissions');
    state.sourceError = null;
    refreshAll();
  };
  return el(
    'div.perm',
    icon('shield', 'big'),
    el('div.perm-title', t('recorder.perm.screenTitle')),
    el('div.muted.perm-body', t('recorder.perm.screenBody')),
    el(
      'div.actions',
      el('button.btn.primary', { onclick: () => kadr.invoke('app:request-permission', 'screen-settings') }, t('recorder.perm.openSettings')),
      el('button.btn', { onclick: async () => ((state.perms = await kadr.invoke('recorder:request-screen-access')), refreshAll()) }, t('recorder.perm.request')),
      el('button.btn', { onclick: recheck }, t('recorder.perm.recheck')),
    ),
  );
}

async function loadSources(kind) {
  if (needsScreenPermission()) return renderSource();
  state.loading = kind;
  if (kind === 'window') state.windows = null;
  state.sourceError = null;
  renderSource();
  const res = await kadr.invoke('recorder:sources', kind);
  state.loading = null;
  if (!Array.isArray(res)) state.sourceError = res || { error: 'capture' };
  else if (kind === 'window') {
    state.windows = res;
    if (!res.some((w) => w.id === state.windowId)) state.windowId = res.find((w) => w.name === state.windowName)?.id || null;
  } else {
    state.screens = res;
    if (!res.some((s) => String(s.displayId) === String(state.displayId))) state.displayId = (res.find((s) => s.primary) || res[0])?.displayId ?? null;
  }
  if (state.mode === kind || (kind === 'screen' && state.mode === 'screen')) renderSource();
  renderFooter();
}

async function selectRegion() {
  hideAlert();
  const r = await kadr.invoke('recorder:select-region');
  if (r) state.region = r;
  if (state.mode !== 'region') state.mode = 'region';
  renderModes();
  renderSource();
  renderFooter();
}

function setMode(mode, { fromUser = true } = {}) {
  if (!['screen', 'window', 'region'].includes(mode)) return;
  state.mode = mode;
  hideAlert();
  renderModes();
  renderSource();
  renderFooter();
  if (mode === 'screen' && !state.screens) loadSources('screen');
  if (mode === 'window') loadSources('window');
  if (mode === 'region' && !state.region && fromUser && !needsScreenPermission()) selectRegion();
}

// ---- audio & video options ---------------------------------------------------------

const FAKE_DEVICES = [
  { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Pro Microphone' },
  { deviceId: 'mic-usb', kind: 'audioinput', label: 'Shure MV7' },
  { deviceId: 'mic-airpods', kind: 'audioinput', label: '' },
];

async function refreshDevices() {
  try {
    const list = fakeDevices ? FAKE_DEVICES : await navigator.mediaDevices.enumerateDevices();
    state.devices = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  } catch {
    state.devices = [];
  }
  renderAudio();
}

function deviceSelect() {
  const current = rs().micDeviceId || 'default';
  const sel = el('select.input.device', {
    onchange: (e) => setSettings({ recording: { micDeviceId: e.target.value } }),
  });
  if (!state.devices.some((d) => d.deviceId === 'default')) sel.append(el('option', { value: 'default' }, t('recorder.audio.micDefault')));
  let n = 0;
  for (const d of state.devices) {
    let label = d.label;
    if (d.deviceId === 'default') label = label ? `${t('recorder.audio.micDefault')} — ${label.replace(/^[^-–—]+[-–—]\s*/, '')}` : t('recorder.audio.micDefault');
    else if (!label) label = t('recorder.audio.micUnnamed', { n: ++n });
    sel.append(el('option', { value: d.deviceId }, label));
  }
  sel.value = [...sel.options].some((o) => o.value === current) ? current : 'default';
  return sel;
}

async function requestMic() {
  if (isMac) {
    if (micPermission() === 'prompt') await kadr.invoke('app:request-permission', 'microphone');
    else await kadr.invoke('app:request-permission', 'microphone-settings');
  } else {
    await kadr.invoke('recorder:open-privacy', 'microphone');
  }
  state.perms = await kadr.invoke('app:permissions');
  refreshDevices();
}

function renderAudio() {
  const s = rs();
  const box = $('#audio');
  const nodes = [el('div.group-title', t('recorder.audio.title'))];
  nodes.push(row('mic', t('recorder.audio.mic'), toggle(s.mic, (v) => setSettings({ recording: { mic: v } }))));
  if (s.mic) {
    if (micPermission() === 'granted') {
      nodes.push(el('div.mic-sub', deviceSelect(), el('div.meter#meter', el('i'))));
    } else {
      const label = micPermission() === 'prompt' ? t('recorder.audio.micAllow') : t('recorder.audio.micSettings');
      nodes.push(el('div.mic-sub.noaccess', icon('warning'), el('span', t('recorder.audio.micNoAccess')), el('button.btn.sm', { onclick: requestMic }, label)));
    }
  }
  const sys = info.systemAudio;
  const sysLabel = el('div.label2', el('span', t('recorder.audio.system')), el('span.faint.small', t('recorder.audio.systemHint')));
  const sysRow = row('speaker', sysLabel, toggle(sys.supported && s.systemAudio, (v) => setSettings({ recording: { systemAudio: v } }), { disabled: !sys.supported }), '.tall');
  if (!sys.supported) {
    sysRow.classList.add('disabled', 'long-tip');
    sysRow.dataset.tip = t(sys.reason);
    sysRow.dataset.tipPos = 'top';
  }
  nodes.push(sysRow);
  box.replaceChildren(...nodes);
  syncMeter();
}

function renderVideo() {
  const s = rs();
  const set = (k) => (v) => setSettings({ recording: { [k]: v } });
  const quality = el(
    'select.input.sm',
    { onchange: (e) => set('quality')(e.target.value) },
    ['low', 'medium', 'high', 'max'].map((q) => el('option', { value: q, selected: q === s.quality }, t(`recorder.quality.${q}`))),
  );
  const cursor = row('cursor', t('recorder.options.cursor'), toggle(true, () => {}, { disabled: !info.cursorControl }));
  if (!info.cursorControl) {
    cursor.classList.add('disabled', 'long-tip');
    cursor.dataset.tip = t('recorder.options.cursorAlways');
    cursor.dataset.tipPos = 'top';
  }
  $('#video').replaceChildren(
    el('div.group-title', t('recorder.options.title')),
    row('film', t('recorder.options.format'), seg([['mp4', 'MP4'], ['webm', 'WebM']], s.format, set('format'))),
    row('gauge', t('recorder.options.fps'), seg([[24, '24'], [30, '30'], [60, '60']], s.fps, (v) => set('fps')(Number(v)))),
    row('quality', t('recorder.options.quality'), quality),
    row(
      'timer',
      t('recorder.options.countdown'),
      seg(
        [[0, t('recorder.options.off')], ...[3, 5, 10].map((n) => [n, t('recorder.options.seconds', { n })])],
        s.countdown,
        (v) => set('countdown')(Number(v)),
      ),
    ),
    cursor,
  );
}

function renderOptions() {
  renderAudio();
  renderVideo();
}

// ---- microphone level meter ------------------------------------------------------------

let meter = null; // { deviceId, stream, ctx, raf, token }

function setLevel(peak) {
  const db = peak > 0 ? 20 * Math.log10(peak) : -100;
  $('#meter')?.style.setProperty('--level', Math.max(0, Math.min(1, (db + 60) / 60)).toFixed(3));
}

function stopMeter() {
  if (!meter) return;
  cancelAnimationFrame(meter.raf);
  clearInterval(meter.timer);
  meter.stream?.getTracks().forEach((tr) => tr.stop());
  meter.ctx?.close().catch(() => {});
  meter = null;
  setLevel(0);
}

async function syncMeter() {
  const s = rs();
  const want = s.mic && micPermission() === 'granted' && !state.starting && document.visibilityState === 'visible';
  const deviceId = s.micDeviceId || 'default';
  if (!want) return stopMeter();
  if (meter?.deviceId === deviceId) return;
  stopMeter();
  const m = (meter = { deviceId });
  if (fakeDevices) {
    let ph = 0;
    m.timer = setInterval(() => setLevel(0.08 + 0.3 * Math.abs(Math.sin((ph += 0.35)))), 60);
    return;
  }
  try {
    const constraints = deviceId === 'default' ? true : { deviceId: { exact: deviceId } };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    if (meter !== m) return stream.getTracks().forEach((tr) => tr.stop());
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let smooth = 0;
    Object.assign(m, { stream, ctx });
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      smooth = Math.max(peak, smooth * 0.9);
      setLevel(smooth);
      m.raf = requestAnimationFrame(loop);
    };
    loop();
    if (state.devices.some((d) => !d.label)) refreshDevices(); // labels become available now
  } catch (e) {
    console.warn('mic preview failed', e.name, e.message);
    if (meter === m) meter = null;
  }
}

// ---- footer, errors, start ----------------------------------------------------------------

function canStart() {
  if (state.starting || needsScreenPermission()) return false;
  if (state.mode === 'window') return !!state.windowId;
  if (state.mode === 'region') return !!state.region;
  return state.screens ? state.screens.length > 0 : true;
}

function renderFooter() {
  const hk = info.hotkeys.recordStop || info.hotkeys.record;
  $('#hint').textContent = hk ? t('recorder.stopHint', { key: formatAccelerator(hk) }) : t('recorder.stopHintMenu');
  const btn = $('#start');
  btn.disabled = !canStart();
  btn.classList.toggle('busy', state.starting);
  $('#start-label').textContent = t(state.starting ? 'recorder.starting' : 'recorder.start');
}

function hideAlert() {
  $('#alert').classList.add('hidden');
}

function showAlert(message, actions = []) {
  const box = $('#alert');
  box.replaceChildren(
    icon('warning', 'alert-icon'),
    el('div.alert-body', el('div.alert-title', t('recorder.error.title')), el('div.alert-text', message)),
    ...actions.map(([label, fn, primary]) => el(`button.btn.sm${primary ? '.primary' : ''}`, { onclick: fn }, label)),
    el('button.ibtn.alert-close', { onclick: hideAlert }, icon('close')),
  );
  box.classList.remove('hidden');
}

function showStartError(res) {
  const code = res?.error;
  const msg = res?.message || '';
  const openMicSettings = () => (isWin ? kadr.invoke('recorder:open-privacy', 'microphone') : kadr.invoke('app:request-permission', 'microphone-settings'));
  switch (code) {
    case 'cancelled':
      return;
    case 'screen-permission':
      state.perms.screen = 'denied';
      renderSource();
      renderFooter();
      return showAlert(t('recorder.perm.screenTitle'));
    case 'mic-permission':
      return showAlert(t('recorder.perm.micBody'), [
        [t('recorder.audio.micSettings'), openMicSettings],
        [t('recorder.error.withoutMic'), () => start({ mic: false }), true],
      ]);
    case 'mic':
      return showAlert(t('recorder.error.mic', { msg }), [[t('recorder.error.withoutMic'), () => start({ mic: false }), true]]);
    case 'system-audio':
      return showAlert(t('recorder.error.systemAudio', { msg }), [[t('recorder.error.withoutSystem'), () => start({ systemAudio: false }), true]]);
    case 'encoder':
      return showAlert(t('recorder.error.encoder', { msg }));
    case 'timeout':
      return showAlert(t('recorder.error.timeout'));
    case 'window-gone':
      loadSources('window');
      return showAlert(t('recorder.error.windowGone'));
    case 'display-gone':
      state.screens = null;
      loadSources('screen');
      return showAlert(t('recorder.error.displayGone'));
    case 'no-region':
      return showAlert(t('recorder.error.noRegion'), [[t('recorder.region.select'), selectRegion, true]]);
    case 'no-source':
      return showAlert(t('recorder.error.noSource'));
    case 'busy':
      return showAlert(t('recorder.error.busy'));
    default:
      return showAlert(t('recorder.error.capture', { msg: msg || code || '?' }));
  }
}

async function start(overrides = {}) {
  if (!canStart()) {
    if (state.mode === 'region' && !state.region) return selectRegion();
    return;
  }
  hideAlert();
  const s = rs();
  const opts = {
    mode: state.mode,
    fps: s.fps,
    format: s.format,
    quality: s.quality,
    countdown: s.countdown,
    mic: s.mic,
    micDeviceId: s.micDeviceId,
    systemAudio: info.systemAudio.supported && s.systemAudio,
    ...overrides,
  };
  if (state.mode === 'screen') opts.displayId = state.displayId;
  if (state.mode === 'window') Object.assign(opts, { sourceId: state.windowId, windowName: state.windowName });
  if (state.mode === 'region') {
    const { displayId, x, y, width, height } = state.region;
    opts.region = { displayId, x, y, width, height };
  }
  state.starting = true;
  stopMeter(); // release the microphone before the recorder opens it
  renderFooter();
  document.body.classList.add('starting');
  let res;
  try {
    res = await kadr.invoke('recorder:start', opts);
  } catch (e) {
    res = { error: 'capture', message: e.message };
  }
  if (res?.ok) return; // main closes this window
  state.starting = false;
  document.body.classList.remove('starting');
  renderFooter();
  syncMeter();
  showStartError(res);
}

// ---- wiring ---------------------------------------------------------------------------------

function refreshAll() {
  renderModes();
  renderSource();
  renderOptions();
  renderFooter();
  if (state.mode === 'window') loadSources('window');
  else loadSources('screen');
}

$('#close').append(icon('close'));
$('#close').addEventListener('click', () => kadr.invoke('win:close'));
$('#start').addEventListener('click', () => start());
for (const b of $$('#modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));

window.addEventListener('keydown', (e) => {
  const typing = e.target.matches?.('input[type=search], input[type=text]');
  if (e.key === 'Escape') {
    if (typing && e.target.value) return;
    e.preventDefault();
    kadr.invoke('win:close');
  } else if (e.key === 'Enter' && !e.target.matches?.('button, select')) {
    e.preventDefault();
    start();
  } else if ((isMac ? e.metaKey : e.ctrlKey) && ['1', '2', '3'].includes(e.key)) {
    e.preventDefault();
    setMode(['screen', 'window', 'region'][Number(e.key) - 1]);
  }
});

// The user may come back from System Settings with new permissions.
window.addEventListener('focus', async () => {
  const perms = await kadr.invoke('app:permissions');
  if (perms.microphone === state.perms.microphone && perms.screen === state.perms.screen) return;
  const wasBlocked = needsScreenPermission();
  state.perms = perms;
  if (wasBlocked && !needsScreenPermission()) refreshAll();
  else renderAudio();
});
document.addEventListener('visibilitychange', syncMeter);
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
kadr.on('recorder:panel-mode', (mode) => setMode(mode));
window.addEventListener('beforeunload', stopMeter);

renderModes();
renderSource();
renderOptions();
renderFooter();
refreshDevices();
if (state.mode === 'window') loadSources('window');
else if (!needsScreenPermission()) loadSources('screen');
if (state.mode === 'region' && !state.region && !needsScreenPermission()) selectRegion();
