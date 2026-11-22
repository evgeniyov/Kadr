'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
function harness() {
  const entries = new Map(), handlers = new Map();
  const prompts = [], messages = [];
  let response = 2;
  const ctx = {
    paths: { userData: '/synthetic' }, settings: { get() {}, registerDefaults() {} },
    dataUrl: (p) => `kadr://data/${p}`, entryFor: (wc) => entries.get(wc.id),
    handle: (channel, fn) => handlers.set(channel, fn),
    createWindow: (kind, { params }) => {
      const win = new EventEmitter();
      win.webContents = Object.assign(new EventEmitter(), {
        id: entries.size + 1, setVisualZoomLevelLimits: async () => {}, setWindowOpenHandler() {},
        send: (channel) => messages.push(channel),
      });
      let destroyed = false;
      Object.assign(win, {
        isDestroyed: () => destroyed, setMinimumSize() {}, setContentBounds() {}, setTitle() {}, show() {}, focus() {},
        close() {
          let prevented = false;
          win.emit('close', { preventDefault: () => { prevented = true; } });
          if (prevented) return;
          destroyed = true;
          win.emit('closed');
        },
      });
      entries.set(win.webContents.id, { kind, params, win });
      return win;
    },
    t: (key) => key,
  };
  const electron = {
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    BrowserWindow: { fromWebContents: (wc) => entries.get(wc.id)?.win },
    dialog: { async showMessageBox(win) { prompts.push(win); return { response }; } },
  };
  const mocks = { fs: { existsSync: () => false }, path, electron, './context': ctx, './atomic-file': {} };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/editor.js'), 'utf8'), { module, require: (id) => { assert(Object.hasOwn(mocks, id), id); return mocks[id]; }, process, Buffer, setTimeout() {} });
  module.exports.register();
  return { editor: module.exports, entries, handlers, prompts, messages, respondWith: (value) => { response = value; } };
}
for (const early of [true, false]) test(`prepared capture supplies pixels to ${early ? 'early' : 'late'} params request before PNG exists`, async () => {
  const h = harness(); h.editor.prepareEditor();
  const entry = [...h.entries.values()][0];
  const earlyRequest = early ? entry.params : null;
  const pixels = { width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) };
  h.editor.openEditor({ imagePath: '/synthetic/not-yet-written.png', pixels, usePrepared: true });
  const received = await (early ? earlyRequest : entry.params);
  assert.equal(received.pixels, pixels);
  assert.equal(received.imagePath, '/synthetic/not-yet-written.png');
  h.handlers.get('editor:ready')({ sender: entry.win.webContents });
  assert.equal(entry.params.pixels, undefined, 'release the retained raw buffer after renderer has loaded it');
});

test('a dirty prepared capture can cancel, save, or discard when closing', async () => {
  const h = harness();
  h.editor.prepareEditor();
  const pixels = { width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) };
  const win = h.editor.openEditor({ imagePath: '/synthetic/capture.png', pixels, usePrepared: true });
  const event = { sender: win.webContents };
  h.handlers.get('editor:dirty')(event, true);
  win.close();
  win.close(); // repeated close requests share one dialog
  await new Promise(setImmediate);
  assert.equal(win.isDestroyed(), false);
  assert.equal(h.prompts.length, 1);
  await assert.rejects(h.handlers.get('editor:save-original')(event, { data: pixels.data }), /not editing a file/);

  h.respondWith(0);
  win.close();
  await new Promise(setImmediate);
  assert.deepEqual(h.messages, ['editor:save-and-close']);
  assert.equal(win.isDestroyed(), false);

  h.handlers.get('editor:close-save-finished')(event, false);
  h.respondWith(1);
  win.close();
  await new Promise(setImmediate);
  assert.equal(win.isDestroyed(), true);
});

test('a pending close-save blocks repeated closes and a failed save allows another try', async () => {
  const h = harness();
  h.editor.prepareEditor();
  const pixels = { width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) };
  const win = h.editor.openEditor({ imagePath: '/synthetic/capture.png', pixels, usePrepared: true });
  const event = { sender: win.webContents };
  const setDirty = h.handlers.get('editor:dirty');
  h.respondWith(0);
  setDirty(event, true);

  win.close();
  await new Promise(setImmediate);
  win.close();
  await new Promise(setImmediate);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.messages, ['editor:save-and-close']);
  assert.equal(win.isDestroyed(), false);

  const finish = h.handlers.get('editor:close-save-finished');
  finish(event, false);
  assert.equal(win.isDestroyed(), false);
  win.close();
  await new Promise(setImmediate);
  assert.equal(h.prompts.length, 2);
  assert.deepEqual(h.messages, ['editor:save-and-close', 'editor:save-and-close']);

  setDirty(event, false);
  win.close();
  assert.equal(win.isDestroyed(), false);
  finish(event, true);
  assert.equal(win.isDestroyed(), true);
});
