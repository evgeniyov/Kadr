'use strict';
// ffmpeg post-processing of recordings: probing, remux to a seekable file,
// mixing in macOS system audio, GIF conversion.

const fs = require('fs');
const path = require('path');
const ffmpeg = require('../ffmpeg');

// Parse `ffmpeg -i file` (which "fails" because there is no output) into basic info.
async function probe(file) {
  let stderr = '';
  try {
    stderr = (await ffmpeg.run(['-i', file])).stderr;
  } catch (e) {
    stderr = e.stderr || '';
    if (!/Input #0/.test(stderr)) throw e;
  }
  const info = { durationMs: null, width: null, height: null, fps: null, video: null, audio: null };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) info.durationMs = Math.round((+d[1] * 3600 + +d[2] * 60 + +d[3]) * 1000);
  const v = /Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
  if (v) {
    [info.video, info.width, info.height] = [v[1], +v[2], +v[3]];
    // Phone videos often store landscape frames plus a 90° display matrix.
    // Chromium previews and ffmpeg filters both autorotate; crop/resize must use
    // that same displayed coordinate space, not the encoded frame dimensions.
    const section = stderr.slice(v.index).split(/\r?\n\s*Stream #/)[0];
    const rotation = /display ?matrix:\s*rotation of (-?\d+(?:\.\d+)?) degrees/i.exec(section)
      || /^\s+rotate\s*:\s*(-?\d+(?:\.\d+)?)\s*$/m.exec(section);
    if (rotation && Math.abs(Math.abs(Number(rotation[1])) % 180 - 90) < 0.01) {
      [info.width, info.height] = [info.height, info.width];
    }
  }
  const fps = /Stream #\d+:\d+[^\n]*?: Video: [^\n]*?(\d+(?:\.\d+)?) fps/.exec(stderr);
  if (fps) info.fps = +fps[1];
  const a = /Stream #\d+:\d+[^\n]*?: Audio: (\w+)/.exec(stderr);
  if (a) info.audio = a[1];
  info.audioTracks = audioTracks(stderr);
  return info;
}

// Audio streams in order (a:0, a:1, …) with the role Kadr stored in their title.
const TRACK_TITLES = { mix: 'Kadr: mix', mic: 'Kadr: microphone', system: 'Kadr: system' };
function audioTracks(stderr) {
  const tracks = [];
  let cur = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /^\s*Stream #\d+:\d+[^:]*: (\w+): (\w+)/.exec(line);
    if (s) {
      cur = s[1] === 'Audio' ? { codec: s[2], title: '', role: null } : null;
      if (cur) tracks.push(cur);
      continue;
    }
    const tm = cur && /^\s+(title|handler_name)\s*:\s*(.*)$/.exec(line);
    if (tm) {
      const role = Object.keys(TRACK_TITLES).find((k) => TRACK_TITLES[k] === tm[2].trim());
      if (role || tm[1] === 'title') cur.title = tm[2].trim();
      if (role) cur.role = role;
    }
  }
  return tracks;
}

// Metadata + dispositions for [mix, mic, system]: players play the default mix, Kadr's
// video editor can pick a single source.
// MP4 keeps a track's name in handler_name, WebM/MKV in title: write both.
function trackTags() {
  return ['mix', 'mic', 'system'].flatMap((r, i) => [
    `-metadata:s:a:${i}`, `title=${TRACK_TITLES[r]}`,
    `-metadata:s:a:${i}`, `handler_name=${TRACK_TITLES[r]}`,
    `-disposition:a:${i}`, i === 0 ? 'default' : '0',
  ]);
}

function progressReporter(durationMs, onProgress) {
  if (!onProgress || !durationMs) return undefined;
  return (line) => {
    const t = ffmpeg.parseTime(line);
    if (t != null) onProgress(Math.max(0, Math.min(1, (t * 1000) / durationMs)));
  };
}

/**
 * Turn the raw MediaRecorder output into the final file.
 * - output extension selects the container (mp4 → +faststart, webm → proper duration/cues);
 * - streams are copied when the codecs fit the container, otherwise re-encoded;
 * - system: { path, offsetMs, volume } mixes an extra audio file in (macOS system audio),
 *   offsetMs = (audio start − video start) in ms;
 * - stems: { mic, system } separate recordings of each source (Windows, where both are
 *   mixed live).
 * With both a microphone and system audio the file gets three audio tracks: the mix
 * (default, what every player plays), the microphone alone and the system audio alone.
 */
async function finalize({ input, output, system = null, stems = null, onProgress, signal }) {
  const isMp4 = path.extname(output).toLowerCase() === '.mp4';
  const info = await probe(input).catch(() => ({}));
  const videoFits = isMp4 ? info.video === 'h264' : ['vp8', 'vp9', 'av1'].includes(info.video);
  const audioFits = !info.audio || (isMp4 ? info.audio === 'aac' : ['opus', 'vorbis'].includes(info.audio));

  const vArgs = videoFits
    ? ['-c:v', 'copy']
    : isMp4
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'];
  const aEncode = isMp4 ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'libopus', '-b:a', '160k'];

  const args = ['-i', input];
  if (system && info.audio) {
    // macOS: the recording holds the microphone, the helper file the system audio.
    args.push('-i', system.path);
    const chain = ['aresample=48000', 'aformat=channel_layouts=stereo'];
    if (system.volume != null && system.volume !== 1) chain.push(`volume=${Number(system.volume).toFixed(2)}`);
    const off = Math.round(system.offsetMs || 0);
    if (off > 0) chain.push(`adelay=${off}:all=1`);
    else if (off < 0) chain.push(`atrim=start=${(-off / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
    // The system-only track takes the recording's length by mixing it with a silenced copy
    // of the microphone (apad + -shortest never ends when the video is stream-copied).
    const graph = [
      `[1:a]${chain.join(',')},asplit=2[sys][sysOnly]`,
      '[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=3[rec][micOnly][len]',
      '[rec][sys]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]',
      '[len]volume=0[silent]',
      '[silent][sysOnly]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[sysT]',
    ].join(';');
    args.push('-filter_complex', graph, '-map', '0:v:0', '-map', '[aout]', '-map', '[micOnly]', '-map', '[sysT]', ...vArgs, ...aEncode, ...trackTags());
  } else if (stems?.mic && stems?.system && info.audio) {
    // Windows: the recording holds the live mix; the stems are the two sources alone.
    args.push('-i', stems.mic, '-i', stems.system);
    const mixCodec = audioFits ? ['-c:a:0', 'copy'] : aEncode.map((x) => (x === '-c:a' ? '-c:a:0' : x === '-b:a' ? '-b:a:0' : x));
    const stemCodec = (i) => (isMp4 ? [`-c:a:${i}`, 'aac', `-b:a:${i}`, '192k'] : [`-c:a:${i}`, 'copy']);
    args.push('-map', '0:v:0', '-map', '0:a:0', '-map', '1:a:0', '-map', '2:a:0', ...vArgs, ...mixCodec, ...stemCodec(1), ...stemCodec(2), ...trackTags());
  } else if (system) {
    args.push('-i', system.path);
    const chain = ['aresample=48000', 'aformat=channel_layouts=stereo'];
    if (system.volume != null && system.volume !== 1) chain.push(`volume=${Number(system.volume).toFixed(2)}`);
    const off = Math.round(system.offsetMs || 0);
    if (off > 0) chain.push(`adelay=${off}:all=1`);
    else if (off < 0) chain.push(`atrim=start=${(-off / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
    let graph = `[1:a]${chain.join(',')}[sys]`;
    graph += info.audio
      ? ';[0:a]aresample=48000,aformat=channel_layouts=stereo[rec];[rec][sys]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]'
      : ';[sys]apad[aout]';
    args.push('-filter_complex', graph, '-map', '0:v:0', '-map', '[aout]', ...vArgs, ...aEncode);
    // Without a recorded audio track the padded system audio must not outlive the video.
    if (!info.audio) args.push(...(info.durationMs ? ['-t', (info.durationMs / 1000).toFixed(3)] : ['-shortest']));
  } else {
    args.push('-map', '0:v:0?', '-map', '0:a:0?', ...vArgs, ...(audioFits ? ['-c:a', 'copy'] : aEncode));
  }
  if (isMp4) args.push('-movflags', '+faststart');
  args.push(output);
  await ffmpeg.run(args, { onStderr: progressReporter(info.durationMs, onProgress), signal });
  // A recording that died before its first fragment remuxes into a file without frames.
  // An unavailable/failed probe must not be reported as EMPTY: callers may
  // preserve or recover a complete file once inspection becomes available.
  const out = await probe(output);
  if (!out.video || !(out.durationMs > 0)) throw Object.assign(new Error('nothing was recorded'), { code: 'EMPTY' });
  return output;
}

// rename() that also works across volumes.
async function moveFile(src, dst) {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.promises.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    await fs.promises.copyFile(src, dst);
    await fs.promises.unlink(src).catch(() => {});
  }
  return dst;
}

module.exports = { probe, finalize, moveFile };
