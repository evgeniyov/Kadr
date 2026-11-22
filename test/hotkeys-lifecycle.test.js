'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function harness() {
  const handlers = new Map(), registered = new Map(), errors = [];
  let keys = { area: 'Control+Shift+2' };
  const settings = new EventEmitter(); settings.get = () => keys;
  const ctx = { settings, handle: (name, handler) => handlers.set(name, handler), t: (k) => k,
    notify() {}, modules: { capture: { start: async () => {} } } };
  const module = { exports: {} };
  const mocks = { './context': ctx, electron: { globalShortcut: {
    register: (key, fn) => { if (key === 'taken') return false; registered.set(key, fn); return true; },
    unregister: (key) => registered.delete(key),
  } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/main/hotkeys.js'), 'utf8'), {
    module, exports: module.exports, require: (name) => mocks[name], process: { argv: [] },
    console: { error: (...args) => errors.push(args) },
  });
  module.exports.register();
  return { ctx, registered, errors, handlers, change(patch) { keys = { ...keys, ...patch }; settings.emit('change', {}, { hotkeys: patch }); } };
}

for (const event of ['destroyed', 'render-process-gone']) test(`shortcuts resume when the settings owner emits ${event}`, () => {
  const h = harness(), sender = new EventEmitter(); sender.isDestroyed = () => false;
  h.handlers.get('app:suspend-hotkeys')({ sender }, true);
  assert.equal(h.registered.size, 0);
  sender.emit(event);
  assert(h.registered.has('Control+Shift+2'));
});

test('disabled shortcuts do not retain a stale failure status', () => {
  const h = harness();
  h.change({ area: 'taken' });
  assert.equal(h.handlers.get('app:hotkey-status')().area, 'failed');
  h.change({ area: '' });
  assert.equal(h.handlers.get('app:hotkey-status')().area, undefined);
});

test('repeated suspension attaches one cleanup listener and releasing it removes listeners', () => {
  const h = harness(), sender = new EventEmitter(); sender.isDestroyed = () => false;
  const suspend = h.handlers.get('app:suspend-hotkeys');
  for (let i = 0; i < 20; i++) suspend({ sender }, true);
  assert.equal(sender.listenerCount('destroyed'), 1);
  suspend({ sender }, false);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('render-process-gone'), 0);
  assert.equal(h.registered.size, 1);
});
