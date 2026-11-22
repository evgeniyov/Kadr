// Encoding rules shared by the main process (capture sizing, via require(esm))
// and the recorder worker (codec string, bitrates).

// H.264 levels we may request: max frame size (macroblocks) and max macroblocks/s.
const H264_LEVELS = [
  { hex: '28', fs: 8192, mbps: 245760 }, // 4.0 — 1080p30
  { hex: '2A', fs: 8704, mbps: 522240 }, // 4.2 — 1080p60
  { hex: '32', fs: 22080, mbps: 589824 }, // 5.0
  { hex: '33', fs: 36864, mbps: 983040 }, // 5.1 — 4K30
  { hex: '34', fs: 36864, mbps: 2073600 }, // 5.2 — 4K60
];
const MAX_LEVEL = H264_LEVELS[H264_LEVELS.length - 1];

// Hardware encoders (VideoToolbox, Media Foundation) top out around 4096 px per side.
export const MAX_SIDE = 4096;

const macroblocks = (w, h) => Math.ceil(w / 16) * Math.ceil(h / 16);

export const even = (v) => Math.max(2, Math.floor(v / 2) * 2);

// Scale factor (≤ 1) that makes a w×h picture at `fps` encodable in real time
// (H.264 level 5.2 limits; also a sane budget for VP9).
export function fitScale(w, h, fps = 30) {
  if (!(w > 0 && h > 0)) return 1;
  const maxMbs = Math.min(MAX_LEVEL.fs, Math.floor(MAX_LEVEL.mbps / Math.max(1, fps)));
  let k = Math.min(1, MAX_SIDE / Math.max(w, h));
  // Continuous estimate first, then nudge down until the macroblock count fits.
  k = Math.min(k, Math.sqrt((maxMbs * 256) / (w * h)));
  while (k > 0.1 && macroblocks(even(w * k), even(h * k)) > maxMbs) k *= 0.98;
  return k;
}

// Smallest H.264 level (hex, e.g. '33') that covers the size and frame rate.
export function h264Level(w, h, fps = 30) {
  const mbs = macroblocks(w, h);
  const rate = mbs * fps;
  return (H264_LEVELS.find((l) => mbs <= l.fs && rate <= l.mbps) || MAX_LEVEL).hex;
}

const QUALITY_BPP = { low: 0.045, medium: 0.075, high: 0.11, max: 0.17 };

// Video bitrate for screen content: bits-per-pixel × pixels × fps (sub-linear in fps).
export function videoBitrate(w, h, fps = 30, quality = 'high') {
  const bpp = QUALITY_BPP[quality] ?? QUALITY_BPP.high;
  const bps = w * h * bpp * 30 * Math.pow(Math.max(1, fps) / 30, 0.8);
  return Math.round(Math.min(80e6, Math.max(1.5e6, bps)));
}

export function audioBitrate(quality = 'high') {
  return quality === 'max' ? 192000 : quality === 'high' ? 160000 : 128000;
}

// MediaRecorder mime types to try, best first. The preferred container comes first,
// the other one is a fallback (post-processing converts to the requested format).
export function mimeCandidates(format, { audio, level = '28' }) {
  const avc = `avc1.6400${level}`; // High profile, no constraint flags, level
  const mp4 = audio
    ? [`video/mp4;codecs=${avc},mp4a.40.2`, 'video/mp4;codecs=avc1,mp4a.40.2', `video/mp4;codecs=${avc},opus`, 'video/mp4']
    : [`video/mp4;codecs=${avc}`, 'video/mp4;codecs=avc1', 'video/mp4'];
  const webm = audio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return format === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
}

export const extForMime = (mime) => (/^video\/mp4/.test(mime) ? 'mp4' : 'webm');
