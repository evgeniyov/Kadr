'use strict';
// Clipboard helpers for Electron 44+, where the clipboard module became async and
// image access goes through ClipboardItem (writeImage/readImage were removed).

const fs = require('fs');
const { clipboard, ClipboardItem } = require('electron');

let imageWriteVersion = 0;
let imageWrites = Promise.resolve();

function queueImageWrite(write) {
  const job = imageWrites.catch(() => {}).then(write);
  imageWrites = job;
  return job;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error('expected binary data');
}

// Write PNG bytes (Buffer/Uint8Array), a nativeImage, or a PNG file path.
function writeImage(src) {
  imageWriteVersion++;
  return queueImageWrite(() => writePng(src));
}

// Reserve the automatic copy before showing the editor. A newer copy request
// cancels it while pending, or writes after it if the OS write already started.
function deferImageWrite() {
  const version = ++imageWriteVersion;
  return (src) => queueImageWrite(async () => {
    if (version !== imageWriteVersion) return false;
    await writePng(src);
    return true;
  });
}

async function writePng(src) {
  let png;
  if (typeof src === 'string') png = await fs.promises.readFile(src);
  else if (src && typeof src.toPNG === 'function') png = src.toPNG();
  else png = toBuffer(src);
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

// → PNG Buffer or null when the clipboard holds no image.
async function readImage() {
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t === 'image/png') || item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const buf = Buffer.from(await blob.arrayBuffer());
    if (type === 'image/png') return buf;
    // Other image formats (e.g. TIFF from macOS apps): convert through nativeImage.
    const img = require('electron').nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return img.toPNG();
  }
  return null;
}

function writeText(text) {
  return clipboard.writeText(String(text ?? ''));
}

function readText() {
  return clipboard.readText();
}

module.exports = { writeImage, deferImageWrite, readImage, writeText, readText };
