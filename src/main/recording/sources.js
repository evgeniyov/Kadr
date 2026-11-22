'use strict';
// Capture sources for the recorder: displays and windows from desktopCapturer,
// mapped to Electron displays; Kadr's own windows are filtered out.

const { BrowserWindow, desktopCapturer, screen } = require('electron');
const ctx = require('../context');

const jpegDataUrl = (img, q = 82) => `data:image/jpeg;base64,${img.toJPEG(q).toString('base64')}`;

function displayName(d, index) {
  return d.label || ctx.t('recorder.screen.display', { n: index + 1 });
}

// Match by display_id. Legacy sources without IDs can only be matched by order
// when the complete display list is present; never substitute a different screen.
function matchScreens(sources, displays) {
  const byOrder = sources.length === displays.length && sources.every((s) => !s.display_id);
  return displays.map((d, i) => {
    const src = sources.find((s) => s.display_id && String(s.display_id) === String(d.id)) || (byOrder ? sources[i] : null);
    return { display: d, source: src || null };
  });
}

async function listScreens({ thumbWidth = 400 } = {}) {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const maxAspect = Math.max(...displays.map((d) => d.bounds.width / d.bounds.height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbWidth, height: Math.round(thumbWidth / Math.min(maxAspect, 16 / 10)) },
  });
  return matchScreens(sources, displays)
    .filter((m) => m.source)
    .map(({ display: d, source }, i) => ({
      id: source.id,
      displayId: d.id,
      name: displayName(d, i),
      primary: d.id === primaryId,
      width: d.bounds.width,
      height: d.bounds.height,
      scaleFactor: d.scaleFactor,
      thumbnail: source.thumbnail.isEmpty() ? null : jpegDataUrl(source.thumbnail),
    }));
}

function ownMediaSourceIds() {
  const ids = new Set();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) ids.add(w.getMediaSourceId());
    } catch {
      /* window without a native handle yet */
    }
  }
  return ids;
}

async function listWindows({ thumbWidth = 360 } = {}) {
  const own = ownMediaSourceIds();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: thumbWidth, height: Math.round(thumbWidth * 0.625) },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => !own.has(s.id) && s.name && !s.thumbnail.isEmpty())
    .filter((s) => {
      const { width, height } = s.thumbnail.getSize();
      return width >= 24 && height >= 16;
    })
    .map((s) => {
      const size = s.thumbnail.getSize();
      return {
        id: s.id,
        name: s.name,
        aspect: size.width / size.height,
        thumbnail: jpegDataUrl(s.thumbnail),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32, height: 32 }).toDataURL() : null,
      };
    });
}

// desktopCapturer id of the screen source for a display (no thumbnails → fast).
async function screenSourceId(displayId) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const match = matchScreens(sources, screen.getAllDisplays()).find((m) => String(m.display.id) === String(displayId));
  return match?.source?.id || null;
}

async function windowSourceExists(sourceId) {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  return sources.some((s) => s.id === sourceId);
}

// ---- Dev-only fake sources (tests must not capture the real screen) -----------
function svgThumb(w, h, hue, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,40%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<rect x="${w * 0.12}" y="${h * 0.16}" width="${w * 0.5}" height="${h * 0.56}" rx="6" fill="#fff" opacity=".85"/>
<rect x="${w * 0.12}" y="${h * 0.16}" width="${w * 0.5}" height="${h * 0.08}" rx="4" fill="#000" opacity=".12"/>
<text x="${w * 0.16}" y="${h * 0.45}" font-family="Helvetica" font-size="${h * 0.1}" fill="#333">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function fakeScreens() {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const list = displays.map((d, i) => ({
    id: `screen:${d.id}:0`,
    displayId: d.id,
    name: displayName(d, i),
    primary: d.id === primaryId,
    width: d.bounds.width,
    height: d.bounds.height,
    scaleFactor: d.scaleFactor,
    thumbnail: svgThumb(400, Math.round((400 * d.bounds.height) / d.bounds.width), 210 + i * 70, 'Desktop'),
  }));
  // Pretend there is a second display so the multi-display layout can be checked.
  if (list.length === 1) list.push({ ...list[0], id: 'screen:fake:0', displayId: 'fake', name: 'DELL U2723QE', primary: false, width: 2560, height: 1440, scaleFactor: 1, thumbnail: svgThumb(400, 225, 20, 'Desktop 2') });
  return list;
}

function fakeWindows() {
  const apps = [
    ['Safari — Kadr: скриншоты и запись экрана', 200, 1.6],
    ['Terminal — zsh — 120×40', 120, 1.5],
    ['Figma — Onboarding flow', 280, 1.78],
    ['Telegram', 190, 0.8],
    ['Visual Studio Code — recording.js', 230, 1.6],
    ['Finder — Загрузки', 30, 1.45],
    ['Notes', 45, 1.3],
  ];
  return apps.map(([name, hue, aspect], i) => ({
    id: `window:${1000 + i}:0`,
    name,
    aspect,
    thumbnail: svgThumb(360, Math.round(360 / aspect), hue, name.split(' ')[0]),
    appIcon: svgThumb(32, 32, hue, ''),
  }));
}

module.exports = { listScreens, listWindows, screenSourceId, windowSourceExists, fakeScreens, fakeWindows, displayName };
