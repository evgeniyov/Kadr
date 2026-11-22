'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plan = require('../src/renderer/recorder/shared/export-plan.mjs');
const messages = require('../src/shared/i18n/recorder.mjs').default;
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder/editor/index.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function editor(format = 'm4a', language = 'ru') {
  const nodes = new Map(), calls = [], notices = [], listeners = {};
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      disabled: false, dataset: {}, classList: { toggle() {}, add() {} },
      replaceChildren(...children) { this.children = children; },
    });
    return nodes.get(id);
  };
  const S = {
    src: { file: '/synthetic/video.mp4', width: 160, height: 90, durationMs: 1000, video: 'h264', audio: 'aac',
      audioTracks: [{ role: 'mix', codec: 'aac' }, { role: 'mic', codec: 'aac' }, { role: 'system', codec: 'aac' }] },
    format, trim: { start: 0, end: 1 }, keepMic: false, keepSystem: false,
    mute: false, exporting: false, preciseShown: false, speed: 1,
  };
  const video = { muted: false, audioTracks: [{}, {}, {}] };
  const context = vm.createContext({
    S, video, plan, $, kind: () => plan.FORMATS[S.format].kind,
    trimmed: () => false, cropRect: () => null, outSize: () => ({ width: 160, height: 90 }),
    fmtTime: String, el: (...args) => args,
    t: (key) => messages[language][key] || key,
    toast: (text) => notices.push(text), renderOptions() {}, progress() {}, showDone() {},
    releaseVideo() {}, attachVideo() {}, isMac: true, setIn() {}, setOut() {},
    document: { body: { classList: { toggle() {} } } },
    window: { addEventListener: (event, callback) => { listeners[event] = callback; } },
    kadr: { invoke: async (...args) => { calls.push(args); return { cancelled: true }; } },
  });
  vm.runInContext([
    section('function sourceTracks()', '// ---- player'),
    section('function renderExport()', 'function progress('),
    section('async function doExport(', '// ---- loading'),
    section("window.addEventListener('keydown'", 'let resizeTimer;'),
  ].join('\n'), context);
  return { S, video, $, calls, notices, listeners, context };
}

for (const format of ['m4a', 'mp3']) {
  for (const language of ['ru', 'en']) {
    test(`${format}/${language}: both sources off disables export, explains why, and blocks save shortcuts`, async () => {
      const h = editor(format, language), c = h.context;
      c.applyPreviewAudio(); c.renderExport();
      assert.equal(h.video.muted, true);
      for (const id of ['#export-new', '#export-as', '#export-replace']) assert.equal(h.$(id).disabled, true);
      const explanation = messages[language]['recorder.editor.selectAudioSource'];
      assert(explanation, 'both locales provide the explanation');
      assert(h.$('#summary').children.includes(explanation));
      for (const shiftKey of [false, true]) h.listeners.keydown({ target: {}, key: 's', metaKey: true, shiftKey, preventDefault() {} });
      for (const target of ['new', 'saveAs', 'replace']) await c.doExport(target);
      assert.equal(h.calls.length, 0, 'no export or save/confirmation dialog IPC');
      assert.equal(h.notices.length, 5);
      assert(h.notices.every((text) => text === explanation));
      c.setExporting(true); c.setExporting(false);
      assert.equal(h.$('#export-new').disabled, true, 'completion cannot re-enable unavailable export');
      for (const [mic, system, track] of [[true, false, 1], [false, true, 2], [true, true, 0]]) {
        h.S.keepMic = mic; h.S.keepSystem = system;
        c.applyPreviewAudio(); c.renderExport();
        assert.equal(h.video.muted, false);
        assert.equal(h.video.audioTracks[track].enabled, true);
        assert.equal(h.$('#export-new').disabled, false);
        assert.equal(h.$('#export-as').disabled, false);
        assert(!h.$('#summary').children.includes(explanation));
        await c.doExport('new');
        assert.equal(h.calls.at(-1)[0], 'recorder:export');
        assert.equal(h.calls.at(-1)[1].audioTrack, track);
        assert.equal(h.calls.at(-1)[1].mute, false);
      }
    });
  }
}

test('video with both sources off still exports muted and switching formats restores availability', async () => {
  const h = editor('mp4'), c = h.context;
  c.applyPreviewAudio(); c.renderExport();
  assert.equal(h.video.muted, true);
  assert.equal(h.$('#export-new').disabled, false);
  assert.equal(h.$('#export-replace').disabled, false);
  await c.doExport('new');
  assert.equal(h.calls[0][1].mute, true);
  h.S.format = 'm4a'; c.renderExport();
  assert.equal(h.$('#export-new').disabled, true);
  h.S.format = 'mp4'; c.renderExport();
  assert.equal(h.$('#export-new').disabled, false);
});

test('single-track audio export keeps existing preview mute semantics', async () => {
  const h = editor(), c = h.context;
  h.S.src.audioTracks = [{ codec: 'aac' }]; h.S.mute = true;
  c.applyPreviewAudio(); c.renderExport();
  assert.equal(h.video.muted, true);
  assert.equal(h.$('#export-new').disabled, false);
  await c.doExport('new');
  assert.equal(h.calls[0][1].audioTrack, 0);
  assert.equal(h.calls[0][1].mute, false);
});
