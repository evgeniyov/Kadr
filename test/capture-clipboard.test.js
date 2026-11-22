'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function load(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative);
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
    console, process, Buffer, Blob,
  }, { filename });
  return module.exports;
}

function captureClipboardHarness({ store, write }) {
  const handlers = {};
  const clip = load('src/main/clip.js', { electron: {
    ClipboardItem: class { constructor(data) { this.data = data; } },
    clipboard: { async write([item]) { await write(await item.data['image/png'].text()); } },
  } });
  const ctx = {
    settings: { get: (key) => key ? undefined : { library: { enabled: true }, afterCapture: 'editor', copyAfterCapture: true } },
    handle: (channel, fn) => { handlers[channel] = fn; }, on() {}, newId: () => 'fixture',
    modules: {
      library: { pathFor: () => '/synthetic/fixture.png', add: store },
      editor: { hasPrepared: () => true, openEditor: () => ({ isDestroyed: () => false, isVisible: () => true }) },
    },
  };
  const mocks = { './context': ctx, './clip': clip, electron: {} };
  load('src/main/basics.js', mocks).register();
  const capture = load('src/main/capture.js', mocks);
  return {
    capture: () => capture.deliver({
      getSize: () => ({ width: 10, height: 10 }), toBitmap: () => Buffer.from('pixels'), toPNG: () => Buffer.from('original'),
    }, {}, {}, { usePrepared: true }),
    copy: () => handlers['clipboard:write-image']({}, Buffer.from('edited')),
  };
}

test('a manual editor copy supersedes the automatic copy waiting for the capture to be stored', async () => {
  const entered = deferred(), stored = deferred(), writes = [];
  const h = captureClipboardHarness({
    store: () => { entered.resolve(); return stored.promise; },
    write: async (image) => { writes.push(image); },
  });
  const delivery = h.capture();
  await entered.promise;
  await h.copy();
  stored.resolve();
  await delivery;
  assert.deepEqual(writes, ['edited']);
  await h.capture();
  assert.deepEqual(writes, ['edited', 'original']);
});

test('a manual editor copy finishes after an automatic clipboard write already in progress', async () => {
  const entered = deferred(), release = deferred(), writes = [];
  const h = captureClipboardHarness({
    store: async () => {},
    write: async (image) => {
      if (image === 'original') { entered.resolve(); await release.promise; }
      writes.push(image);
    },
  });
  const delivery = h.capture();
  await entered.promise;
  const copying = h.copy();
  await new Promise(setImmediate);
  release.resolve();
  await Promise.all([delivery, copying]);
  assert.deepEqual(writes, ['original', 'edited']);
});
