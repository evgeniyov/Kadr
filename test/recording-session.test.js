'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function load(relative, mocks) {
  const file = path.resolve(__dirname, '..', relative), module = { exports: {} };
  const localRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
    module, process, console, Buffer, AbortController, clearTimeout, setInterval, clearInterval,
    setTimeout: (fn, ms) => ms === 4000 ? 0 : setTimeout(fn, ms),
  }, { filename: file });
  return module.exports;
}

const display = (id) => ({ id, bounds: { x: 0, y: 0, width: 160, height: 90 }, scaleFactor: 1 });
const source = (id) => ({ id: `screen:${id}:0`, display_id: String(id) });

test('recorder never substitutes the remaining screen for a disconnected display', async () => {
  let displays = [display(1), display(2)], sources = [source(1)];
  const api = load('src/main/recording/sources.js', {
    electron: { screen: { getAllDisplays: () => displays }, desktopCapturer: { getSources: async () => sources } },
    '../context': {},
  });
  assert.equal(await api.screenSourceId(2), null, 'known IDs must not fall back to the sole source');
  displays = [display(1)];
  assert.equal(await api.screenSourceId(2), null, 'a removed display must not fall back either');
  assert.equal(await api.screenSourceId(1), 'screen:1:0');
  displays = [display(1), display(2)]; sources = [{ id: 'anonymous-screen', display_id: '' }];
  assert.equal(await api.screenSourceId(1), null, 'incomplete anonymous lists cannot be matched by index');
  sources = [{ id: 'first', display_id: '' }, { id: 'second', display_id: '' }];
  assert.equal(await api.screenSourceId(2), 'second', 'retain fallback for complete legacy lists');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function sessionHarness(stage) {
  const entered = deferred(), release = deferred(), handlers = {}, sinks = [], notices = [], commands = [];
  const audio = { starts: 0, stops: 0, active: false };
  let serial = 0;
  const makeWindow = () => {
    const win = new EventEmitter(), wc = new EventEmitter();
    let destroyed = false;
    Object.assign(wc, { id: ++serial, send: (channel, message) => {
      commands.push(message?.cmd);
      if (stage === 'send-reject' && message?.cmd === 'start') throw new Error('synthetic disposed frame');
      if (message?.cmd === 'start') queueMicrotask(() => handlers['recorder:worker-event']({ sender: wc }, {
        type: 'started', sessionId: api._dev.session().id,
      }));
    } });
    Object.assign(win, { webContents: wc, isDestroyed: () => destroyed,
      close: () => { destroyed = true; win.emit('closed'); } });
    return win;
  };
  const ctx = {
    isMac: true, paths: { recordings: '/synthetic' }, newId: () => `session${++serial}`,
    t: (key) => key, notify: (...args) => notices.push(args), handle: (key, fn) => { handlers[key] = fn; },
    settings: { get: (key) => key === 'recording' ? { countdown: 0, systemAudio: stage.startsWith('audio'), mic: stage === 'permission' }
      : key === 'recording.hideControlsWhileRecording' ? true : null, set() {} },
    modules: { native: {
      capabilities: () => ({ systemAudio: true }),
      systemAudio: {
        start: async () => {
          audio.starts++;
          if (stage === 'audio-reject') throw new Error('synthetic audio start failure');
          if (stage === 'audio') { entered.resolve(); await release.promise; }
          audio.active = true;
        },
        stop: async () => { audio.stops++; audio.active = false; return {}; },
        pause: async () => {}, resume: async () => {},
      },
    } },
  };
  class Sink {
    constructor(file) { this.file = file; this.opened = false; sinks.push(this); }
    async open() {
      if ((stage === 'raw' && sinks.length === 1) || (stage === 'stem' && sinks.length === 2)) {
        entered.resolve(); await release.promise;
      }
      this.opened = true;
    }
    async close() { this.opened = false; }
  }
  const api = load('src/main/recording.js', {
    fs: { promises: { unlink: async () => {} } },
    electron: { app: new EventEmitter(), screen: { getPrimaryDisplay: () => display(1), getAllDisplays: () => [display(1)] },
      systemPreferences: {
        getMediaAccessStatus: (kind) => stage === 'permission' && kind === 'microphone' ? 'not-determined' : 'granted',
        askForMediaAccess: async () => { entered.resolve(); await release.promise; return true; },
      }, powerSaveBlocker: { start: () => 1, stop: () => {} }, globalShortcut: {}, shell: {} },
    './context': ctx, './basics': {}, './recording/post': {}, './recording/dev-fakes': {},
    './recording/sources': { screenSourceId: async () => {
      if (stage === 'target') { entered.resolve(); await release.promise; }
      return 'screen:1:0';
    } },
    './recording/sink': { ChunkSink: Sink }, './recording/editor': { register() {} },
    './recording/windows': {
      createWorker: () => {
        const win = makeWindow();
        queueMicrotask(() => handlers['recorder:worker-event']({ sender: win.webContents }, {
          sessionId: api._dev.session().id, type: 'ready', ext: 'mp4', stems: stage === 'stem' ? ['mic', 'system'] : [],
        }));
        return win;
      },
      closeWindow: (win) => { if (win && !win.isDestroyed()) win.close(); },
    },
  });
  api.register();
  return { api, entered: entered.promise, release, sinks, audio, notices, commands,
    start: () => handlers['recorder:start']({}, { mode: 'screen' }) };
}

for (const stage of ['target', 'permission']) {
  test(`cancel during ${stage} lookup prevents a late recording start`, async () => {
    const h = sessionHarness(stage), starting = h.start();
    await h.entered;
    await h.api.cancel();
    h.release.resolve();
    assert.equal((await starting).error, 'cancelled');
    assert.equal(h.api._dev.session(), null);
    assert.equal(h.sinks.length, 0);
    assert.equal(h.audio.starts, 0);
  });
}

for (const stage of ['raw', 'stem', 'audio']) {
  test(`cancel during ${stage} preparation waits for cleanup and leaves no active resource`, async () => {
    const h = sessionHarness(stage), starting = h.start();
    await h.entered;
    const session = h.api._dev.session();
    const cancelling = h.api.cancel();
    h.release.resolve();
    await Promise.all([starting, cancelling]);
    // Allow launch()'s continuation to run, too.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.api._dev.session(), null);
    assert.equal(h.sinks.some((sink) => sink.opened), false, 'late-opened files must be closed');
    assert.equal(h.audio.active, false, 'late-started native audio must be stopped');
    assert.equal(session.waiters.size, 0, 'cancellation must not create another worker timeout');
    assert(!h.commands.includes('start'), 'cancelled sessions never start video');
    assert.equal(h.notices.length, 0, 'cancellation is not a recording failure');
    if (stage === 'audio') assert.equal(h.audio.stops, 1);
  });
}

for (const stage of ['normal', 'audio-success', 'audio-reject']) {
  test(`${stage}: recording still starts, pauses, resumes and cancels cleanly`, async () => {
    const h = sessionHarness(stage), recording = deferred();
    h.api.events.on('state', (state) => { if (state.status === 'recording') recording.resolve(); });
    assert.equal((await h.start()).ok, true);
    await recording.promise;
    assert.equal(h.api._dev.session().phase, 'recording');
    h.api.pause();
    assert.equal(h.api._dev.session().phase, 'paused');
    h.api.resume();
    assert.equal(h.api._dev.session().phase, 'recording');
    await h.api.cancel();
    assert.equal(h.api._dev.session(), null);
    assert.equal(h.audio.active, false);
    assert.equal(h.sinks.some((sink) => sink.opened), false);
    assert.deepEqual(h.commands, ['start', 'pause', 'resume']);
    assert.equal(h.notices.length, stage === 'audio-reject' ? 1 : 0);
  });
}

test('a disposed worker during start reports failure without leaving an unhandled waiter', async () => {
  const h = sessionHarness('send-reject'), idle = deferred();
  let session;
  h.api.events.on('state', (state) => {
    if (state.status === 'countdown') session = h.api._dev.session();
    if (state.status === 'idle') idle.resolve();
  });
  await h.start();
  await idle.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.api._dev.session(), null);
  assert.equal(session.waiters.size, 0);
  assert.equal(h.sinks.some((sink) => sink.opened), false);
  assert.equal(h.notices.length, 1);
});
