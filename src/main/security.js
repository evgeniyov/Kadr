'use strict';
const fs = require('fs');
const path = require('path');
const policy = require('./ipc-policy.json');

function pageUrl(page) { return `kadr://app/renderer/${page}/index.html`; }
function trustedSender(event, entry) {
  const wc = event?.sender;
  const frame = event?.senderFrame;
  return !!(entry && wc && !wc.isDestroyed() && frame && frame === wc.mainFrame &&
    frame.url === pageUrl(entry.page) && wc.getURL() === pageUrl(entry.page));
}
function channelAllowed(page, channel, mode) {
  const rules = policy[page];
  return !!rules && (rules[mode]?.includes(channel) || (mode === 'send' && rules.internal.includes(channel)));
}
function localOrigin(value) {
  try { const u = new URL(value); return u.protocol === 'kadr:' && u.host === 'app' && !u.username && !u.password; }
  catch { return false; }
}
function permissionAllowed(wc, entry, permission, details = {}) {
  if (!wc || !entry || wc.isDestroyed() || wc.getURL() !== pageUrl(entry.page)) return false;
  if (details.isMainFrame === false) return false;
  for (const field of ['requestingOrigin', 'securityOrigin', 'requestingUrl']) {
    if (details[field] && !localOrigin(details[field])) return false;
  }
  if (['clipboard-read', 'clipboard-sanitized-write'].includes(permission)) return ['editor', 'pin'].includes(entry.page);
  if (permission === 'display-capture') return entry.page === 'recorder/worker';
  if (permission !== 'media') return false;
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  if (types.some((t) => !['audio', 'video'].includes(t))) return false;
  if (entry.page === 'scroller') return entry.params?.role === 'worker' && types.length > 0 && types.every((t) => t === 'video');
  if (!['recorder/panel', 'recorder/worker', 'settings'].includes(entry.page)) return false;
  return entry.page === 'recorder/worker' || types.every((t) => t === 'audio');
}
function realPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('Invalid file path');
  return fs.realpathSync(file);
}
function safeBase(name) {
  if (typeof name !== 'string') throw new Error('Invalid file name');
  return name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 160) || 'Kadr';
}
function safeExtension(ext) {
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'].includes(ext)) throw new Error('Unsupported file extension');
  return ext;
}
function assertSettingsPatch(page, patch) {
  const sections = page === 'settings' ? null : page === 'editor' ? ['editor', 'colorFormat'] : page === 'recorder/panel' ? ['recording'] : [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe settings key');
      visit(child);
    }
  };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings patch');
  if (sections && Object.keys(patch).some((key) => !sections.includes(key))) throw new Error('Settings access denied');
  visit(patch);
}
module.exports = { trustedSender, channelAllowed, permissionAllowed, realPath, safeBase, safeExtension, assertSettingsPatch };
