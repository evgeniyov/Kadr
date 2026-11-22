// Renderer-side helpers shared by every window (ES module).
import { t, setLang, resolveLang, getLang, plural } from './i18n/index.mjs';

export { t, plural, getLang };

export const kadr = window.kadr;
export const isMac = kadr.platform === 'darwin';
export const isWin = kadr.platform === 'win32';
export const modKey = isMac ? '⌘' : 'Ctrl';

let settingsCache = null;
const settingsListeners = new Set();

// Call once at page start. Returns { params, settings }.
// - loads window params and settings
// - sets the UI language and translates [data-i18n*] attributes
// - keeps settings in sync (onSettings(settings, patch) is called on change)
export async function initPage({ onSettings } = {}) {
  const [params, settings, locale] = await Promise.all([
    kadr.invoke('win:params'),
    kadr.invoke('settings:get'),
    kadr.invoke('app:locale'),
  ]);
  settingsCache = settings;
  setLang(resolveLang(settings.language, locale));
  document.documentElement.lang = getLang();
  document.documentElement.dataset.platform = kadr.platform;
  applyI18n();
  if (onSettings) settingsListeners.add(onSettings);
  kadr.on('settings:changed', (s, patch) => {
    const langChanged = s.language !== settingsCache?.language;
    settingsCache = s;
    if (langChanged) {
      setLang(resolveLang(s.language, locale));
      document.documentElement.lang = getLang();
      applyI18n();
    }
    for (const fn of settingsListeners) fn(s, patch, { langChanged });
  });
  return { params, settings };
}

export function getSettings() {
  return settingsCache;
}

export function onSettings(fn) {
  settingsListeners.add(fn);
  return () => settingsListeners.delete(fn);
}

// Deep-partial patch, e.g. setSettings({ editor: { color: '#fff' } })
export function setSettings(patch) {
  return kadr.invoke('settings:set', patch);
}

// Translate elements: data-i18n (text), data-i18n-tip (tooltip),
// data-i18n-title (title), data-i18n-placeholder (placeholder).
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = t(n.dataset.i18n)));
  root.querySelectorAll('[data-i18n-tip]').forEach((n) => (n.dataset.tip = t(n.dataset.i18nTip)));
  root.querySelectorAll('[data-i18n-title]').forEach((n) => (n.title = t(n.dataset.i18nTitle)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((n) => (n.placeholder = t(n.dataset.i18nPlaceholder)));
}

// Tiny hyperscript: el('div.cls#id', { onclick, dataset:{}, style:{} }, ...children)
export function el(tag, attrs, ...children) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m?.[1] || 'div');
  (m?.[2]?.match(/[.#][\w-]+/g) || []).forEach((p) => (p[0] === '.' ? node.classList.add(p.slice(1)) : (node.id = p.slice(1))));
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastHost;
export function toast(message, ms = 1800) {
  if (!toastHost) {
    toastHost = el('div.toast-host');
    document.body.append(toastHost);
  }
  const n = el('div.toast', message);
  toastHost.append(n);
  setTimeout(() => {
    n.classList.add('out');
    setTimeout(() => n.remove(), 220);
  }, ms);
}

// Encode a canvas into bytes. format: 'png' | 'jpg' | 'webp'; quality 0..100
export async function canvasToBytes(canvas, format = 'png', quality = 90) {
  const type = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  let src = canvas;
  if (type === 'image/jpeg') {
    // JPEG has no alpha — flatten on white.
    src = document.createElement('canvas');
    src.width = canvas.width;
    src.height = canvas.height;
    const c = src.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, src.width, src.height);
    c.drawImage(canvas, 0, 0);
  }
  const blob = await new Promise((res) => src.toBlob(res, type, quality / 100));
  return new Uint8Array(await blob.arrayBuffer());
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

export function bytesToObjectUrl(bytes, type = 'image/png') {
  return URL.createObjectURL(new Blob([bytes], { type }));
}

// Pretty-print an accelerator ('CommandOrControl+Shift+2' → '⌘⇧2' / 'Ctrl+Shift+2')
export function formatAccelerator(acc) {
  if (!acc) return '';
  const parts = acc.split('+');
  if (isMac) {
    const map = {
      Command: '⌘',
      Cmd: '⌘',
      CommandOrControl: '⌘',
      CmdOrCtrl: '⌘',
      Control: '⌃',
      Ctrl: '⌃',
      Alt: '⌥',
      Option: '⌥',
      Shift: '⇧',
      Super: '⌘',
      Meta: '⌘',
    };
    const order = ['⌃', '⌥', '⇧', '⌘'];
    const mods = parts.slice(0, -1).map((p) => map[p] || p).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return mods.join('') + keyLabel(parts[parts.length - 1]);
  }
  return parts
    .map((p) => ({ CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Command: 'Win', Super: 'Win', Meta: 'Win' })[p] || keyLabel(p))
    .join('+');
}

function keyLabel(k) {
  const map = { Space: isMac ? '␣' : 'Space', Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc', Return: '↩', Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥' };
  return map[k] || k;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Close the window on Escape (optional helper)
export function closeOnEscape() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') kadr.invoke('win:close');
  });
}
