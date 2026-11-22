// Stroke icons (24×24) used by the recorder windows. Filled ones set fill themselves.
const P = {
  screen: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  window: '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M3 8.8h18"/><circle cx="6" cy="6.7" r=".5"/><circle cx="8" cy="6.7" r=".5"/>',
  region: '<path d="M4 8.5V5.2c0-.7.5-1.2 1.2-1.2h3.3M15.5 4h3.3c.7 0 1.2.5 1.2 1.2v3.3M20 15.5v3.3c0 .7-.5 1.2-1.2 1.2h-3.3M8.5 20H5.2c-.7 0-1.2-.5-1.2-1.2v-3.3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" stroke-dasharray="2 2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  micOff: '<path d="M15 9.5V6a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 4.9 2.3M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11a6.5 6.5 0 0 1-.5 2.5M12 17.5V21M4 4l16 16"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  cursor: '<path d="M6 3.5l12.5 7-5.6 1.5-2.4 5.5z"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2 2M9.5 2.8h5"/>',
  film: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13.5l3.5-4"/>',
  quality: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M7 9.5v5M10.2 9.5v5M7 12h3.2M13.5 9.5v5h1.3a2.5 2.5 0 0 0 0-5z"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  link: '<path d="M9.5 14.5l5-5M10.5 6.5l1.2-1.2a3.9 3.9 0 0 1 5.5 5.5L16 12M8 12l-1.2 1.2a3.9 3.9 0 0 0 5.5 5.5l1.2-1.2"/>',
  unlink: '<path d="M10.5 6.5l1.2-1.2a3.9 3.9 0 0 1 5.5 5.5L16 12M8 12l-1.2 1.2a3.9 3.9 0 0 0 5.5 5.5l1.2-1.2M4 4l3 3M20 20l-3-3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M9.2 12l2 2 3.8-4"/>',
  warning: '<path d="M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2v.3"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  open: '<path d="M14 4.5h5.5V10M19.5 4.5l-8.5 8.5M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V4.5h5V7"/>',
  pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  grip: '<circle cx="9" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  return span;
}

// Human-readable file size with localised units.
export function formatBytes(n, t) {
  if (n >= 1024 ** 3) return t('recorder.unit.gb', { n: (n / 1024 ** 3).toFixed(2) });
  if (n >= 1024 ** 2) return t('recorder.unit.mb', { n: (n / 1024 ** 2).toFixed(1) });
  return t('recorder.unit.kb', { n: Math.max(1, Math.round(n / 1024)) });
}
