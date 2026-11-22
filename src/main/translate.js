'use strict';
// Translation of recognised text. macOS: Apple's on-device Translation framework via the
// native helper (offline, the text never leaves the Mac). Elsewhere, or for language pairs
// macOS can't translate, the text can be opened in an online translator instead.

const { shell, dialog } = require('electron');
const ctx = require('./context');

// OCR returns visual lines, and prose wraps in the middle of sentences. A line is joined
// with the next one when it doesn't end a sentence and the next continues in lowercase;
// every other break (UI labels, list items, headings) stays a separate segment.
function segments(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const prev = out[out.length - 1];
    const continues = prev && line && !/[.!?:;…»"”)]$/.test(prev) && /^[a-zа-яё(«"“]/.test(line);
    if (continues) out[out.length - 1] = `${prev.replace(/-$/, '')}${prev.endsWith('-') ? '' : ' '}${line}`;
    else out.push(line);
  }
  return out;
}

// The user's language by default; text already in it goes to English instead.
function targetFor(lang) {
  const pref = ctx.settings.get('translateTo') || 'ru';
  const base = String(lang || '').split('-')[0];
  if (base === pref) return pref === 'en' ? 'ru' : 'en';
  return pref;
}

function webUrl(text, to) {
  return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(to || targetFor(''))}&text=${encodeURIComponent(String(text).slice(0, 5000))}&op=translate`;
}

/**
 * → { text, from, to }                               translated
 *   { error: 'not-installed', from, to }             languages must be downloaded first
 *   { error: 'unsupported', from?, to }              no on-device translation (use openWeb)
 */
async function translateText(text) {
  const src = String(text || '').trim();
  if (!src) return { text: '', from: null, to: null };
  const native = ctx.modules.native;
  if (!native?.canTranslate?.()) return { error: 'unsupported', to: targetFor('') };
  const detected = await native.translation.detect(src).catch(() => null);
  const from = detected?.language || 'en';
  const to = targetFor(from);
  try {
    const out = await native.translation.translate(segments(src), from, to);
    return { text: out.join('\n'), from, to };
  } catch (e) {
    if (e.code === 'NOT_INSTALLED') return { error: 'not-installed', from, to };
    if (e.code === 'UNSUPPORTED_PAIR' || e.code === 'UNSUPPORTED') return { error: 'unsupported', from, to };
    throw e;
  }
}

/**
 * Translate separate fragments (e.g. the text blocks of an image), keeping their order.
 * → { texts, from, to } or { error, from?, to } like translateText.
 */
async function translateList(texts) {
  const list = (texts || []).map((s) => String(s || ''));
  const native = ctx.modules.native;
  if (!native?.canTranslate?.()) return { error: 'unsupported', to: targetFor('') };
  const detected = await native.translation.detect(list.join('\n')).catch(() => null);
  const from = detected?.language || 'en';
  const to = targetFor(from);
  try {
    return { texts: await native.translation.translate(list, from, to), from, to };
  } catch (e) {
    if (e.code === 'NOT_INSTALLED') return { error: 'not-installed', from, to };
    if (e.code === 'UNSUPPORTED_PAIR' || e.code === 'UNSUPPORTED') return { error: 'unsupported', from, to };
    throw e;
  }
}

// macOS shows its own "download languages" prompt → true when ready.
function prepare(from, to) {
  const native = ctx.modules.native;
  if (!native?.canTranslate?.()) return Promise.resolve(false);
  return native.translation.prepare(from || 'en', to || targetFor('en'), 'Kadr', ctx.t('translate.downloading'));
}

async function openWeb(text, to) {
  const { response } = await dialog.showMessageBox({
    type: 'question', message: ctx.t('translate.webConfirm'), detail: ctx.t('translate.webDetail'),
    buttons: [ctx.t('translate.webSend'), ctx.t('common.cancel')], defaultId: 1, cancelId: 1,
  });
  if (response !== 0) return false;
  await shell.openExternal(webUrl(text, to));
  return true;
}

async function status() {
  const native = ctx.modules.native;
  if (!native?.canTranslate?.()) return 'unsupported';
  const to = ctx.settings.get('translateTo') || 'ru';
  return native.translation.status(to === 'en' ? 'ru' : 'en', to).catch(() => 'unsupported');
}

function register() {
  ctx.handle('native:translate', (e, { text } = {}) => translateText(text));
  ctx.handle('native:translate-list', (e, { texts } = {}) => translateList(texts));
  ctx.handle('native:prepare-translation', (e, { from, to } = {}) => prepare(from, to));
  ctx.handle('native:web-translate', (e, { text, to } = {}) => openWeb(text, to));
  ctx.handle('native:translation-status', () => status());
}

module.exports = { register, translateText, translateList, prepare, openWeb, status, segments };
