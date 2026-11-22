// Shared i18n for main (via require(esm)) and renderers (ES module import).
// Each feature module owns its own dictionary file: { ru: {...}, en: {...} }.
import core from './core.mjs';
import editor from './editor.mjs';
import recorder from './recorder.mjs';

const modules = [core, editor, recorder];

export const dictionaries = { ru: {}, en: {} };
for (const m of modules) {
  for (const lang of Object.keys(dictionaries)) Object.assign(dictionaries[lang], m[lang] || {});
}

let current = 'ru';

export function resolveLang(setting, systemLocale = '') {
  if (setting === 'ru' || setting === 'en') return setting;
  const loc = String(systemLocale || '').toLowerCase();
  return /^(ru|uk|be|kk)/.test(loc) ? 'ru' : 'en';
}

export function setLang(lang) {
  current = dictionaries[lang] ? lang : 'en';
}

export function getLang() {
  return current;
}

// t('key', { n: 5 }) → replaces {n}. Falls back to English, then the key itself.
export function t(key, vars) {
  let s = dictionaries[current][key] ?? dictionaries.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

// Russian plural helper: plural(n, ['файл', 'файла', 'файлов'])
export function plural(n, forms) {
  if (current !== 'ru') return n === 1 ? forms[0] : forms[forms.length - 1];
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
