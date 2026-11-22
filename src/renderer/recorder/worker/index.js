// Hidden recorder worker: captures a display/window (or a synthetic test source),
// crops/normalises frames, mixes audio with WebAudio and streams MediaRecorder
// chunks to the main process. Driven by 'recorder:cmd' messages from main.
import { initPage, kadr } from '../../../shared/ui.js';
import { audioBitrate, even, extForMime, h264Level, mimeCandidates, videoBitrate } from '../shared/encoding.mjs';

const { params: P } = await initPage();

const cleanups = [];
const warnings = [];
let pipeline = null;
let mixer = null;
let recorder = null;
let stemRecorders = []; // audio-only recorders of each source (see prepare)
const stemChains = {};
let micMeter = null;
let levelTimer = null;
let chunkChain = Promise.resolve();
let bytes = 0;
let writeFailed = false;
let stopping = false;
let endedReported = false;

const report = (type, data = {}) => kadr.invoke('recorder:worker-event', { type, sessionId: P.sessionId, ...data }).catch(() => {});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class StageError extends Error {
  constructor(code, err) {
    super(err?.message || String(err));
    this.code = code;
    this.cause = err;
  }
}

// ---- Video sources -----------------------------------------------------------

async function desktopTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: P.sourceId,
        maxWidth: P.capture.maxWidth,
        maxHeight: P.capture.maxHeight,
        maxFrameRate: P.fps,
      },
    },
  });
  return stream.getVideoTracks()[0];
}

// Dev/test source: an animated canvas (four coloured quadrants, moving box, frame
// counter) pushed through a track generator — no screen access needed.
function testTrack() {
  const w = even(P.capture.maxWidth);
  const h = even(P.capture.maxHeight);
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { alpha: false });
  const gen = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = gen.writable.getWriter();
  const t0 = performance.now();
  let n = 0;
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    const quads = ['#e53935', '#43a047', '#1e88e5', '#fdd835'];
    quads.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect((i % 2) * (w / 2), Math.floor(i / 2) * (h / 2), w / 2, h / 2);
    });
    const s = h / 6;
    g.fillStyle = '#fff';
    g.fillRect((Math.sin(t * 1.7) * 0.5 + 0.5) * (w - s), (Math.cos(t * 1.1) * 0.5 + 0.5) * (h - s), s, s);
    g.fillStyle = '#000';
    g.font = `bold ${Math.round(h / 14)}px sans-serif`;
    g.fillText(`#${n++}  ${t.toFixed(2)}s`, w * 0.03, h * 0.09);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
    writer.write(frame).catch(() => frame.close());
  };
  const timer = setInterval(draw, 1000 / P.fps);
  const end = () => {
    clearInterval(timer);
    writer.close().catch(() => {});
  };
  cleanups.push(end);
  if (P.testEndAfterMs) setTimeout(end, P.testEndAfterMs); // simulate the window/display going away
  return gen;
}

// ---- Frame pipeline ----------------------------------------------------------
// Every frame goes processor → transform → generator. The transform crops to the
// region (even, aligned physical pixels) and keeps the output size constant: if the
// source changes size mid-recording it is letterboxed into the first size.

function frameTransform() {
  let outW = 0;
  let outH = 0;
  let canvas = null;
  let g = null;
  return (frame) => {
    const vr = frame.visibleRect;
    if (!vr?.width || !vr?.height) return null;
    let r = vr;
    if (P.crop) {
      // Physical px per DIP, from the real frame size (capture may be downscaled).
      const sx = vr.width / P.display.width;
      const sy = vr.height / P.display.height;
      r = { x: vr.x + P.crop.x * sx, y: vr.y + P.crop.y * sy, width: P.crop.width * sx, height: P.crop.height * sy };
    }
    const x = Math.min(Math.max(vr.x, Math.floor(r.x / 2) * 2), vr.x + vr.width - 2);
    const y = Math.min(Math.max(vr.y, Math.floor(r.y / 2) * 2), vr.y + vr.height - 2);
    const w = even(Math.min(Math.round(r.x + r.width) - x, vr.x + vr.width - x));
    const h = even(Math.min(Math.round(r.y + r.height) - y, vr.y + vr.height - y));
    if (!outW) [outW, outH] = [w, h];

    if (w === outW && h === outH) {
      const whole = x === vr.x && y === vr.y && w === vr.width && h === vr.height;
      return whole ? new VideoFrame(frame) : new VideoFrame(frame, { visibleRect: { x, y, width: w, height: h } });
    }
    if (!canvas) {
      canvas = new OffscreenCanvas(outW, outH);
      g = canvas.getContext('2d', { alpha: false });
    }
    const k = Math.min(outW / w, outH / h);
    const dw = Math.round(w * k);
    const dh = Math.round(h * k);
    g.fillStyle = '#000';
    g.fillRect(0, 0, outW, outH);
    g.drawImage(frame, x - vr.x, y - vr.y, w, h, Math.round((outW - dw) / 2), Math.round((outH - dh) / 2), dw, dh);
    return new VideoFrame(canvas, { timestamp: frame.timestamp });
  };
}

function framePipeline(source) {
  const reader = new MediaStreamTrackProcessor({ track: source }).readable.getReader();
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const transform = frameTransform();
  let closed = false;
  let firstSize;
  const first = new Promise((r) => (firstSize = r));

  (async () => {
    let reason = 'source ended';
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || closed) {
          frame?.close();
          break;
        }
        let out = null;
        try {
          out = transform(frame);
        } finally {
          frame.close(); // the output frame holds its own reference
        }
        if (!out) continue;
        firstSize({ width: out.displayWidth, height: out.displayHeight });
        try {
          await writer.write(out); // the generator's sink closes the frame
        } catch (e) {
          out.close();
          throw e;
        }
      }
    } catch (e) {
      reason = e?.message || String(e);
    }
    if (!closed) onSourceEnded(reason);
  })();

  return {
    track: generator,
    first,
    stop() {
      closed = true;
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      generator.stop();
    },
  };
}

// ---- Audio -------------------------------------------------------------------

class Mixer {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.dest = this.ctx.createMediaStreamDestination();
    this.gains = {};
    this.stems = {}; // name → destination carrying only that source (after its gain)
  }
  addStream(name, stream, volume) {
    return this.addNode(name, this.ctx.createMediaStreamSource(stream), volume);
  }
  addNode(name, node, volume) {
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    node.connect(gain).connect(this.dest);
    const stem = this.ctx.createMediaStreamDestination();
    gain.connect(stem);
    this.stems[name] = stem;
    this.gains[name] = gain;
    return gain;
  }
  setGain(name, v) {
    this.gains[name]?.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
  // Peak level (0..1) of an input after its gain, i.e. 0 while muted.
  meter(name) {
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.gains[name].connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    return () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      return Math.min(1, peak);
    };
  }
  get track() {
    return this.dest.stream.getAudioTracks()[0];
  }
  close() {
    this.ctx.close().catch(() => {});
  }
}

async function micStream() {
  const base = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
  const id = P.mic.deviceId;
  const specific = id && id !== 'default';
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: specific ? { ...base, deviceId: { exact: id } } : base });
  } catch (e) {
    if (!specific || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(e.name)) throw e;
    warnings.push('mic-fallback');
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }
}

// Windows: Chromium's desktop audio loopback. It must be requested together with a
// desktop video track, which we drop right away.
async function loopbackStream() {
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } },
  });
  s.getVideoTracks().forEach((tr) => tr.stop());
  if (!s.getAudioTracks().length) throw new Error('no loopback audio track');
  return new MediaStream(s.getAudioTracks());
}

function testTone(ctx, frequency = 440) {
  // A tone pulsing twice a second, so level meters and the output show activity.
  const osc = ctx.createOscillator();
  osc.frequency.value = frequency;
  const am = ctx.createGain();
  am.gain.value = 0.25;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 2;
  const depth = ctx.createGain();
  depth.gain.value = 0.2;
  lfo.connect(depth).connect(am.gain);
  osc.connect(am);
  osc.start();
  lfo.start();
  cleanups.push(() => {
    osc.stop();
    lfo.stop();
  });
  return am;
}

async function setupAudio() {
  const wantMic = P.mic.enabled;
  const wantLoop = !!P.loopback;
  if (!wantMic && !wantLoop) return;
  let mic = null;
  let loop = null;
  if (wantMic && P.test && P.testFail === 'mic') throw new StageError('mic', new Error('Could not start audio source'));
  if (wantMic && !P.test) {
    try {
      mic = await micStream();
    } catch (e) {
      throw new StageError(e.name === 'NotAllowedError' ? 'mic-permission' : 'mic', e);
    }
    cleanups.push(() => mic.getTracks().forEach((tr) => tr.stop()));
  }
  if (wantLoop && !P.test) {
    try {
      loop = await loopbackStream();
    } catch (e) {
      throw new StageError('system-audio', e);
    }
    cleanups.push(() => loop.getTracks().forEach((tr) => tr.stop()));
  }
  mixer = new Mixer();
  await mixer.ctx.resume().catch(() => {});
  if (wantMic) {
    if (P.test) mixer.addNode('mic', testTone(mixer.ctx), P.mic.volume ?? 1);
    else mixer.addStream('mic', mic, P.mic.volume ?? 1);
    micMeter = mixer.meter('mic');
  }
  if (loop) mixer.addStream('system', loop, P.systemVolume ?? 1);
  else if (wantLoop && P.test) mixer.addNode('system', testTone(mixer.ctx, 1000), P.systemVolume ?? 1);
}

// ---- Recording -----------------------------------------------------------------

function chooseMime(w, h, audio) {
  const level = h264Level(w, h, P.fps);
  return mimeCandidates(P.format, { audio, level }).find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

async function prepare() {
  let source;
  try {
    source = P.test ? testTrack() : await desktopTrack();
  } catch (e) {
    throw new StageError(e.name === 'NotAllowedError' ? 'screen-permission' : 'capture', e);
  }
  cleanups.push(() => source.stop());
  source.addEventListener('ended', () => onSourceEnded('track ended'));
  pipeline = framePipeline(source);
  const size = await Promise.race([pipeline.first, delay(8000).then(() => null)]);
  if (!size) throw new StageError('capture', new Error('no video frames from the source'));

  await setupAudio();

  const tracks = [pipeline.track, ...(mixer ? [mixer.track] : [])];
  const mimeType = chooseMime(size.width, size.height, !!mixer);
  try {
    recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: videoBitrate(size.width, size.height, P.fps, P.quality),
      ...(mixer ? { audioBitsPerSecond: audioBitrate(P.quality) } : {}),
      videoKeyFrameIntervalDuration: 2000, // keyframe every 2 s → seekable, robust chunks
    });
  } catch (e) {
    throw new StageError('encoder', e);
  }
  recorder.ondataavailable = (e) => e.data?.size && enqueueChunk(e.data);
  recorder.onerror = (e) => report('error', { code: 'encoder', message: e.error?.message || 'MediaRecorder error' });
  recorder.onstart = () => report('started', { at: Date.now() });

  // Microphone and system audio mixed live (Windows loopback): also record each one alone,
  // so the saved video can drop the microphone and keep the system sound, or vice versa.
  if (mixer?.stems.mic && mixer?.stems.system) {
    const stemMime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (stemMime) {
      stemRecorders = ['mic', 'system'].map((name) => {
        const r = new MediaRecorder(mixer.stems[name].stream, { mimeType: stemMime, audioBitsPerSecond: audioBitrate(P.quality) });
        r.stemName = name;
        r.ondataavailable = (e) => e.data?.size && enqueueStem(name, e.data);
        return r;
      });
    }
  }

  const type = mimeType || 'video/webm';
  report('ready', {
    mimeType: type,
    ext: extForMime(type),
    width: size.width,
    height: size.height,
    hasAudio: !!mixer,
    hasMic: !!micMeter,
    stems: stemRecorders.map((r) => r.stemName),
    warnings,
  });
}

function enqueueChunk(blob) {
  chunkChain = chunkChain
    .then(async () => {
      if (writeFailed) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (!(await kadr.invoke('recorder:chunk', buf))) {
        writeFailed = true; // main already knows and is stopping the session
        return;
      }
      bytes += buf.byteLength;
    })
    .catch((e) => {
      writeFailed = true;
      report('error', { code: 'write', message: e.message });
    });
}

// Stem chunks: best effort, a failure only costs the separate track.
function enqueueStem(name, blob) {
  stemChains[name] = (stemChains[name] || Promise.resolve())
    .then(async () => kadr.invoke('recorder:stem-chunk', { name, data: new Uint8Array(await blob.arrayBuffer()) }))
    .catch(() => {});
}

function start() {
  if (!recorder || recorder.state !== 'inactive') return;
  recorder.start(1000);
  for (const r of stemRecorders) r.start(1000);
  if (micMeter) levelTimer = setInterval(() => report('level', { level: micMeter() }), 125);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(levelTimer);
  const stopOne = (r) =>
    r && r.state !== 'inactive'
      ? new Promise((resolve) => {
          r.addEventListener('stop', resolve, { once: true });
          try {
            r.stop();
          } catch {
            resolve();
          }
        })
      : null;
  await Promise.all([recorder, ...stemRecorders].map(stopOne));
  await chunkChain; // the last chunk is queued before 'stop' fires
  await Promise.all(Object.values(stemChains));
  teardown();
  report('stopped', { bytes, writeFailed });
}

function onSourceEnded(reason) {
  if (stopping || endedReported) return;
  endedReported = true;
  report('ended', { reason });
}

function teardown() {
  endedReported = true; // tracks we stop ourselves are not "the source went away"
  clearInterval(levelTimer);
  pipeline?.stop();
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* already stopped */
    }
  }
  mixer?.close();
}

kadr.on('recorder:cmd', ({ cmd, muted }) => {
  try {
    if (cmd === 'start') start();
    else if (cmd === 'pause' && recorder?.state === 'recording') {
      recorder.pause();
      stemRecorders.forEach((r) => r.state === 'recording' && r.pause());
      report('paused');
    } else if (cmd === 'resume' && recorder?.state === 'paused') {
      recorder.resume();
      stemRecorders.forEach((r) => r.state === 'paused' && r.resume());
      report('resumed');
    } else if (cmd === 'mute') mixer?.setGain('mic', muted ? 0 : (P.mic.volume ?? 1));
    else if (cmd === 'stop') stop();
  } catch (e) {
    report('error', { code: 'encoder', message: e.message });
  }
});

window.addEventListener('beforeunload', teardown);

try {
  await prepare();
} catch (e) {
  console.error('[worker] prepare failed', e.code, e.message);
  teardown();
  report('error', { code: e.code || 'capture', message: e.message });
}
