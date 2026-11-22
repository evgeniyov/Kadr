'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const activate = require('../src/main/activate');

function document(page, { visible = true, minimized = false, focused = false, destroyed = false } = {}) {
  const calls = [];
  const win = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
    restore() { calls.push('restore'); minimized = false; visible = true; },
    show() { calls.push('show'); visible = true; },
    focus() { calls.push('focus'); focused = true; },
  };
  return { page, win, calls };
}
function harness(entries = []) {
  let settingsOpened = 0;
  const ctx = {
    registry: new Map(entries.map((entry, i) => [i, entry])),
    modules: { settingsWindow: { open() { settingsOpened++; return 'settings'; } } },
  };
  return { ctx, settingsOpened: () => settingsOpened };
}
for (const page of ['editor', 'recorder/editor', 'library', 'settings']) {
  test(`activation reuses visible ${page} without opening Settings`, () => {
    const entry = document(page);
    const h = harness([entry]);
    assert.equal(activate(h.ctx), entry.win);
    assert.deepEqual(entry.calls, ['show', 'focus']);
    assert.equal(h.settingsOpened(), 0);
  });
  test(`activation restores minimized ${page} even when isVisible is false`, () => {
    const entry = document(page, { visible: false, minimized: true });
    const h = harness([entry]);
    assert.equal(activate(h.ctx), entry.win);
    assert.deepEqual(entry.calls, ['restore', 'show', 'focus']);
    assert.equal(h.settingsOpened(), 0);
  });
}
test('hidden prepared editor and visible overlays/toolbars are never activated', () => {
  const entries = [document('editor', { visible: false }), ...['overlay', 'pin', 'recorder/toolbar'].map((p) => document(p))];
  const h = harness(entries);
  assert.equal(activate(h.ctx), 'settings');
  assert.equal(h.settingsOpened(), 1);
  entries.forEach((entry) => assert.deepEqual(entry.calls, []));
});
test('hidden prepared editor is skipped in favor of an existing video document', () => {
  const hidden = document('editor', { visible: false });
  const video = document('recorder/editor');
  const h = harness([hidden, video]);
  assert.equal(activate(h.ctx), video.win);
  assert.deepEqual(hidden.calls, []);
  assert.equal(h.settingsOpened(), 0);
});
test('activation preserves the focused document and otherwise prefers visible over minimized', () => {
  const minimized = document('editor', { visible: false, minimized: true });
  const visible = document('library');
  const focused = document('recorder/editor', { focused: true });
  assert.equal(activate(harness([minimized, visible, focused]).ctx), focused.win);
  assert.deepEqual(visible.calls, []);
  assert.equal(activate(harness([minimized, visible]).ctx), visible.win);
  assert.deepEqual(minimized.calls, []);
});
test('no documents or destroyed documents fall back to Settings', () => {
  const destroyed = document('editor', { destroyed: true });
  destroyed.win.isVisible = () => assert.fail('must not query a destroyed window');
  for (const entries of [[], [destroyed]]) {
    const h = harness(entries);
    assert.equal(activate(h.ctx), 'settings');
    assert.equal(h.settingsOpened(), 1);
  }
  assert.deepEqual(destroyed.calls, []);
});
test('activation before Settings is registered is harmless', () => {
  const h = harness();
  h.ctx.modules = {};
  assert.equal(activate(h.ctx), undefined);
});
test('entry-point callbacks activate documents and preserve file/deep-link routing', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const handlers = new Map();
  const entry = document('editor');
  const h = harness([entry]);
  const files = [], urls = [];
  // Evaluate the actual event registrations without starting Electron or accessing user files.
  const start = source.indexOf("app.on('second-instance'");
  const end = source.indexOf('app.whenReady()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    app: { on: (event, handler) => handlers.set(event, handler) },
    activate, ctx: h.ctx,
    filesFromArgv: (argv) => argv.filter((a) => a.endsWith('.png')),
    handleFile: (file) => files.push(file), handleUrl: (url) => urls.push(url),
  });
  handlers.get('activate')();
  handlers.get('second-instance')({}, ['kadr']);
  assert.deepEqual(entry.calls, ['show', 'focus', 'show', 'focus']);
  assert.equal(h.settingsOpened(), 0);
  handlers.get('second-instance')({}, ['kadr', '/synthetic/image.png']);
  handlers.get('second-instance')({}, ['kadr', 'kadr://capture']);
  assert.deepEqual(files, ['/synthetic/image.png']);
  assert.deepEqual(urls, ['kadr://capture']);
  assert.equal(entry.calls.length, 4, 'file/URL launches must not also activate a document');
});
