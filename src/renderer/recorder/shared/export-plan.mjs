// Video export planning, shared by the editor UI (to show what will happen) and the
// main process (which runs ffmpeg). Pure functions, no I/O.
//
// src:  { durationMs, width, height, fps, video, audio }   (from ffmpeg probe)
// spec: { format, trim:{start,end}|null (s), crop:{x,y,width,height}|null (source px),
//         size:{width,height}|null (output px), fps:null|number, quality, mute, speed, precise }

export const FORMATS = {
  mp4: { ext: 'mp4', kind: 'video', label: 'MP4', v: 'h264', a: 'aac', copyV: ['h264'], copyA: ['aac'], faststart: true },
  mov: { ext: 'mov', kind: 'video', label: 'MOV', v: 'h264', a: 'aac', copyV: ['h264', 'hevc'], copyA: ['aac'], faststart: true },
  webm: { ext: 'webm', kind: 'video', label: 'WebM', v: 'vp9', a: 'opus', copyV: ['vp8', 'vp9', 'av1'], copyA: ['opus', 'vorbis'] },
  mkv: { ext: 'mkv', kind: 'video', label: 'MKV', v: 'h264', a: 'aac', copyV: ['h264', 'hevc', 'vp8', 'vp9', 'av1'], copyA: ['aac', 'opus', 'vorbis', 'mp3'] },
  gif: { ext: 'gif', kind: 'gif', label: 'GIF' },
  m4a: { ext: 'm4a', kind: 'audio', label: 'M4A', a: 'aac', copyA: ['aac'] },
  mp3: { ext: 'mp3', kind: 'audio', label: 'MP3', a: 'mp3', copyA: ['mp3'] },
};

export const SPEEDS = [0.5, 1, 1.5, 2];
export const FPS_OPTIONS = [null, 60, 30, 24, 15];
export const QUALITIES = ['low', 'medium', 'high', 'max'];
export const SIZE_PRESETS = ['original', 2160, 1440, 1080, 720, 480, 360, 'half', 'custom'];

const X264_CRF = { low: 29, medium: 24, high: 20, max: 16 };
const X264_PRESET = { low: 'veryfast', medium: 'veryfast', high: 'fast', max: 'medium' };
const VP9_CRF = { low: 42, medium: 36, high: 31, max: 24 };
const AUDIO_BR = { low: '96k', medium: '128k', high: '192k', max: '256k' };
const MP3_Q = { low: 6, medium: 4, high: 2, max: 0 };
const GIF_COLORS = { low: 64, medium: 128, high: 256, max: 256 };

export const even = (v) => Math.max(2, Math.round(v / 2) * 2);
export const evenDown = (v) => Math.max(2, Math.floor(v / 2) * 2);
const num = (v, digits = 3) => Number(v).toFixed(digits);

// Size of the picture before resizing: the crop, or the whole frame.
export function baseSize(src, spec) {
  return spec.crop ? { width: spec.crop.width, height: spec.crop.height } : { width: src.width, height: src.height };
}

// Output size for a size preset (never upscales; always even).
export function presetSize(base, preset, custom) {
  if (preset === 'custom' && custom) return { width: even(custom.width), height: even(custom.height) };
  if (preset === 'half') return { width: even(base.width / 2), height: even(base.height / 2) };
  if (typeof preset === 'number') {
    const short = Math.min(base.width, base.height);
    if (preset < short) {
      const k = preset / short;
      return { width: even(base.width * k), height: even(base.height * k) };
    }
  }
  return { width: evenDown(base.width), height: evenDown(base.height) };
}

export function outputSize(src, spec) {
  return spec.size || presetSize(baseSize(src, spec), 'original');
}

export function trimRange(src, spec) {
  const total = (src.durationMs || 0) / 1000;
  const start = Math.max(0, Math.min(total, spec.trim?.start ?? 0));
  const end = Math.max(start, Math.min(total, spec.trim?.end ?? total));
  return { start, end, total, trimmed: start > 0.001 || end < total - 0.001 };
}

export function outputDuration(src, spec) {
  const { start, end } = trimRange(src, spec);
  return (end - start) / (spec.speed || 1);
}

function needsVideoFilters(src, spec) {
  const natural = presetSize(baseSize(src, spec), 'original');
  const size = outputSize(src, spec);
  return !!spec.crop || size.width !== natural.width || size.height !== natural.height || (spec.speed || 1) !== 1 || !!spec.fps;
}

export function selectedAudioCodec(src, spec) {
  const index = Number.isInteger(spec.audioTrack) && spec.audioTrack >= 0 ? spec.audioTrack : 0;
  return src.audioTracks?.[index]?.codec || (index === 0 || !src.audioTracks ? src.audio : null);
}

// Stream copy (fast, keyframe-accurate cuts) is possible when nothing but trimming
// and muting changes and the source codecs fit the target container.
export function canStreamCopy(src, spec) {
  const f = FORMATS[spec.format];
  if (!f || f.kind === 'gif') return false;
  if ((spec.speed || 1) !== 1) return false;
  const audio = selectedAudioCodec(src, spec);
  if (f.kind === 'audio') return !!audio && f.copyA.includes(audio);
  if (needsVideoFilters(src, spec)) return false;
  if (!f.copyV.includes(src.video)) return false;
  return !audio || spec.mute || f.copyA.includes(audio);
}

export function willStreamCopy(src, spec) {
  const { trimmed } = trimRange(src, spec);
  return canStreamCopy(src, spec) && (!trimmed || !spec.precise);
}

function videoFilterChain(src, spec) {
  const chain = [];
  const c = spec.crop;
  if (c) chain.push(`crop=${evenDown(c.width)}:${evenDown(c.height)}:${Math.round(c.x)}:${Math.round(c.y)}`);
  const base = c ? { width: evenDown(c.width), height: evenDown(c.height) } : { width: src.width, height: src.height };
  const size = outputSize(src, spec);
  if (size.width === evenDown(base.width) && size.height === evenDown(base.height)) {
    if (size.width !== base.width || size.height !== base.height) chain.push(`crop=${size.width}:${size.height}:0:0`); // drop an odd pixel
  } else {
    chain.push(`scale=${size.width}:${size.height}:flags=lanczos`);
  }
  if ((spec.speed || 1) !== 1) chain.push(`setpts=PTS/${spec.speed}`);
  if (spec.fps) chain.push(`fps=${spec.fps}`);
  return chain;
}

/**
 * ffmpeg invocations for an export → { passes: [args[]], durationSec, copy }.
 * GIF needs two passes (palettegen → paletteuse) and a temp palette path.
 */
export function buildExportArgs(src, spec, input, output, { palette } = {}) {
  const f = FORMATS[spec.format];
  if (!f) throw new Error(`unknown format ${spec.format}`);
  const { start, end, trimmed } = trimRange(src, spec);
  const q = QUALITIES.includes(spec.quality) ? spec.quality : 'high';
  const speed = SPEEDS.includes(spec.speed) ? spec.speed : 1;
  const copy = willStreamCopy(src, spec);
  const inArgs = [...(start > 0.001 ? ['-ss', num(start)] : []), ...(trimmed ? ['-t', num(end - start)] : []), '-i', input];
  const durationSec = (end - start) / speed;
  const audioOn = !!src.audio && !spec.mute;
  const atempo = speed !== 1 ? ['-af', `atempo=${speed}`] : [];

  if (f.kind === 'gif') {
    const chain = videoFilterChain(src, { ...spec, fps: spec.fps || 15 }).join(',') || 'null';
    const colors = GIF_COLORS[q];
    const dither = q === 'low' || q === 'medium' ? 'bayer:bayer_scale=3' : 'bayer:bayer_scale=5';
    return {
      copy: false,
      durationSec,
      passes: [
        [...inArgs, '-vf', `${chain},palettegen=max_colors=${colors}:stats_mode=diff`, '-frames:v', '1', '-update', '1', palette],
        [...inArgs, '-i', palette, '-lavfi', `${chain}[v];[v][1:v]paletteuse=dither=${dither}:diff_mode=rectangle`, '-an', '-loop', '0', output],
      ],
    };
  }

  // Kadr recordings can carry the mix + microphone + system audio as separate tracks.
  const track = Number.isInteger(spec.audioTrack) && spec.audioTrack > 0 ? spec.audioTrack : 0;

  if (f.kind === 'audio') {
    if (!src.audio) throw new Error('the video has no audio track');
    const enc = copy ? ['-c:a', 'copy'] : f.a === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', String(MP3_Q[q])] : ['-c:a', 'aac', '-b:a', AUDIO_BR[q]];
    return { copy, durationSec, passes: [[...inArgs, '-vn', '-map', `0:a:${track}`, ...(copy ? [] : atempo), ...enc, output]] };
  }

  const maps = ['-map', '0:v:0', ...(audioOn ? ['-map', `0:a:${track}${track === 0 ? '?' : ''}`] : ['-an'])];
  let codec;
  if (copy) {
    codec = ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
  } else {
    const chain = videoFilterChain(src, spec);
    const v =
      f.v === 'vp9'
        ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(VP9_CRF[q]), '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', X264_PRESET[q], '-crf', String(X264_CRF[q]), '-pix_fmt', 'yuv420p'];
    const a = !audioOn ? [] : [...atempo, ...(f.a === 'opus' ? ['-c:a', 'libopus', '-b:a', AUDIO_BR[q]] : ['-c:a', 'aac', '-b:a', AUDIO_BR[q]])];
    codec = [...(chain.length ? ['-vf', chain.join(',')] : []), ...v, ...a];
  }
  return { copy, durationSec, passes: [[...inArgs, ...maps, ...codec, ...(f.faststart ? ['-movflags', '+faststart'] : []), output]] };
}
