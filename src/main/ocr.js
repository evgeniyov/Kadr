'use strict';
// Text + QR recognition. macOS: Vision via the native helper. Elsewhere (or as a
// fallback): tesseract.js with bundled rus+eng data, and jsQR for QR codes.

const path = require('path');
const { nativeImage } = require('electron');
const ctx = require('./context');
const { toBuffer } = require('./basics');

let nativeOcrRetryAt = 0;
let tessWorker = null;
let tessIdleTimer = null;

async function getTesseract() {
  clearTimeout(tessIdleTimer);
  // Free ~100 MB of wasm memory when OCR hasn't been used for a while.
  tessIdleTimer = setTimeout(async () => {
    const w = tessWorker;
    tessWorker = null;
    if (w) (await w).terminate().catch(() => {});
  }, 3 * 60 * 1000);
  if (!tessWorker) {
    const { createWorker } = require('tesseract.js');
    tessWorker = createWorker(['rus', 'eng'], 1, {
      langPath: path.join(ctx.paths.resources, 'tessdata'),
      cachePath: path.join(ctx.paths.userData, 'tessdata-cache'),
      gzip: true,
      logger: () => {},
      errorHandler: (e) => console.error('[ocr] tesseract', e),
    });
    tessWorker.catch(() => (tessWorker = null));
  }
  return tessWorker;
}

async function tesseractOcr(png) {
  const worker = await getTesseract();
  const { data } = await worker.recognize(png, {}, { blocks: true, text: true });
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = (line.text || '').replace(/\s+$/, '');
        if (!text.trim() || line.confidence < 30) continue;
        const b = line.bbox;
        lines.push({ text, confidence: line.confidence / 100, box: { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 } });
      }
    }
  }
  return { lines };
}

function jsqrScan(png) {
  try {
    const jsQR = require('jsqr');
    let img = nativeImage.createFromBuffer(png);
    let { width, height } = img.getSize();
    // Large images are slow for jsQR; QR codes survive downscaling well.
    const max = 1600;
    if (Math.max(width, height) > max) {
      const k = max / Math.max(width, height);
      img = img.resize({ width: Math.round(width * k), height: Math.round(height * k) });
      ({ width, height } = img.getSize());
    }
    const bgra = img.toBitmap();
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2];
      rgba[i + 1] = bgra[i + 1];
      rgba[i + 2] = bgra[i];
      rgba[i + 3] = 255;
    }
    const res = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
    if (!res?.data) return [];
    const scale = nativeImage.createFromBuffer(png).getSize().width / width;
    const xs = [res.location.topLeftCorner.x, res.location.bottomRightCorner.x, res.location.topRightCorner.x, res.location.bottomLeftCorner.x];
    const ys = [res.location.topLeftCorner.y, res.location.bottomRightCorner.y, res.location.topRightCorner.y, res.location.bottomLeftCorner.y];
    const x = Math.min(...xs) * scale;
    const y = Math.min(...ys) * scale;
    return [{ text: res.data, symbology: 'QR', box: { x, y, width: Math.max(...xs) * scale - x, height: Math.max(...ys) * scale - y } }];
  } catch (e) {
    console.warn('[ocr] jsQR failed', e.message);
    return [];
  }
}

// Recognize text and QR codes in a PNG buffer.
// → { text, lines: [{ text, box, confidence }], qr: [{ text, box }], engine }
async function recognize(pngData) {
  const png = toBuffer(pngData);
  const native = ctx.modules.native;
  const caps = native?.capabilities?.() || {};

  let lines = null;
  let engine = 'tesseract';
  if (caps.ocr && Date.now() >= nativeOcrRetryAt) {
    try {
      const res = await native.ocr(png, { languages: ['ru-RU', 'en-US'] });
      lines = res.lines || [];
      engine = 'vision';
    } catch (e) {
      console.warn('[ocr] native OCR failed, falling back to tesseract', e.message);
      // A broken system model can fail every request for tens of seconds. Keep the
      // bundled offline fallback usable while allowing Vision to recover later.
      if (/CRImageReaderError/.test(e.message)) nativeOcrRetryAt = Date.now() + 60000;
    }
  }
  const qrPromise = (async () => {
    if (caps.barcodes) {
      try {
        return await native.barcodes(png);
      } catch (e) {
        console.warn('[ocr] native barcodes failed', e.message);
      }
    }
    return jsqrScan(png);
  })();
  if (!lines) lines = (await tesseractOcr(png)).lines;
  const qr = (await qrPromise) || [];
  return { text: lines.map((l) => l.text).join('\n'), lines, qr, engine };
}

function register() {
  ctx.handle('native:ocr', (e, { data }) => recognize(data));
  ctx.handle('native:remove-bg', async (e, { data }) => {
    const native = ctx.modules.native;
    if (!native?.capabilities?.().removeBackground) throw new Error('unsupported');
    return native.removeBackground(toBuffer(data));
  });
  ctx.handle('native:capabilities', () => {
    const caps = ctx.modules.native?.capabilities?.() || {};
    return {
      ocr: true, // tesseract fallback is always available
      removeBackground: !!caps.removeBackground,
      systemAudio: !!caps.systemAudio || ctx.isWin,
      scrollInject: !!caps.scroll,
      windowList: !!caps.windowList,
    };
  });
}

module.exports = { register, recognize };
