'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function harness(t, failure = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-recording-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recordings = path.join(dir, 'recordings'), saved = path.join(dir, 'saved');
  fs.mkdirSync(recordings); fs.mkdirSync(saved);
  const handlers = {}, info = { video: 'h264', durationMs: 1000, width: 160, height: 90 };
  let serial = 0, recover, sysPath;
  const native = { capabilities: () => ({ systemAudio: true }), systemAudio: {
    start: async (file) => { sysPath = file; fs.writeFileSync(file, 'system-audio'); },
    stop: async () => ({ path: sysPath, startedAt: Date.now() }),
  } };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 160, height: 90 }, scaleFactor: 1 };
  const rs = { saveFolder: saved, fileNameTemplate: 'recording', countdown: 0, systemAudio: true, format: 'mp4' };
  const ctx = {
    isMac: true, paths: { recordings }, newId: () => `id${++serial}`,
    handle: (name, fn) => { handlers[name] = fn; }, t: (key) => key, notify() {}, modules: { native },
    settings: { defaults: { recording: rs }, get: (key) => key === 'recording' ? rs
      : key === 'recording.afterRecording' ? 'none' : key === 'recording.hideControlsWhileRecording' ? true : null, set() {} },
    formatFileName: (s) => s, uniquePath: (folder, base, ext) => path.join(folder, `${base}.${ext}`),
  };
  const post = {
    probe: async () => {
      if (failure === 'probe') throw new Error('synthetic probe unavailable');
      return failure === 'no-video' ? { audio: 'aac', durationMs: 1000 } : info;
    },
    finalize: async ({ input, output, system }) => {
      fs.copyFileSync(input, output);
      if (failure === 'empty') throw Object.assign(new Error('synthetic output has no frames'), { code: 'EMPTY' });
      if (failure === 'mix' && system) throw new Error('synthetic audio mixing failure');
    },
    moveFile: async (from, to) => {
      if (failure === 'move') throw new Error('synthetic destination unavailable');
      fs.renameSync(from, to); return to;
    },
  };
  const file = path.resolve(__dirname, '../src/main/recording.js'), localRequire = createRequire(file), module = { exports: {} };
  const { ChunkSink } = localRequire('./recording/sink');
  class PartialSink extends ChunkSink {
    async write(buf) {
      if (failure !== 'partial' || !path.basename(this.file).startsWith('raw-')) return super.write(buf);
      await this.fh.write(buf, 0, 3, null);
      this.error = Object.assign(new Error('synthetic disk full after a partial first write'), { code: 'ENOSPC' });
      throw this.error;
    }
  }
  const mocks = {
    electron: { app: new EventEmitter(), screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
      systemPreferences: { getMediaAccessStatus: () => 'granted' }, powerSaveBlocker: { start: () => 1, stop() {} }, globalShortcut: {}, shell: {} },
    './context': ctx, './basics': { toBuffer: (b) => b }, './recording/post': post,
    './recording/sink': { ChunkSink: PartialSink },
    './recording/editor': { register() {} }, './recording/dev-fakes': {},
    './recording/sources': { screenSourceId: async () => 'screen:1:0' },
    './recording/windows': {
      createWorker: () => {
        const win = new EventEmitter(), wc = new EventEmitter(); let destroyed = false;
        Object.assign(wc, { id: ++serial, send: (_, message) => {
          const send = (type) => handlers['recorder:worker-event']({ sender: wc }, { type, sessionId: module.exports._dev.session().id, ext: 'mp4', stems: ['mic', 'system'] });
          if (message.cmd === 'start') queueMicrotask(() => send('started'));
          if (message.cmd === 'stop') queueMicrotask(async () => {
            await handlers['recorder:chunk']({ sender: wc }, Buffer.from('raw-recording'));
            for (const name of ['mic', 'system']) await handlers['recorder:stem-chunk']({ sender: wc }, { name, data: Buffer.from(`${name}-stem`) });
            send('stopped');
          });
        } });
        Object.assign(win, { webContents: wc, isDestroyed: () => destroyed, close: () => { destroyed = true; win.emit('closed'); } });
        queueMicrotask(() => handlers['recorder:worker-event']({ sender: wc }, {
          type: 'ready', sessionId: module.exports._dev.session().id, ext: 'mp4', stems: ['mic', 'system'],
        }));
        return win;
      },
      closeWindow: (win) => { if (win && !win.isDestroyed()) win.close(); },
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id), module, process, console, Buffer,
    setTimeout: (fn, ms) => { if (ms === 4000) { recover = fn; return 0; } return setTimeout(fn, ms); },
    clearTimeout, setInterval, clearInterval,
  }, { filename: file });
  const api = module.exports; api.register();
  return { api, recordings, saved, recover: () => recover(), async record() {
    const recording = new Promise((resolve) => api.events.on('state', (s) => { if (s.status === 'recording') resolve(); }));
    assert.equal((await handlers['recorder:start']({}, {})).ok, true); await recording;
    const session = api._dev.session();
    const result = await api.stop();
    await new Promise((resolve) => setImmediate(resolve));
    return { session, result };
  } };
}

for (const failure of ['move', 'empty']) test(`${failure}: failed delivery preserves raw, native audio, stems and the processed candidate`, async (t) => {
  const h = harness(t, failure), { session, result } = await h.record();
  assert.equal(result, null);
  for (const file of [session.rawPath, session.sysPath, session.finalTmp, ...Object.values(session.stems).map((s) => s.file)]) {
    assert(fs.existsSync(file), `recoverable material retained: ${path.basename(file)}`);
  }
});

test('a partial first chunk survives even when the complete-chunk counter is zero', async (t) => {
  const h = harness(t, 'partial'), { session, result } = await h.record();
  assert.equal(result, null);
  assert.equal(session.sink.bytes, 0);
  assert.equal(session.sink.error.code, 'ENOSPC');
  assert.equal(fs.readFileSync(session.rawPath, 'utf8'), 'raw');
  assert.equal(fs.readFileSync(session.sysPath, 'utf8'), 'system-audio');
});

test('successful delivery still removes normal intermediate recording files', async (t) => {
  const h = harness(t), { result } = await h.record();
  assert(result?.path);
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'raw-recording');
  assert.deepEqual(fs.readdirSync(h.recordings), []);
});

test('saving video after failed audio mixing retains the separate audio for recovery', async (t) => {
  const h = harness(t, 'mix'), { session, result } = await h.record();
  assert(result?.path);
  for (const file of [session.sysPath, ...Object.values(session.stems).map((s) => s.file)]) assert(fs.existsSync(file));
});

for (const failure of ['probe', 'no-video']) test(`${failure}: startup inspection cannot delete raw or orphan audio/export files`, async (t) => {
  const h = harness(t, failure);
  const names = ['raw-old.mp4', 'sys-old.m4a', 'stem-mic-old.webm', 'final-old.mp4'];
  for (const name of names) fs.writeFileSync(path.join(h.recordings, name), `keep:${name}`);
  await h.recover();
  for (const name of names) assert.equal(fs.readFileSync(path.join(h.recordings, name), 'utf8'), `keep:${name}`);
});

test('failed startup delivery retains each distinct processed candidate', async (t) => {
  const h = harness(t, 'move');
  for (const name of ['one', 'two']) fs.writeFileSync(path.join(h.recordings, `raw-${name}.mp4`), name);
  await h.recover();
  for (const name of ['one', 'two']) assert.equal(fs.readFileSync(path.join(h.recordings, `raw-${name}.mp4`), 'utf8'), name);
  const finals = fs.readdirSync(h.recordings).filter((name) => name.startsWith('final-'));
  assert.equal(finals.length, 2);
  assert.deepEqual(new Set(finals.map((name) => fs.readFileSync(path.join(h.recordings, name), 'utf8'))), new Set(['one', 'two']));
});

test('a failed output probe is not misclassified as an empty recording', async () => {
  const file = path.resolve(__dirname, '../src/main/recording/post.js'), localRequire = createRequire(file), module = { exports: {} };
  const failure = new Error('synthetic output probe unavailable');
  const ffmpeg = { run: async (args) => {
    if (args.length === 2 && args[0] === '-i') {
      if (args[1] === '/synthetic/output.mp4') throw failure;
      return { stderr: 'Input #0\nDuration: 00:00:01.00\nStream #0:0: Video: h264, yuv420p, 160x90, 30 fps' };
    }
    return {};
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, require: (id) => id === '../ffmpeg' ? ffmpeg : localRequire(id),
  }, { filename: file });
  await assert.rejects(module.exports.finalize({ input: '/synthetic/input.mp4', output: '/synthetic/output.mp4' }), (e) => e === failure);
});
