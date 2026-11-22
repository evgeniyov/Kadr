'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const atomic = require('../src/main/atomic-file');
const security = require('../src/main/security');
const { sanitizeSpec } = require('../src/main/recording/export-spec');
const plan = require('../src/renderer/recorder/shared/export-plan.mjs');
const root = path.join(__dirname, '..');
function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-regression-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function load(rel, mocks = {}, globals = {}) {
  const file = path.join(root, rel); const localRequire = createRequire(file); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id), module, exports: module.exports, Buffer, console, process, structuredClone, setTimeout, clearTimeout, URL, ...globals }, { filename: file });
  return module.exports;
}
test('selected microphone/system survives sanitization for video and audio export', () => {
  const src = { durationMs: 10000, width: 1280, height: 720, video: 'h264', audio: 'aac' };
  for (const format of ['mp4', 'm4a', 'mp3']) for (const audioTrack of [0, 1, 2]) {
    const spec = sanitizeSpec({ format, audioTrack, speed: 1 });
    assert.equal(spec.audioTrack, audioTrack);
    const args = plan.buildExportArgs(src, spec, 'synthetic.mp4', `synthetic.${format}`).passes[0];
    assert(args.includes(`0:a:${audioTrack}${format === 'mp4' && audioTrack === 0 ? '?' : ''}`));
    if (audioTrack > 0) assert(!args.includes(`0:a:${audioTrack}?`), 'a missing explicitly selected track must fail');
  }
  for (const audioTrack of [-1, NaN, Infinity, '2', 1.5]) assert.equal(sanitizeSpec({ audioTrack }).audioTrack, 0);
});
test('atomic save preserves the original and cleans its temp on failed rename', async (t) => {
  const dir = tmp(t), file = path.join(dir, 'original.png'); fs.writeFileSync(file, 'original', { mode: 0o640 });
  const realRename = fs.promises.rename;
  fs.promises.rename = async () => { throw Object.assign(new Error('synthetic disk error'), { code: 'EIO' }); };
  try { await assert.rejects(atomic.writeFileAtomic(file, 'changed'), { code: 'EIO' }); }
  finally { fs.promises.rename = realRename; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert.deepEqual(fs.readdirSync(dir), ['original.png']);
  await atomic.writeFileAtomic(file, 'changed'); assert.equal(fs.readFileSync(file, 'utf8'), 'changed'); if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});
test('atomic save through a symlink preserves the link and replaces its real destination', async (t) => {
  const dir = tmp(t), file = path.join(dir, 'original'), link = path.join(dir, 'link'); fs.writeFileSync(file, 'before');
  try { fs.symlinkSync(file, link); } catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw e; }
  await atomic.writeFileAtomic(link, 'after'); assert(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.readFileSync(file, 'utf8'), 'after');
});
test('JSON recovery uses the mirror and preserves malformed bytes', (t) => {
  const dir = tmp(t), file = path.join(dir, 'settings.json'); atomic.writeJsonSync(file, { language: 'ru', library: { enabled: false } }); fs.writeFileSync(file, '{broken');
  const recovered = atomic.readJson(file, (v) => !!v && typeof v === 'object' && !Array.isArray(v));
  assert.equal(recovered.recovered, true); assert.equal(recovered.data.language, 'ru'); assert.equal(recovered.data.library.enabled, false);
  assert(fs.readdirSync(dir).some((n) => n.startsWith('settings.json.corrupt-')));
  atomic.writeJsonSync(file, recovered.data); assert.deepEqual(JSON.parse(fs.readFileSync(file)), recovered.data);
});
test('unknown frames, wrong pages, unregistered senders and privileged channels are denied', () => {
  const frame = { url: 'kadr://app/renderer/editor/index.html' }; const wc = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  assert(security.trustedSender({ sender: wc, senderFrame: frame }, { page: 'editor' }));
  assert(!security.trustedSender({ sender: wc, senderFrame: { ...frame } }, { page: 'editor' }));
  assert(!security.trustedSender({ sender: wc, senderFrame: frame }, { page: 'settings' }));
  assert(!security.trustedSender({ sender: wc, senderFrame: frame }, null));
  assert(security.channelAllowed('editor', 'editor:save-original', 'invoke'));
  assert(!security.channelAllowed('editor', 'recorder:chunk', 'invoke'));
  assert(!security.channelAllowed('editor', 'app:trash', 'invoke'));
  assert(!security.channelAllowed('editor', 'app:grant-file', 'invoke'));
  assert(security.channelAllowed('editor', 'app:grant-file', 'send'));
  assert(!security.channelAllowed('overlay', 'settings:set', 'invoke'));
});
test('permissions are limited to known pages, media kinds and local origins', () => {
  const wc = (page) => ({ isDestroyed: () => false, getURL: () => `kadr://app/renderer/${page}/index.html` });
  assert(security.permissionAllowed(wc('recorder/worker'), { page: 'recorder/worker' }, 'media', { mediaTypes: ['audio', 'video'] }));
  assert(security.permissionAllowed(wc('recorder/panel'), { page: 'recorder/panel' }, 'media', { mediaTypes: ['audio'] }));
  assert(!security.permissionAllowed(wc('recorder/panel'), { page: 'recorder/panel' }, 'media', { mediaTypes: ['video'] }));
  for (const permission of ['geolocation', 'notifications', 'bluetooth', 'unknown']) assert(!security.permissionAllowed(wc('editor'), { page: 'editor' }, permission));
  assert(!security.permissionAllowed(wc('recorder/worker'), { page: 'recorder/worker' }, 'media', { requestingOrigin: 'https://example.com' }));
});
test('filenames and extensions cannot escape the output directory or create executable files', () => {
  assert.equal(security.safeBase('../../evil/name'), '-..-evil-name');
  assert.throws(() => security.safeExtension('../js')); assert.throws(() => security.safeExtension('html'));
  assert.equal(security.safeExtension('png'), 'png');
});
test('translation cancellation never opens a browser, explicit acceptance opens exactly once', async () => {
  const calls = []; let response = 1;
  const tr = load('src/main/translate.js', { electron: { shell: { openExternal: (url) => calls.push(url) }, dialog: { showMessageBox: async () => ({ response }) } }, './context': { t: (k) => k, settings: { get: () => 'ru' } } });
  assert.equal(await tr.openWeb('SYNTHETIC TEXT', 'ru'), false); assert.equal(calls.length, 0);
  response = 0; assert.equal(await tr.openWeb('SYNTHETIC TEXT', 'ru'), true); assert.equal(calls.length, 1); assert(calls[0].includes('SYNTHETIC%20TEXT'));
});
function libraryHarness(t, initial = [], nativeOcr = async () => ({ lines: [] }), beforeLoad = () => {}, atomicOverrides = {}) {
  const dir = tmp(t); atomic.writeJsonSync(path.join(dir, 'index.json'), initial);
  for (const it of initial) { fs.writeFileSync(path.join(dir, it.file), 'synthetic-original'); fs.writeFileSync(path.join(dir, it.thumb), 'synthetic-thumb'); }
  beforeLoad(dir);
  const handlers = new Map(); const timers = [];
  const image = { isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), resize() { return this; }, toJPEG: () => Buffer.from('synthetic-thumb') };
  const ctx = { paths: { library: dir }, windowsOfKind: () => [], handle: (k, f) => handlers.set(k, f), on: () => {}, settings: { get: () => ({ maxItems: 1000, keepDays: 0 }) }, dataUrl: (p) => p, modules: { native: { capabilities: () => ({ ocr: true }), ocr: nativeOcr } } };
  const lib = load('src/main/library.js', { electron: { nativeImage: { createFromBuffer: () => image, createFromPath: () => image } }, './clip': {}, './context': ctx, './basics': { toBuffer: (b) => b }, './atomic-file': { ...atomic, ...atomicOverrides } }, { setTimeout: (fn, ms) => { const h = { fn, ms, cancelled: false }; timers.push(h); return h; }, clearTimeout: (h) => { if (h) h.cancelled = true; } });
  lib.register();
  const runOcr = () => timers.filter((h) => h.ms === 1500 && !h.cancelled).at(-1).fn();
  return { lib, ctx, dir, handlers, runOcr, timers };
}
const item = () => ({ id: 'fixture', file: 'fixture.png', thumb: 'fixture.thumb.jpg', text: 'SECRET_OLD', version: 0, created: Date.now() });
test('redaction removes old OCR from search and both disk indexes even when new OCR fails', async (t) => {
  const h = libraryHarness(t, [item()], async () => { throw new Error('synthetic OCR failure'); });
  await h.lib.updateImage('fixture', Buffer.from('redacted'), 0); await h.runOcr(); await h.lib.flush();
  assert.equal(h.handlers.get('library:list')({}, { query: 'SECRET_OLD' }).length, 0);
  for (const name of ['index.json', 'index.json.bak']) assert(!fs.readFileSync(path.join(h.dir, name), 'utf8').includes('SECRET_OLD'));
});
test('a stale OCR result cannot restore private text after a newer image replaces it', async (t) => {
  let finishOld, entered; const started = new Promise((r) => { entered = r; });
  const h = libraryHarness(t, [], async () => { entered(); return new Promise((r) => { finishOld = r; }); });
  h.ctx.newId = () => 'race'; await h.lib.add(Buffer.from('before'));
  const running = h.runOcr(); await started;
  await h.lib.updateImage('race', Buffer.from('redacted'), 0);
  finishOld({ lines: [{ text: 'SECRET_RACE' }] });
  // The queue also contains the newer revision; make it fail instead of publishing old text.
  h.ctx.modules.native.ocr = async () => { throw new Error('synthetic new OCR error'); };
  await running; await h.lib.flush();
  assert.equal(h.handlers.get('library:list')({}, { query: 'SECRET_RACE' }).length, 0);
});
test('concurrent image updates are serialized and their final snapshot matches final pixels', async (t) => {
  const h = libraryHarness(t, [item()]);
  await Promise.all([h.lib.updateImage('fixture', Buffer.from('first'), 0), h.lib.updateImage('fixture', Buffer.from('second'), 1)]);
  await h.lib.flush(); assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'second');
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json'))); assert.equal(saved[0].version, 2); assert.equal(saved[0].text, '');
});
test('a stale library save creates a copy without restoring pixels in the original', async (t) => {
  const legacy = item();
  delete legacy.version;
  const h = libraryHarness(t, [legacy]);
  h.ctx.newId = () => 'separate-copy';
  h.ctx.notify = () => {};
  h.ctx.t = (key) => key;
  const update = h.handlers.get('library:update-image');
  const save = (data) => update({}, { id: legacy.id, baseVersion: 0, data: Buffer.from(data) });
  const [, copy] = await Promise.all([save('redacted'), save('stale pixels')]);
  await h.lib.flush();
  assert.equal(fs.readFileSync(path.join(h.dir, legacy.file), 'utf8'), 'redacted');
  assert.equal(fs.readFileSync(path.join(h.dir, 'separate-copy.png'), 'utf8'), 'stale pixels');
  assert.equal(copy.id, 'separate-copy');
  assert.equal(copy.version, 0);
});

test('a conflict copy preserves its original when the library reaches its retention limit', async (t) => {
  const original = { ...item(), created: Date.now() - 10000 };
  const newer = Array.from({ length: 9 }, (_, i) => {
    const id = `newer-${i}`;
    return { ...item(), id, file: `${id}.png`, thumb: `${id}.thumb.jpg`, created: original.created + i + 1 };
  });
  const h = libraryHarness(t, [original, ...newer]);
  h.ctx.settings.get = () => ({ maxItems: 10, keepDays: 0 });
  h.ctx.newId = () => 'conflict-copy';
  h.ctx.notify = () => {};
  h.ctx.t = (key) => key;
  const update = h.handlers.get('library:update-image');
  const save = (data) => update({}, { id: original.id, baseVersion: 0, data: Buffer.from(data) });
  await save('updated pixels');
  const copy = await save('stale pixels');
  await h.lib.flush();

  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json')));
  assert(saved.some((entry) => entry.id === original.id), 'retention removed the original from the library');
  assert(saved.some((entry) => entry.id === copy.id));
  assert.equal(saved.length, 10);
  assert.equal(fs.readFileSync(path.join(h.dir, original.file), 'utf8'), 'updated pixels');
  assert.equal(fs.readFileSync(path.join(h.dir, `${copy.id}.png`), 'utf8'), 'stale pixels');
  assert.equal(fs.existsSync(path.join(h.dir, newer[0].file)), false);
});

test('reset notifies main and renderer of exactly the changed settings sections', (t) => {
  const dir = tmp(t);
  const messages = [];
  const win = { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } };
  const { Settings } = load('src/main/settings.js', {
    electron: { app: { getPath: () => dir }, BrowserWindow: { getAllWindows: () => [win] } },
  });
  const settings = new Settings();
  t.after(() => clearTimeout(settings._saveTimer));
  let loginItem = false;
  let trayVisible = false;
  const app = Object.assign(new EventEmitter(), {
    getLoginItemSettings: () => ({ openAtLogin: loginItem }),
    setLoginItemSettings: ({ openAtLogin }) => { loginItem = openAtLogin; },
  });
  class Tray extends EventEmitter {
    constructor() { super(); trayVisible = true; }
    setImage() {}
    setToolTip() {}
    setContextMenu() {}
    destroy() { trayVisible = false; }
  }
  const ctx = { settings, paths: { appRoot: dir }, modules: {}, t: (key) => key };
  load('src/main/settings-window.js', { './context': ctx, electron: { app } }).register();
  load('src/main/tray.js', { './context': ctx, './clip': {}, electron: {
    app, Tray, nativeImage: { createFromPath: () => ({}) }, Menu: { buildFromTemplate: () => ({}) },
  } }).register();
  settings.set({ hotkeys: { area: 'Alt+F12' }, launchAtLogin: true, showTrayIcon: false });
  assert.equal(loginItem, true);
  assert.equal(trayVisible, false);
  messages.length = 0;
  let changed;
  settings.once('change', (data, patch) => { changed = { data, patch }; });
  settings.reset();
  assert.deepEqual(Object.keys(changed.patch).sort(), ['hotkeys', 'launchAtLogin', 'showTrayIcon']);
  assert.equal(changed.patch.hotkeys.area, settings.defaults.hotkeys.area);
  assert.equal(changed.patch.launchAtLogin, false);
  assert.equal(changed.patch.showTrayIcon, true);
  assert.deepEqual(messages, [['settings:changed', changed.data, changed.patch]]);
  assert.equal(settings.get('hotkeys.area'), settings.defaults.hotkeys.area);
  assert.equal(loginItem, false);
  assert.equal(trayVisible, true);
});

test('settings patches reject cross-window changes and nested prototype keys', () => {
  security.assertSettingsPatch('editor', { editor: { color: '#fff' }, colorFormat: 'hex' });
  security.assertSettingsPatch('recorder/panel', { recording: { mic: false } });
  assert.throws(() => security.assertSettingsPatch('editor', { launchAtLogin: true }));
  assert.throws(() => security.assertSettingsPatch('overlay', { recording: {} }));
  assert.throws(() => security.assertSettingsPatch('settings', JSON.parse('{"editor":{"__proto__":{"polluted":true}}}')));
  assert.equal({}.polluted, undefined);
});
test('settings restore user preferences from an intact mirror after a truncated primary', (t) => {
  const dir = tmp(t), file = path.join(dir, 'settings.json'); atomic.writeJsonSync(file, { language: 'en', launchAtLogin: false, library: { enabled: false }, recording: { mic: false } }); fs.writeFileSync(file, '{');
  const { Settings } = load('src/main/settings.js', { electron: { app: { getPath: () => dir }, BrowserWindow: { getAllWindows: () => [] } } });
  const settings = new Settings(); assert.equal(settings.get('language'), 'en'); assert.equal(settings.get('library.enabled'), false); assert.equal(settings.get('recording.mic'), false);
  settings.saveNow(); const saved = JSON.parse(fs.readFileSync(file)); assert.equal(saved.library.enabled, false); assert.equal(saved.recording.mic, false);
});
test('preload exposes exact channels and grants only paths obtained from a genuine File', () => {
  let bridge; const sent = [];
  load('src/preload/preload.js', { electron: { contextBridge: { exposeInMainWorld: (_, value) => { bridge = value; } }, ipcRenderer: { send: (...args) => sent.push(args), invoke: () => {}, on: () => {} }, webUtils: { getPathForFile: (file) => { if (file !== 'genuine-fixture') throw new Error('invalid File'); return '/synthetic/genuine.png'; } }, webFrame: {} } }, { process: { platform: 'darwin' } });
  assert.throws(() => bridge.invoke('app:trash', '/synthetic/other')); assert.throws(() => bridge.send('app:grant-file', '/synthetic/other')); assert.throws(() => bridge.invoke('settings:arbitrary'));
  assert.equal(bridge.pathForFile('fake'), ''); assert.equal(sent.length, 0);
  assert.equal(bridge.pathForFile('genuine-fixture'), '/synthetic/genuine.png'); assert.equal(sent[0][0], 'app:grant-file');
});

test('a damaged library primary recovers metadata from the mirror and keeps orphan PNGs', async (t) => {
  const h = libraryHarness(t, [item()], undefined, (dir) => {
    fs.writeFileSync(path.join(dir, 'index.json'), '{truncated');
    fs.writeFileSync(path.join(dir, 'orphan.png'), 'synthetic-orphan');
  });
  const listed = h.handlers.get('library:list')({}, {});
  assert.equal(listed.length, 2); assert(listed.some((it) => it.id === 'fixture')); assert(listed.some((it) => it.id === 'orphan'));
  assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'synthetic-original');
  assert.equal(fs.readFileSync(path.join(h.dir, 'orphan.png'), 'utf8'), 'synthetic-orphan');
  await h.lib.flush(); assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json'))).length, 2);
});
test('two malformed library indexes reconstruct entries without removing image files', async (t) => {
  const h = libraryHarness(t, [item()], undefined, (dir) => {
    fs.writeFileSync(path.join(dir, 'index.json'), '{broken-primary');
    fs.writeFileSync(path.join(dir, 'index.json.bak'), '{broken-backup');
  });
  const listed = h.handlers.get('library:list')({}, {}); assert.equal(listed.length, 1); assert.equal(listed[0].id, 'fixture'); assert.equal(listed[0].text, '');
  assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'synthetic-original');
  assert.equal(fs.readdirSync(h.dir).filter((name) => name.includes('.corrupt-')).length, 2);
  await h.lib.flush(); assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json'))).length, 1);
});
test('an intact older index recovers a capture written immediately before an interrupted index save', async (t) => {
  const h = libraryHarness(t, [item()], undefined, (dir) => {
    fs.writeFileSync(path.join(dir, 'unindexed.png'), 'synthetic-new-capture');
  });
  const listed = h.handlers.get('library:list')({}, {});
  assert.equal(listed.length, 2);
  assert(listed.some((it) => it.id === 'unindexed' && it.source === 'recovered'));
  await h.lib.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json'))).length, 2);
});
test('a failed replacement thumbnail cannot retain the original pixels after redaction', async (t) => {
  const h = libraryHarness(t, [item()], undefined, undefined, { writeFileAtomic: async (file, data) => {
    if (file.endsWith('.thumb.jpg')) throw new Error('synthetic thumbnail write error');
    return atomic.writeFileAtomic(file, data);
  } });
  await assert.rejects(h.lib.updateImage('fixture', Buffer.from('redacted'), 0), /thumbnail write error/);
  assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'redacted');
  assert.equal(fs.existsSync(path.join(h.dir, 'fixture.thumb.jpg')), false);
  for (const name of ['index.json', 'index.json.bak']) assert(!fs.readFileSync(path.join(h.dir, name), 'utf8').includes('SECRET_OLD'));
});
test('a malformed thumbnail alias cannot remove original PNGs during startup recovery', async (t) => {
  const h = libraryHarness(t, [{ ...item(), thumb: 'fixture.png', updating: true }], undefined, (dir) => {
    fs.writeFileSync(path.join(dir, 'fixture.png'), 'synthetic-original');
  });
  assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'synthetic-original');
  const listed = h.handlers.get('library:list')({}, {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].thumb, 'fixture.thumb.jpg');
  assert.equal(fs.readdirSync(h.dir).filter((name) => name.includes('.corrupt-')).length, 2);
  await h.lib.flush();
});
test('startup repairs a missing or interrupted thumbnail from the surviving original', async (t) => {
  for (const updating of [false, true]) {
    const h = libraryHarness(t, [{ ...item(), updating }], undefined, (dir) => {
      if (!updating) fs.unlinkSync(path.join(dir, 'fixture.thumb.jpg'));
    });
    assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'synthetic-original');
    assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.thumb.jpg'), 'utf8'), 'synthetic-thumb');
    await h.lib.flush();
  }
});
for (const channel of ['library:delete', 'library:clear']) test(`${channel} cannot resurrect files when an image update is in flight`, async (t) => {
  let entered, finish;
  const started = new Promise((r) => { entered = r; }); const release = new Promise((r) => { finish = r; });
  const h = libraryHarness(t, [item()], undefined, undefined, { writeFileAtomic: async (file, data) => {
    if (path.basename(file) === 'fixture.png' && data.toString() === 'redacted') { entered(); await release; }
    return atomic.writeFileAtomic(file, data);
  } });
  const updating = h.lib.updateImage('fixture', Buffer.from('redacted'), 0); await started;
  const deleting = h.handlers.get(channel)({}, ['fixture']); await new Promise(setImmediate); finish();
  await Promise.all([updating, deleting]); await h.lib.flush();
  assert.equal(h.handlers.get('library:list')({}, {}).length, 0);
  assert.equal(fs.existsSync(path.join(h.dir, 'fixture.png')), false);
  assert.equal(fs.existsSync(path.join(h.dir, 'fixture.thumb.jpg')), false);
});
test('eight pending image revisions schedule one background OCR timer for the latest version', async (t) => {
  let calls = 0;
  const h = libraryHarness(t, [item()], async () => { calls++; return { lines: [{ text: 'latest' }] }; });
  for (let i = 0; i < 8; i++) await h.lib.updateImage('fixture', Buffer.from(`revision-${i}`), i);
  assert.equal(h.timers.filter((timer) => timer.ms === 1500).length, 1);
  await h.runOcr(); assert.equal(calls, 1); await h.lib.flush();
});
test('stream-copy compatibility uses the selected audio codec of a mixed-codec source', () => {
  const src = { durationMs: 2000, width: 160, height: 90, video: 'h264', audio: 'aac', audioTracks: [{ codec: 'aac' }, { codec: 'opus' }] };
  for (const format of ['mp4', 'm4a']) {
    const sp = sanitizeSpec({ format, audioTrack: 1 }); assert.equal(plan.willStreamCopy(src, sp), false);
    const args = plan.buildExportArgs(src, sp, 'synthetic.mkv', `synthetic.${format}`).passes[0];
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac'); assert(args.includes('0:a:1'));
  }
  assert.equal(plan.willStreamCopy(src, sanitizeSpec({ format: 'mkv', audioTrack: 1 })), true);
});

// Scrolling uses a live desktop video stream in its hidden worker.
test('scroll worker can request video while its controls cannot capture and audio remains denied', () => {
  const wc = { isDestroyed: () => false, getURL: () => 'kadr://app/renderer/scroller/index.html' };
  const worker = { page: 'scroller', params: { role: 'worker' } };
  assert(security.permissionAllowed(wc, worker, 'media', { mediaTypes: ['video'] }));
  assert(security.permissionAllowed(wc, worker, 'media', { mediaType: 'video' }));
  for (const mediaTypes of [['audio'], ['video', 'audio'], [], ['unknown']]) {
    assert(!security.permissionAllowed(wc, worker, 'media', { mediaTypes }));
  }
  for (const role of ['frame', 'panel', undefined]) {
    assert(!security.permissionAllowed(wc, { page: 'scroller', params: { role } }, 'media', { mediaTypes: ['video'] }));
  }
});

test('quit barrier persists a delayed add without starting queued OCR and preserves its timer', async (t) => {
  let entered, release, ocrCalls = 0;
  const started = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const h = libraryHarness(t, [], async () => { ocrCalls++; return { lines: [{ text: 'new OCR' }] }; }, undefined, { writeFileAtomic: async (file, data) => {
    if (path.basename(file) === 'pending.png') { entered(); await gate; }
    return atomic.writeFileAtomic(file, data);
  } });
  const adding = h.lib.add(Buffer.from('synthetic'), {}, { id: 'pending' }); await started;
  let finished = false;
  const quitting = h.lib.flushForQuit().then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 30)); assert.equal(finished, false);
  release(); await Promise.all([adding, quitting]);
  assert.equal(ocrCalls, 0);
  for (const name of ['index.json', 'index.json.bak']) {
    const saved = JSON.parse(fs.readFileSync(path.join(h.dir, name)));
    assert.equal(saved.length, 1); assert.equal(saved[0].id, 'pending'); assert.equal(saved[0].text, '');
  }
  // If closing is cancelled, the original background OCR timer still works.
  assert(h.timers.some((timer) => timer.ms === 1500 && !timer.cancelled));
  await h.runOcr(); await h.lib.flushForQuit();
  assert.equal(ocrCalls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json')))[0].text, 'new OCR');
});
test('quit barrier drains image updates without waiting for slow in-flight OCR', async (t) => {
  let entered, release; const started = new Promise((r) => { entered = r; }); const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const h = libraryHarness(t, [item()], async () => {
    if (++calls === 1) { entered(); await gate; return { lines: [{ text: 'stale OCR' }] }; }
    return { lines: [{ text: 'final OCR' }] };
  });
  await h.lib.updateImage('fixture', Buffer.from('before'), 0);
  const recognizing = h.runOcr(); await started;
  const first = h.lib.updateImage('fixture', Buffer.from('first'), 1);
  const second = h.lib.updateImage('fixture', Buffer.from('second'), 2);
  const quitting = h.lib.flushForQuit();
  let timer;
  try {
    await Promise.race([
      Promise.all([first, second, quitting]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('quit waited for OCR')), 1500); }),
    ]);
    for (const name of ['index.json', 'index.json.bak']) {
      const saved = JSON.parse(fs.readFileSync(path.join(h.dir, name)));
      assert.equal(saved[0].version, 3); assert.equal(saved[0].text, ''); assert.equal(saved[0].updating, undefined);
    }
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(path.join(h.dir, 'fixture.png'), 'utf8'), 'second');
  } finally {
    clearTimeout(timer); release(); await Promise.all([first, second, recognizing, quitting]);
  }
});
test('quit barrier repeats its snapshot when an add starts during the final index write', async (t) => {
  let entered, release; const started = new Promise((r) => { entered = r; }); const gate = new Promise((r) => { release = r; }); let first = true;
  const h = libraryHarness(t, [], undefined, undefined, { writeJson: async (file, data) => {
    if (first) { first = false; entered(); await gate; }
    return atomic.writeJson(file, data);
  } });
  const quitting = (h.lib.flushForQuit || h.lib.flush)(); await started;
  await h.lib.add(Buffer.from('late'), {}, { id: 'late' });
  release(); await quitting;
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.json')))[0]?.id, 'late');
});

test('quit snapshot includes OCR that resolves while the final index is being written', async (t) => {
  let releaseOcr, enteredOcr, releaseWrite, enteredWrite, blockWrite = false;
  const ocrStarted = new Promise((r) => { enteredOcr = r; });
  const ocrGate = new Promise((r) => { releaseOcr = r; });
  const writeStarted = new Promise((r) => { enteredWrite = r; });
  const writeGate = new Promise((r) => { releaseWrite = r; });
  const h = libraryHarness(t, [item()], async () => { enteredOcr(); await ocrGate; return { lines: [{ text: 'resolved OCR' }] }; }, undefined, { writeJson: async (file, data) => {
    if (blockWrite) { blockWrite = false; enteredWrite(); await writeGate; }
    return atomic.writeJson(file, data);
  } });
  await h.lib.updateImage('fixture', Buffer.from('new pixels'), 0);
  const recognizing = h.runOcr(); await ocrStarted;
  blockWrite = true;
  const quitting = h.lib.flushForQuit();
  let timer;
  try {
    await Promise.race([writeStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('snapshot blocked on OCR')), 1500); })]);
    releaseOcr(); await recognizing;
    releaseWrite(); await quitting;
    for (const name of ['index.json', 'index.json.bak']) assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, name)))[0].text, 'resolved OCR');
  } finally {
    clearTimeout(timer); releaseOcr(); releaseWrite(); await Promise.all([recognizing, quitting]);
  }
});
