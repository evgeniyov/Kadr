'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter, getEventListeners } = require('node:events');

function load(relative, mocks) {
  const file = path.resolve(__dirname, '..', relative);
  const localRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
    module, __dirname: path.dirname(file), console, process, AbortController,
  }, { filename: file });
  return module.exports;
}

function ffmpegHarness() {
  const children = [];
  const api = load('src/main/ffmpeg.js', {
    child_process: { spawn: () => {
      const p = new EventEmitter();
      p.stderr = new EventEmitter();
      p.kills = 0;
      p.kill = () => { p.kills++; };
      children.push(p);
      return p;
    } },
  });
  return { api, children };
}

test('already aborted ffmpeg never spawns', async () => {
  const h = ffmpegHarness(), ac = new AbortController();
  ac.abort();
  await assert.rejects(h.api.run([], { signal: ac.signal }), { name: 'AbortError' });
  assert.equal(h.children.length, 0);
});

for (const outcome of ['success', 'failure', 'error', 'abort']) {
  test(`ffmpeg ${outcome} removes abort listener and cannot kill a finished process`, async () => {
    const h = ffmpegHarness(), ac = new AbortController();
    const result = h.api.run([], { signal: ac.signal });
    const p = h.children[0];
    assert.equal(getEventListeners(ac.signal, 'abort').length, 1);
    if (outcome === 'error') p.emit('error', new Error('spawn failed'));
    else {
      if (outcome === 'abort') ac.abort();
      // Even a zero exit cannot turn an accepted cancellation into success.
      p.emit('close', outcome === 'failure' ? 1 : 0);
    }
    if (outcome === 'success') await result;
    else await assert.rejects(result, outcome === 'abort' ? { name: 'AbortError' } : undefined);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    const kills = p.kills;
    ac.abort();
    assert.equal(p.kills, kills);
    if (outcome === 'abort') assert.equal(kills, 1);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const syntheticDir = path.resolve('/synthetic');
const sourcePath = path.join(syntheticDir, 'source.mp4');
const nextPath = path.join(syntheticDir, 'next.mp4');
const thirdPath = path.join(syntheticDir, 'third.mp4');

async function editorHarness(stage) {
  const entered = deferred(), release = deferred();
  const handlers = {}, files = new Map([[sourcePath, 'original']]);
  let armed = true, probes = 0, runs = 0, renames = 0;
  const pause = async (at) => {
    if (armed && stage === at) { armed = false; entered.resolve(); await release.promise; }
  };
  const info = { video: 'h264', audio: 'aac', width: 160, height: 90, durationMs: 1000, audioTracks: [{ codec: 'aac' }] };
  const sender = new EventEmitter();
  Object.assign(sender, { id: 1, isDestroyed: () => false, send: () => {} });
  const win = new EventEmitter(); win.webContents = sender;
  const api = load('src/main/recording/editor.js', {
    fs: { promises: {
      stat: async () => ({ size: 100 }),
      rename: async (src, dst) => { renames++; files.set(dst, files.get(src)); files.delete(src); },
      unlink: async (file) => { files.delete(file); },
      rm: async () => {},
    } },
    electron: { BrowserWindow: { fromWebContents: () => win }, dialog: { showSaveDialog: async () => {
      await pause('dialog'); return { filePath: sourcePath };
    } }, shell: { trashItem: async (file) => { await pause('delete'); files.delete(file); } } },
    '../context': {
      t: (k) => k, handle: (k, fn) => { handlers[k] = fn; }, grantPath: () => {}, assertPath: (_, file) => file,
      uniquePath: () => path.join(syntheticDir, 'new.mp4'), paths: { tmp: syntheticDir }, newId: () => 'id',
    },
    '../ffmpeg': { parseTime: () => null, run: async (args) => {
      runs++; files.set(args.at(-1), 'exported'); await pause('encode');
    } },
    './post': { probe: async () => {
      probes++;
      if (probes === 2) await pause('open');
      if (probes === 2) await pause('source');
      if (probes === 3) await pause('output');
      return info;
    } },
    './windows': { createEditor: () => win },
  });
  api.register(); await api.openVideoEditor(sourcePath);
  return {
    entered: entered.promise, release: release.resolve, files, win,
    export: () => handlers['recorder:export']({ sender }, { format: 'mp4' }, stage === 'dialog' ? 'saveAs' : 'replace'),
    open: (file) => handlers['recorder:editor-open']({ sender }, file),
    delete: () => handlers['recorder:delete']({ sender }),
    cancel: () => handlers['recorder:export-cancel']({ sender }),
    counts: () => ({ runs, renames }),
  };
}

for (const hardLinks of [true, false]) {
  test(`parallel video copies keep both results ${hardLinks ? 'with' : 'without'} hard links`, async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kadr-parallel-export-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'source.mp4');
    await fs.promises.writeFile(source, 'original');
    const handlers = {}, encoding = deferred(), finish = deferred();
    let id = 0, exportsStarted = 0;
    const info = { video: 'h264', width: 160, height: 90, durationMs: 1000 };
    const fileSystem = hardLinks ? fs : { ...fs, promises: { ...fs.promises,
      link: async () => { throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' }); },
    } };
    const editor = load('src/main/recording/editor.js', {
      fs: fileSystem, electron: {},
      '../context': {
        t: () => '(edited)', paths: { tmp: dir }, newId: () => String(++id), grantPath() {},
        handle: (key, fn) => { handlers[key] = fn; },
        uniquePath: (folder, base, ext) => path.join(folder, `${base}.${ext}`),
      },
      './windows': { createEditor() {
        const win = new EventEmitter();
        win.webContents = { id: ++id, isDestroyed: () => false, send() {} };
        return win;
      } },
      './post': { probe: async () => info },
      '../ffmpeg': { async run(args) {
        const n = ++exportsStarted;
        if (n === 2) encoding.resolve();
        await finish.promise;
        await fs.promises.writeFile(args.at(-1), `export ${n}`);
      } },
    });
    editor.register();
    const first = await editor.openVideoEditor(source);
    const second = await editor.openVideoEditor(source);
    const exportCopy = (win) => handlers['recorder:export']({ sender: win.webContents }, { format: 'mp4' }, 'new');
    const exports = [exportCopy(first), exportCopy(second)];
    await encoding.promise;
    const existing = path.join(dir, 'source (edited).mp4');
    await fs.promises.writeFile(existing, 'created during encoding');
    finish.resolve();
    const results = await Promise.all(exports);
    assert(results.every((result) => result.path), JSON.stringify(results));
    assert.equal(new Set(results.map((result) => result.path)).size, 2);
    assert.deepEqual(results.map((result) => path.basename(result.path)).sort(), ['source (edited) (2).mp4', 'source (edited) (3).mp4']);
    assert.deepEqual((await Promise.all(results.map((result) => fs.promises.readFile(result.path, 'utf8')))).sort(), ['export 1', 'export 2']);
    assert.equal(await fs.promises.readFile(existing, 'utf8'), 'created during encoding');
    assert.equal(await fs.promises.readFile(source, 'utf8'), 'original');
    assert.equal((await fs.promises.readdir(dir)).some((file) => file.startsWith('.')), false);
  });
}

test('loading a video reserves the editor until probing finishes', async () => {
  const h = await editorHarness('open');
  const opening = h.open(nextPath);
  await h.entered;
  assert.equal((await h.export()).error, 'busy', 'export must not inspect the previous file during an import');
  assert.equal(await h.delete(), false);
  assert.equal((await h.open(thirdPath)).error, 'busy');
  h.release();
  assert.equal((await opening).file, nextPath);
  assert.equal((await h.export()).path, nextPath);
  assert.equal(h.files.get(sourcePath), 'original');
});

test('closing the editor while a video loads discards the late result', async () => {
  const h = await editorHarness('open'), opening = h.open(nextPath);
  await h.entered;
  h.win.emit('closed');
  h.release();
  assert.equal((await opening).error, 'gone');
});

test('deleting the current video reserves the editor until trashing finishes', async () => {
  const h = await editorHarness('delete'), deleting = h.delete();
  await h.entered;
  assert.equal((await h.open(nextPath)).error, 'busy');
  assert.equal((await h.export()).error, 'busy');
  assert.equal(await h.delete(), false);
  h.release();
  assert.equal(await deleting, true);
  assert.equal(h.files.has(sourcePath), false);
});

for (const stage of ['source', 'dialog', 'encode', 'output']) {
  for (const action of ['cancel', 'close']) {
    test(`${action} during ${stage} preserves original and cleans partial export`, async () => {
      const h = await editorHarness(stage);
      const result = h.export();
      await h.entered;
      assert.equal((await h.export()).error, 'busy');
      if (action === 'cancel') h.cancel();
      else h.win.emit('closed');
      h.release();
      assert.equal((await result).cancelled, true);
      assert.equal(h.counts().renames, 0);
      assert.equal(h.files.get(sourcePath), 'original');
      assert.equal(h.files.size, 1);
      if (stage === 'source' || stage === 'dialog') assert.equal(h.counts().runs, 0);
      if (action === 'cancel') {
        assert.equal((await h.export()).replaced, true, 'cancellation releases the job for retry');
        assert.equal(h.files.get(sourcePath), 'exported');
      }
    });
  }
}
