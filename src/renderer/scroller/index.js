// Scrolling capture: one page, three roles (frame border, control panel, hidden worker).
import { kadr, initPage, t, $ } from '../../shared/ui.js';
import { Stitcher } from './stitch.js';

// Worker listeners are attached before any await so main never races us.
const pending = [];
let workerHandler = null;
for (const ch of ['scroll:init', 'scroll:grab', 'scroll:finish']) {
  kadr.on(ch, (msg) => (workerHandler ? workerHandler(ch, msg) : pending.push([ch, msg])));
}

const { params } = await initPage();

if (params.role === 'frame') $('#frame').classList.remove('hidden');
else if (params.role === 'panel') setupPanel();
else if (params.role === 'worker') setupWorker();

// ---- panel ---------------------------------------------------------------------
function setupPanel() {
  $('#panel').classList.remove('hidden');
  const manual = params.manual;
  $('#hint').textContent = t(manual ? 'scroll.hintManual' : 'scroll.hintAuto');
  $('#start').classList.toggle('hidden', manual);
  $('#done').classList.toggle('hidden', !manual);
  $('#start').disabled = true;
  $('#done').disabled = true;
  const thumb = $('#thumb');
  const tctx = thumb.getContext('2d');

  kadr.on('scroll:ready', () => {
    $('#start').disabled = false;
    $('#done').disabled = false;
  });
  kadr.on('scroll:progress', (p) => {
    $('#progress').textContent = t('scroll.progress', { h: p.height });
    if (p.thumb) {
      const img = new Image();
      img.onload = () => {
        thumb.width = img.width;
        thumb.height = img.height;
        tctx.drawImage(img, 0, 0);
      };
      img.src = p.thumb;
    }
  });
  kadr.on('scroll:message', (m) => ($('#hint').textContent = m));
  $('#start').addEventListener('click', () => {
    $('#start').classList.add('hidden');
    $('#done').classList.remove('hidden');
    kadr.invoke('scroll:start-auto');
  });
  $('#done').addEventListener('click', () => {
    $('#done').disabled = true;
    kadr.invoke('scroll:finish');
  });
  $('#cancel').addEventListener('click', () => kadr.invoke('scroll:cancel'));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') kadr.invoke('scroll:cancel');
    if (e.key === 'Enter') kadr.invoke('scroll:finish');
  });
}

// ---- worker ----------------------------------------------------------------------
function setupWorker() {
  let video = null;
  let stream = null;
  let canvas = null;
  let cctx = null;
  let crop = null;
  let stitcher = null;
  let flip = false;
  let scale = 1;

  const reply = (id, result, error) => kadr.send('scroll:reply', { id, result, error });

  async function init(msg) {
    const { sourceId, region, displayBounds, scaleFactor, direction, maxHeight } = msg;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: Math.round(displayBounds.width * scaleFactor),
          maxHeight: Math.round(displayBounds.height * scaleFactor),
          maxFrameRate: 30,
        },
      },
    });
    video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
    const k = video.videoWidth / displayBounds.width;
    scale = k;
    crop = {
      x: Math.round(region.x * k),
      y: Math.round(region.y * k),
      w: Math.max(1, Math.round(region.width * k)),
      h: Math.max(1, Math.round(region.height * k)),
    };
    canvas = new OffscreenCanvas(crop.w, crop.h);
    cctx = canvas.getContext('2d', { willReadFrequently: true });
    flip = direction === 'up';
    stitcher = new Stitcher(crop.w, crop.h, { maxHeight: Math.min(32000, maxHeight || 30000) });
    return { width: crop.w, height: crop.h };
  }

  function nextFrame() {
    return new Promise((r) => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => r());
      else setTimeout(r, 50);
      setTimeout(r, 250); // don't wait forever if the screen is static
    });
  }

  async function grab({ expected }) {
    await nextFrame();
    cctx.save();
    if (flip) {
      cctx.translate(0, crop.h);
      cctx.scale(1, -1);
    }
    cctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    cctx.restore();
    const frame = cctx.getImageData(0, 0, crop.w, crop.h);
    const res = stitcher.add(frame, expected || 0);
    return { ...res, thumb: res.changed || res.first ? stitcher.thumbnail(220, flip) : null };
  }

  async function finish() {
    const out = stitcher.compose(flip);
    stream?.getTracks().forEach((tr) => tr.stop());
    if (!out) return { data: null, scale };
    const blob = await out.convertToBlob({ type: 'image/png' });
    return { data: new Uint8Array(await blob.arrayBuffer()), scale };
  }

  workerHandler = async (ch, msg) => {
    try {
      if (ch === 'scroll:init') reply(msg.id, await init(msg));
      else if (ch === 'scroll:grab') reply(msg.id, await grab(msg));
      else if (ch === 'scroll:finish') reply(msg.id, await finish());
    } catch (e) {
      console.error(e);
      reply(msg.id, null, String(e.message || e));
    }
  };
  pending.splice(0).forEach(([ch, msg]) => workerHandler(ch, msg));
}
