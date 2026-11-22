'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ffmpegPath } = require('../src/main/ffmpeg');
const bin = ffmpegPath();
const plan = require('../src/renderer/recorder/shared/export-plan.mjs');
const { sanitizeSpec } = require('../src/main/recording/export-spec');
// Only lavfi-generated frames and tones, temporary files, and local file/pipe protocols.
test('real ffmpeg export keeps exactly the selected synthetic AAC track', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-media-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => {
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: null, timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr?.toString()); return r.stdout;
  };
  const input = path.join(dir, 'fixture.mp4');
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=2:d=2', ...[440, 660, 880].flatMap((f) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=2`]), '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  const hashTrack = (file, track) => crypto.createHash('sha256').update(run(['-protocol_whitelist', 'file,pipe', '-i', file, '-map', `0:a:${track}`, '-c:a', 'copy', '-f', 'adts', 'pipe:1'])).digest('hex');
  const src = { durationMs: 2000, width: 160, height: 90, video: 'h264', audio: 'aac' };
  const expected = [0, 1, 2].map((i) => hashTrack(input, i)); assert.equal(new Set(expected).size, 3);
  for (const format of ['mp4', 'm4a']) for (const track of [1, 2]) {
    const output = path.join(dir, `track-${track}.${format}`);
    for (const pass of plan.buildExportArgs(src, sanitizeSpec({ format, audioTrack: track }), input, output).passes) run(['-protocol_whitelist', 'file,pipe', ...pass]);
    assert.equal(hashTrack(output, 0), expected[track], `${format}: selected track ${track}`);
    assert.notEqual(hashTrack(output, 0), expected[0], 'the mix must not replace the selected source');
  }
});
test('mixed-codec source exports selected Opus audio as compatible AAC in MP4 and M4A', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-mixed-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => {
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
  };
  const input = path.join(dir, 'mixed.mkv');
  run(['-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=2:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a:0', 'aac', '-c:a:1', 'libopus', input]);
  const post = require('../src/main/recording/post');
  const src = await post.probe(input); assert.equal(src.audioTracks[0].codec, 'aac'); assert.equal(src.audioTracks[1].codec, 'opus');
  for (const format of ['mp4', 'm4a']) {
    const out = path.join(dir, `selected.${format}`);
    const exportPlan = plan.buildExportArgs(src, sanitizeSpec({ format, audioTrack: 1 }), input, out);
    assert.equal(exportPlan.copy, false);
    for (const pass of exportPlan.passes) run(['-protocol_whitelist', 'file,pipe', ...pass]);
    const info = await post.probe(out); assert.equal(info.audio, 'aac'); assert.equal(info.audioTracks.length, 1); assert(info.durationMs > 0);
  }
});

test('rotated phone video uses displayed dimensions when resizing and cropping', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-rotated-video-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => {
    const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
  };
  const base = path.join(dir, 'base.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=2:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
  const post = require('../src/main/recording/post');
  for (const rotation of [90, 180, 270]) {
    const input = path.join(dir, `rotated-${rotation}.mp4`);
    // Set the display matrix explicitly. Some FFmpeg builds ignore the legacy rotate tag.
    run(['-display_rotation:v:0', String(rotation), '-i', base, '-c', 'copy', input]);
    const src = await post.probe(input);
    const expected = rotation === 180 ? { width: 160, height: 90 } : { width: 90, height: 160 };
    assert.equal(src.width, expected.width);
    assert.equal(src.height, expected.height);
    const size = plan.presetSize(expected, 'half');
    const output = path.join(dir, `resized-${rotation}.mp4`);
    const spec = sanitizeSpec({ format: 'mp4', crop: { x: 0, y: 0, ...expected }, size });
    for (const pass of plan.buildExportArgs(src, spec, input, output).passes) run(pass);
    const out = await post.probe(output);
    assert.equal(out.width, size.width);
    assert.equal(out.height, size.height);
    assert(out.durationMs > 0);
  }
});
