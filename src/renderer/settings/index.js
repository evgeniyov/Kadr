// Settings window: declarative schema → rows bound to settings keys.
import { initPage, kadr, t, el, $, getSettings, setSettings, formatAccelerator, isMac, toast } from '../../shared/ui.js';

const ICONS = {
  general: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  capture: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  hotkeys: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  recording: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  editor: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
};

const COLOR_FORMATS = [
  ['hex', '#ff3b30'],
  ['HEX', '#FF3B30'],
  ['rgb', 'rgb(255, 59, 48)'],
  ['css-rgba', 'rgba(255, 59, 48, 1)'],
  ['hsl', 'hsl(3, 100%, 59%)'],
  ['swiftui', 'Color(red: 1, green: 0.231, blue: 0.188)'],
  ['uicolor', 'UIColor(red: 1, green: 0.231, …)'],
  ['android', '0xFFFF3B30'],
  ['csharp', 'Color.FromArgb(255, 59, 48)'],
  ['flutter', 'Color(0xFFFF3B30)'],
];

const HOTKEYS = [
  ['settings.group.hotCapture', ['area', 'fullscreen', 'window', 'activeWindow', 'repeatArea', 'scrolling', 'ocr', 'translate', 'colorPicker', 'delayed']],
  ['settings.group.hotRecord', ['record', 'recordStop']],
  ['settings.group.hotOther', ['openClipboard', 'pinClipboard', 'library', 'settings']],
];

// Row builders --------------------------------------------------------------

const get = (key) => key.split('.').reduce((o, k) => o?.[k], getSettings());

function patchFor(key, value) {
  const patch = {};
  const parts = key.split('.');
  let o = patch;
  parts.slice(0, -1).forEach((p) => (o = o[p] = {}));
  o[parts.at(-1)] = value;
  return patch;
}
const set = (key, value) => setSettings(patchFor(key, value));

function row(labelKey, control, hintKey) {
  return el('div.row', el('div.row-label', el('span', t(labelKey)), hintKey ? el('small', t(hintKey)) : null), el('div.row-control', control));
}

function group(titleKey, rows) {
  return el('section.group', titleKey ? el('div.group-title', t(titleKey)) : null, el('div.group-body', rows.filter(Boolean)));
}

function toggle(key) {
  const input = el('input', { type: 'checkbox', checked: !!get(key), onchange: (e) => set(key, e.target.checked) });
  return el('label.switch', input, el('span'));
}

function select(key, options, { numeric = false } = {}) {
  const s = el(
    'select.input',
    { onchange: (e) => set(key, numeric ? Number(e.target.value) : e.target.value) },
    options.map(([v, label]) => el('option', { value: String(v), selected: String(get(key)) === String(v) }, label))
  );
  return s;
}

function segmented(key, options) {
  const wrap = el('div.seg');
  const render = () => {
    wrap.replaceChildren(
      ...options.map(([v, label]) =>
        el('button', { 'aria-pressed': String(get(key)) === String(v) ? 'true' : 'false', onclick: () => set(key, v).then(render) }, label)
      )
    );
  };
  render();
  return wrap;
}

function number(key, { min = 0, max = 100000, step = 1 } = {}) {
  return el('input.input', {
    type: 'number',
    min,
    max,
    step,
    value: get(key),
    onchange: (e) => {
      const v = Math.max(min, Math.min(max, Number(e.target.value) || 0));
      e.target.value = v;
      set(key, v);
    },
  });
}

function range(key, { min, max, step = 1 }) {
  const val = el('span.range-value', String(get(key)));
  const input = el('input', {
    type: 'range',
    min,
    max,
    step,
    value: get(key),
    oninput: (e) => (val.textContent = e.target.value),
    onchange: (e) => set(key, Number(e.target.value)),
  });
  return [input, val];
}

function text(key) {
  return el('input.input', { type: 'text', value: get(key) || '', onchange: (e) => set(key, e.target.value.trim()) });
}

function folder(key) {
  const label = el('span.folder-path', { title: get(key) }, get(key));
  return [
    label,
    el('button.btn', { onclick: () => kadr.invoke('app:open-path', get(key)) }, t('settings.open')),
    el(
      'button.btn',
      {
        onclick: async () => {
          const dir = await kadr.invoke('app:choose-folder', { defaultPath: get(key) });
          if (dir) {
            await set(key, dir);
            label.textContent = dir;
            label.title = dir;
          }
        },
      },
      t('settings.choose')
    ),
  ];
}

// Hotkey recorder ------------------------------------------------------------

let recordingField = null;

function keyToAccelerator(e) {
  const code = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`;
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else
    key = {
      Space: 'Space',
      Enter: 'Enter',
      Tab: 'Tab',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backquote: '`',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      Insert: 'Insert',
      Delete: 'Delete',
      PrintScreen: 'PrintScreen',
    }[code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  const fKey = /^F\d{1,2}$/.test(key) || key === 'PrintScreen';
  if (!mods.length && !fKey) return null;
  if (mods.length === 1 && mods[0] === 'Shift' && !fKey) return null;
  return [...mods, key].join('+');
}

function hotkeyField(name, status) {
  const key = `hotkeys.${name}`;
  const field = el('button.hotkey');
  const paint = () => {
    const acc = get(key);
    field.textContent = acc ? formatAccelerator(acc) : t('settings.hotkeyNone');
    field.classList.toggle('empty', !acc);
    field.classList.toggle('failed', status[name] === 'failed');
    field.title = status[name] === 'failed' ? t('settings.hotkeyTaken') : '';
  };
  const stop = () => {
    field.classList.remove('recording');
    recordingField = null;
    kadr.invoke('app:suspend-hotkeys', false);
    paint();
  };
  field.addEventListener('click', () => {
    if (recordingField && recordingField !== field) recordingField.dispatchEvent(new Event('blur'));
    recordingField = field;
    field.classList.add('recording');
    field.textContent = t('settings.hotkeyPress');
    kadr.invoke('app:suspend-hotkeys', true);
  });
  field.addEventListener('blur', () => field.classList.contains('recording') && stop());
  field.onRecordKey = async (e) => {
    if (!field.classList.contains('recording')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stop();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      await set(key, '');
      return stop();
    }
    const acc = keyToAccelerator(e);
    if (!acc) return;
    // Remove the same shortcut from any other action.
    const all = getSettings().hotkeys;
    const clash = Object.keys(all).find((k) => k !== name && all[k] === acc);
    const patch = { hotkeys: { [name]: acc } };
    if (clash) patch.hotkeys[clash] = '';
    await setSettings(patch);
    stop();
    if (clash) renderTab('hotkeys');
  };
  paint();
  return field;
}

// Buttons don't always keep focus on click (macOS), so listen on the window.
addEventListener(
  'keydown',
  (e) => {
    if (recordingField?.onRecordKey) recordingField.onRecordKey(e);
  },
  true
);

// Tabs ---------------------------------------------------------------------------

async function permissionsGroup() {
  if (!isMac) return null;
  const p = await kadr.invoke('app:permissions');
  // "Allow…" asks macOS for the permission: Kadr then appears in the right System Settings
  // list (and the pane opens), so the user only has to flip the switch.
  const perm = (ok, kind) => [
    el(`span.perm${ok ? '.ok' : ''}`, el('i'), ok ? t('settings.permGranted') : t('settings.permDenied')),
    ok ? null : el('button.btn.primary', { onclick: () => kadr.invoke('app:request-permission', kind) }, t('settings.permRequest')),
  ];
  const node = group('settings.permissions', [
    row('settings.permScreen', perm(p.screen === 'granted', 'screen'), p.screen === 'granted' ? null : 'settings.permScreenHint'),
    row('settings.permAccessibility', perm(p.accessibility, 'accessibility')),
    row('settings.permMic', perm(p.microphone === 'granted', 'microphone')),
  ]);
  node.dataset.perms = JSON.stringify(p);
  return node;
}

// Keep the permission rows live while the user flips switches in System Settings.
setInterval(async () => {
  if (!isMac || currentTab !== 'general') return;
  const old = document.querySelector('[data-perms]');
  if (!old) return;
  const p = await kadr.invoke('app:permissions');
  if (JSON.stringify(p) !== old.dataset.perms) old.replaceWith(await permissionsGroup());
}, 2000);

// Translation of recognised text (macOS on-device models, downloaded once by the system).
async function translateGroup() {
  const status = await kadr.invoke('native:translation-status').catch(() => 'unsupported');
  const langs =
    status === 'installed'
      ? el('span.perm.ok', el('i'), t('settings.translateReady'))
      : status === 'supported'
        ? [
            el('span.perm', el('i'), t('settings.translateMissing')),
            el(
              'button.btn.primary',
              {
                onclick: async (e) => {
                  const button = e.currentTarget;
                  button.disabled = true;
                  try { await kadr.invoke('native:prepare-translation', {}); }
                  catch (error) { console.warn('translation language setup failed', error); toast(t('settings.translateSetupFailed'), 4000); }
                  finally {
                    button.disabled = false;
                    if (currentTab === 'capture') await renderTab('capture');
                  }
                },
              },
              t('settings.translateDownload')
            ),
          ]
        : el('span.faint', t('settings.translateOnline'));
  return group('settings.group.translate', [
    row(
      'settings.translateTo',
      select('translateTo', [
        ['ru', t('settings.language.ru')],
        ['en', t('settings.language.en')],
      ])
    ),
    row('settings.translateLangs', langs, status === 'installed' ? 'settings.translateHint' : null),
  ]);
}

async function micOptions() {
  const opts = [['default', t('settings.rec.micDefault')]];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => opts.push([d.deviceId, d.label || `${t('settings.rec.micDevice')} ${i + 1}`]));
  } catch {
    /* no devices */
  }
  const current = get('recording.micDeviceId');
  if (current && !opts.some(([v]) => v === current)) opts.push([current, current.slice(0, 12)]);
  return opts;
}

const TABS = {
  async general() {
    return [
      group('settings.group.system', [
        row('settings.language', select('language', [['system', t('settings.language.system')], ['ru', t('settings.language.ru')], ['en', t('settings.language.en')]])),
        row('settings.launchAtLogin', toggle('launchAtLogin')),
        row(isMac ? 'settings.showTrayIconMac' : 'settings.showTrayIconWin', toggle('showTrayIcon'), 'settings.showTrayIconHint'),
        isMac ? row('settings.alwaysShowDockIcon', toggle('alwaysShowDockIcon'), 'settings.alwaysShowDockIconHint') : null,
        row('settings.playSound', toggle('playSound')),
        row('settings.deepLinks', toggle('deepLinks'), 'settings.deepLinksHint'),
      ]),
      group('settings.group.after', [
        row(
          'settings.afterCapture',
          select('afterCapture', [
            ['editor', t('settings.afterCapture.editor')],
            ['preview', t('settings.afterCapture.preview')],
            ['none', t('settings.afterCapture.none')],
          ])
        ),
        row('settings.copyAfterCapture', toggle('copyAfterCapture')),
        row('settings.saveAfterCapture', toggle('saveAfterCapture')),
        row('settings.previewTimeout', number('previewTimeout', { min: 0, max: 120 })),
      ]),
      group('settings.group.files', [
        row('settings.saveFolder', folder('saveFolder')),
        row('settings.fileNameTemplate', text('fileNameTemplate'), 'settings.fileNameHint'),
        row('settings.imageFormat', segmented('imageFormat', [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']])),
        row('settings.jpgQuality', range('jpgQuality', { min: 40, max: 100 })),
      ]),
      await permissionsGroup(),
      el('div', { style: { marginTop: '22px' } }, el('button.btn.danger', { onclick: resetAll }, t('settings.reset'))),
    ];
  },

  async capture() {
    return [
      group('settings.group.capture', [row('settings.captureCursor', toggle('captureCursor')), row('settings.detectBlocks', toggle('detectBlocks')), row('settings.downscaleRetina', toggle('downscaleRetina'))]),
      group('settings.group.window', [isMac ? row('settings.windowShadow', toggle('windowCapture.shadow')) : null, row('settings.windowBackdrop', toggle('windowCapture.backdrop'))]),
      group('settings.group.scrolling', [row('settings.scrollAuto', toggle('scrolling.auto')), row('settings.scrollMaxHeight', number('scrolling.maxHeight', { min: 2000, max: 32000, step: 1000 }))]),
      group('settings.group.color', [row('settings.colorFormat', select('colorFormat', COLOR_FORMATS.map(([v, ex]) => [v, ex]))) ]),
      await translateGroup(),
    ];
  },

  async hotkeys() {
    const status = await kadr.invoke('app:hotkey-status');
    return [
      el('p.hint-text', t('settings.hotkeysHint')),
      ...HOTKEYS.map(([title, keys]) => group(title, keys.map((k) => row(`action.${k}`, hotkeyField(k, status))))),
    ];
  },

  async recording() {
    const caps = await kadr.invoke('native:capabilities').catch(() => ({}));
    const sys = toggle('recording.systemAudio');
    if (!caps.systemAudio) sys.querySelector('input').disabled = true;
    return [
      group('settings.group.video', [
        row('settings.rec.format', segmented('recording.format', [['mp4', 'MP4'], ['webm', 'WebM']])),
        row('settings.rec.fps', segmented('recording.fps', [[24, '24'], [30, '30'], [60, '60']])),
        row(
          'settings.rec.quality',
          select('recording.quality', [
            ['low', t('settings.rec.quality.low')],
            ['medium', t('settings.rec.quality.medium')],
            ['high', t('settings.rec.quality.high')],
            ['max', t('settings.rec.quality.max')],
          ])
        ),
        row('settings.rec.countdown', number('recording.countdown', { min: 0, max: 10 })),
      ]),
      group('settings.group.audio', [
        row('settings.rec.mic', toggle('recording.mic')),
        row('settings.rec.micDevice', select('recording.micDeviceId', await micOptions())),
        row('settings.rec.systemAudio', sys, caps.systemAudio ? null : 'settings.rec.systemAudioHint'),
      ]),
      group('settings.group.files', [
        row('settings.rec.saveFolder', folder('recording.saveFolder')),
        row('settings.fileNameTemplate', text('recording.fileNameTemplate'), 'settings.fileNameHint'),
        row(
          'settings.rec.afterRecording',
          select('recording.afterRecording', [
            ['preview', t('settings.rec.after.preview')],
            ['reveal', t('settings.rec.after.reveal')],
            ['none', t('settings.rec.after.none')],
          ])
        ),
      ]),
    ];
  },

  async editor() {
    const PRESETS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#0A84FF', '#5E5CE6', '#FF2D55', '#1D1D1F', '#FFFFFF'];
    const current = () => String(get('editor.color')).toUpperCase();
    const presetWrap = el('div.swatches');
    const paintPresets = () =>
      presetWrap.replaceChildren(
        ...PRESETS.map((c) =>
          el('button.swatch', {
            class: `swatch${current() === c ? ' selected' : ''}`,
            style: { background: c },
            onclick: async () => {
              await set('editor.color', c);
              paintPresets();
            },
          })
        )
      );
    paintPresets();

    const customWrap = el('div.swatches');
    const paintCustom = () => {
      const list = get('editor.customColors') || [];
      const picker = el('input.color-input', {
        type: 'color',
        value: '#0a84ff',
        title: t('settings.addColor'),
        onchange: async (e) => {
          const v = e.target.value.toUpperCase();
          if (!list.includes(v)) await setSettings({ editor: { customColors: [...list, v] } });
          paintCustom();
        },
      });
      customWrap.replaceChildren(
        ...list.map((c) =>
          el(
            'button.swatch',
            { style: { background: c }, title: c },
            el(
              'span.x',
              {
                onclick: async (e) => {
                  e.stopPropagation();
                  await setSettings({ editor: { customColors: list.filter((x) => x !== c) } });
                  paintCustom();
                },
              },
              '×'
            )
          )
        ),
        picker
      );
    };
    paintCustom();

    return [
      group('settings.group.editorBehavior', [row('settings.editor.closeOnCopy', toggle('editor.closeOnCopy'), 'settings.editor.closeOnCopyHint')]),
      group('settings.group.palette', [row('settings.editor.defaultColor', presetWrap), row('settings.editor.customColors', customWrap)]),
    ];
  },

  async library() {
    return [
      group('settings.group.library', [
        row('settings.libraryEnabled', toggle('library.enabled')),
        row('settings.libraryMax', number('library.maxItems', { min: 10, max: 100000, step: 10 })),
        row('settings.libraryKeepDays', number('library.keepDays', { min: 0, max: 3650 })),
      ]),
      el(
        'div',
        { style: { marginTop: '18px', display: 'flex', gap: '8px' } },
        el('button.btn', { onclick: () => kadr.invoke('app:open-library') }, t('settings.openLibrary')),
        el(
          'button.btn.danger',
          {
            onclick: async () => {
              if (await kadr.invoke('app:confirm', { message: t('library.confirmDeleteAll'), ok: t('common.delete'), danger: true })) kadr.invoke('library:clear');
            },
          },
          t('library.deleteAll')
        )
      ),
    ];
  },

  async about() {
    const v = await kadr.invoke('app:version');
    return [
      el(
        'div.about',
        el('img', { src: '../../shared/icon.png', alt: '', onerror: (e) => e.target.remove() }),
        el('h2', 'Kadr'),
        el('p', t('settings.about.version', { v })),
        el('p', t('settings.about.text')),
        el('p', t('settings.about.github'))
      ),
    ];
  },
};

async function resetAll() {
  if (!(await kadr.invoke('app:confirm', { message: t('settings.confirmReset'), danger: true }))) return;
  await kadr.invoke('settings:reset');
  renderTab(currentTab);
}

let currentTab = 'general';
let renderGeneration = 0;

function renderNav() {
  $('#tabs').replaceChildren(
    ...Object.keys(TABS).map((id) =>
      el(
        'button.tab',
        { class: `tab${id === currentTab ? ' active' : ''}`, onclick: () => renderTab(id) },
        el('span', { html: `<svg viewBox="0 0 24 24">${ICONS[id]}</svg>`, style: { display: 'contents' } }),
        t(`settings.tab.${id}`)
      )
    )
  );
}

async function renderTab(id) {
  const generation = ++renderGeneration;
  currentTab = TABS[id] ? id : 'general';
  renderNav();
  $('#title').textContent = t(`settings.tab.${currentTab}`);
  document.title = `${t('settings.title')} — Kadr`;
  const nodes = await TABS[currentTab]();
  if (generation !== renderGeneration) return;
  $('#content').replaceChildren(...nodes.filter(Boolean));
}

const { params } = await initPage({
  onSettings: (s, patch, { langChanged }) => {
    if (langChanged) renderTab(currentTab);
  },
});
kadr.on('settings:tab', (tab) => renderTab(tab));
window.addEventListener('focus', () => { if (currentTab === 'capture') renderTab('capture'); });
renderTab(params.tab || 'general');
