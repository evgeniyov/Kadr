'use strict';
// Generates icons and the shutter sound.
// Run: ./node_modules/.bin/electron . --dev-script=scripts/make-assets.js
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
fs.mkdirSync(path.join(BUILD, 'tray'), { recursive: true });

// Drawing code runs inside a hidden window; each function returns a PNG data URL.
const DRAW = `
function squircle(c, x, y, s, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + s - r, y); c.quadraticCurveTo(x + s, y, x + s, y + r);
  c.lineTo(x + s, y + s - r); c.quadraticCurveTo(x + s, y + s, x + s - r, y + s);
  c.lineTo(x + r, y + s); c.quadraticCurveTo(x, y + s, x, y + s - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}
function brackets(c, x, y, s, len, lw, color) {
  c.strokeStyle = color; c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round';
  const e = x + s, b = y + s;
  c.beginPath();
  c.moveTo(x, y + len); c.lineTo(x, y); c.lineTo(x + len, y);
  c.moveTo(e - len, y); c.lineTo(e, y); c.lineTo(e, y + len);
  c.moveTo(e, b - len); c.lineTo(e, b); c.lineTo(e - len, b);
  c.moveTo(x + len, b); c.lineTo(x, b); c.lineTo(x, b - len);
  c.stroke();
}
function appIcon(size) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  const m = size * 0.1, s = size - 2 * m;          // macOS icon grid: ~10% margin
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.28)'; c.shadowBlur = size * 0.03; c.shadowOffsetY = size * 0.012;
  squircle(c, m, m, s, s * 0.225);
  const g = c.createLinearGradient(m, m, m + s, m + s);
  g.addColorStop(0, '#4F8BFF'); g.addColorStop(0.55, '#5B5CF0'); g.addColorStop(1, '#8B45E8');
  c.fillStyle = g; c.fill();
  c.restore();
  // subtle top highlight
  c.save(); squircle(c, m, m, s, s * 0.225); c.clip();
  const hl = c.createLinearGradient(0, m, 0, m + s * 0.55);
  hl.addColorStop(0, 'rgba(255,255,255,0.22)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = hl; c.fillRect(m, m, s, s * 0.55); c.restore();
  const p = s * 0.24;
  brackets(c, m + p, m + p, s - 2 * p, s * 0.14, s * 0.058, '#fff');
  // lens + record dot
  c.beginPath(); c.arc(size / 2, size / 2, s * 0.12, 0, Math.PI * 2);
  c.fillStyle = '#fff'; c.fill();
  c.beginPath(); c.arc(size / 2, size / 2, s * 0.066, 0, Math.PI * 2);
  c.fillStyle = '#FF3B30'; c.fill();
  return cv.toDataURL('image/png');
}
function trayTemplate(size, rec) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  const k = size / 18;
  brackets(c, 2 * k, 2 * k, 14 * k, 4.2 * k, 1.6 * k, '#000');
  c.fillStyle = '#000';
  c.beginPath();
  if (rec) c.arc(9 * k, 9 * k, 3.6 * k, 0, Math.PI * 2);
  else c.arc(9 * k, 9 * k, 2.3 * k, 0, Math.PI * 2);
  c.fill();
  return cv.toDataURL('image/png');
}
function trayColor(size, rec) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  if (rec) {
    c.beginPath(); c.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
    c.fillStyle = '#FF3B30'; c.fill();
    c.fillStyle = '#fff'; const q = size * 0.28; c.fillRect(size / 2 - q / 2, size / 2 - q / 2, q, q);
    return cv.toDataURL('image/png');
  }
  squircle(c, 0.5, 0.5, size - 1, size * 0.24);
  const g = c.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#4F8BFF'); g.addColorStop(1, '#7C4DEB');
  c.fillStyle = g; c.fill();
  brackets(c, size * 0.22, size * 0.22, size * 0.56, size * 0.16, Math.max(1.4, size * 0.09), '#fff');
  c.beginPath(); c.arc(size / 2, size / 2, size * 0.1, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
  return cv.toDataURL('image/png');
}
`;

function wav(file) {
  // A short camera-shutter-like click: two filtered noise bursts.
  const rate = 44100;
  const n = Math.round(rate * 0.16);
  const pcm = Buffer.alloc(n * 2);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const burst1 = Math.exp(-t * 90);
    const burst2 = t > 0.06 ? Math.exp(-(t - 0.06) * 70) * 0.8 : 0;
    const noise = Math.random() * 2 - 1;
    lp += 0.35 * (noise - lp);
    const v = Math.max(-1, Math.min(1, lp * (burst1 + burst2) * 1.6));
    pcm.writeInt16LE(Math.round(v * 32767 * 0.7), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

module.exports = async (ctx, h) => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<body></body>');
  await win.webContents.executeJavaScript(DRAW);
  const save = async (expr, file) => {
    const url = await win.webContents.executeJavaScript(expr);
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  };
  await save('appIcon(1024)', path.join(BUILD, 'icon.png'));
  await save('appIcon(256)', path.join(ROOT, 'src', 'shared', 'icon.png'));
  await save('appIcon(128)', path.join(BUILD, 'drag.png'));
  await save('trayTemplate(18,false)', path.join(BUILD, 'tray', 'trayTemplate.png'));
  await save('trayTemplate(36,false)', path.join(BUILD, 'tray', 'trayTemplate@2x.png'));
  await save('trayTemplate(18,true)', path.join(BUILD, 'tray', 'recTemplate.png'));
  await save('trayTemplate(36,true)', path.join(BUILD, 'tray', 'recTemplate@2x.png'));
  await save('trayColor(16,false)', path.join(BUILD, 'tray', 'tray.png'));
  await save('trayColor(32,false)', path.join(BUILD, 'tray', 'tray@2x.png'));
  await save('trayColor(16,true)', path.join(BUILD, 'tray', 'rec.png'));
  await save('trayColor(32,true)', path.join(BUILD, 'tray', 'rec@2x.png'));
  wav(path.join(BUILD, 'shutter.wav'));
  console.log('assets written');
  h.quit();
};
