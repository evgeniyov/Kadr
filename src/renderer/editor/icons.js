// Inline stroke icons (24×24 viewBox, drawn at 18px by .ibtn styles).
const F = 'fill="currentColor" stroke="none"';

const PATHS = {
  select: '<path d="M6.5 3.8l11.2 8.1-5.1 1.1-2.5 4.9z"/><path d="M12.6 13l3.6 5.3"/>',
  arrow: '<path d="M5 19L18.2 5.8"/><path d="M10 5h9v9"/>',
  rect: '<rect x="4" y="5.5" width="16" height="13" rx="2"/>',
  oval: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  line: '<path d="M5 19L19 5"/>',
  text: '<path d="M5.5 7V5h13v2M12 5v14M9 19h6"/>',
  counter: '<circle cx="12" cy="12" r="8.5"/><path d="M10.4 9.6L12.6 8v8"/>',
  freehand: '<path d="M3.8 16.5c2.4-4.8 4.7-8.7 6.8-8.3 2.4.5-1.6 6.7.5 7.4 2 .7 3.9-5.1 5.9-5.6 1.4-.4 2.2 1.1 3.2 2.4"/>',
  highlighter: '<path d="M15.2 4.3l4.5 4.5-7.9 7.9-4.5-4.5z"/><path d="M7.3 12.2l-2.1 5.1 1.5 1.5 5.1-2.1"/><path d="M4 21h8"/>',
  conceal: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/><rect x="9.3" y="9.3" width="5.4" height="5.4" ' + F + ' opacity=".55"/><rect x="4.5" y="4.5" width="4.8" height="4.8" ' + F + ' opacity=".3"/><rect x="14.7" y="14.7" width="4.8" height="4.8" ' + F + ' opacity=".3"/>',
  spotlight: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="12" cy="12" r="4.2"/><path d="M3.5 8.5l4 0M3.5 15.5h4M16.5 8.5h4M16.5 15.5h4" opacity=".6"/>',
  magnifier: '<circle cx="10.5" cy="10.5" r="6.3"/><path d="M15.2 15.2L20 20M8 10.5h5M10.5 8v5"/>',
  ruler: '<path d="M3.6 15.6L15.6 3.6l4.8 4.8-12 12z"/><path d="M7.2 12l2 2M10 9.2l2 2M12.8 6.4l2 2"/>',
  crop: '<path d="M6.5 2.5V17.5h15"/><path d="M2.5 6.5h15v15"/>',
  picker: '<path d="M13.9 6.1l1.6-1.6a2.2 2.2 0 013.1 3.1l-1.6 1.6"/><path d="M12.3 7.7l4 4"/><path d="M14.3 9.7l-7.8 7.8-2.5.5.5-2.5 7.8-7.8"/>',
  backdrop: '<rect x="2.8" y="3.8" width="18.4" height="16.4" rx="4"/><rect x="6.8" y="8" width="10.4" height="8" rx="1.5"/>',
  ocr: '<path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  addCapture: '<rect x="3" y="6" width="13.5" height="13" rx="2"/><path d="M3.5 16l3.8-3.8 2.8 2.8 2-2 3.6 3.6"/><path d="M19.5 3.5v6M16.5 6.5h6"/>',
  pin: '<path d="M9.2 3.8h5.6l-.9 5.2 3.1 3.2H7l3.1-3.2z"/><path d="M12 12.2V20"/>',
  save: '<path d="M12 4v10.5M7.5 10L12 14.5 16.5 10"/><path d="M5 18.5h14"/>',
  translate: '<path d="M4 5.5h8M8 3.5v2M6 5.5c.3 3.4 2.3 6 5 7.2M10.2 5.5c-.6 3.4-3 6.1-6.2 7.2"/><path d="M12.5 20.5l4-10 4 10M14 17h5"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7.5a2 2 0 002 2h2.5"/>',
  more: `<circle cx="6" cy="12" r="1.5" ${F}/><circle cx="12" cy="12" r="1.5" ${F}/><circle cx="18" cy="12" r="1.5" ${F}/>`,
  undo: '<path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10h10a5 5 0 010 10H11"/>',
  redo: '<path d="M15 14.5l4.5-4.5L15 5.5"/><path d="M19.5 10h-10a5 5 0 000 10H13"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6"/><path d="M6 7l.8 11.2A2 2 0 008.8 20h6.4a2 2 0 002-1.8L18 7M9.5 7V4.5h5V7"/>',
  duplicate: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M4 15.5V6a2 2 0 012-2h9.5M14.2 11.5v5M11.7 14h5"/>',
  forward: '<rect x="8" y="3.5" width="12.5" height="12.5" rx="2" fill="currentColor" fill-opacity=".25"/><path d="M4 8v10a2 2 0 002 2h10"/>',
  backward: '<rect x="3.5" y="3.5" width="12.5" height="12.5" rx="2"/><path d="M8 20h10a2 2 0 002-2V8" /><rect x="8" y="8" width="12" height="12" rx="2" fill="currentColor" fill-opacity=".25" stroke="none"/>',
  rotateLeft: '<path d="M3.5 4.5v5h5"/><path d="M4 9.5A8.3 8.3 0 1112 20.5"/>',
  rotateRight: '<path d="M20.5 4.5v5h-5"/><path d="M20 9.5A8.3 8.3 0 1012 20.5"/>',
  flipH: '<path d="M12 3v18" stroke-dasharray="2 2.2"/><path d="M8.5 7L3.5 17h5z"/><path d="M15.5 7l5 10h-5z"/>',
  flipV: '<path d="M3 12h18" stroke-dasharray="2 2.2"/><path d="M7 8.5L17 3.5v5z"/><path d="M7 15.5l10 5v-5z"/>',
  resize: '<path d="M4 9.5V4h5.5M20 14.5V20h-5.5"/><path d="M4 4l6.5 6.5M20 20l-6.5-6.5"/>',
  gif: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 5v14M16.5 5v14M3 9.5h4.5M3 14.5h4.5M16.5 9.5H21M16.5 14.5H21"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/>',
  wand: '<path d="M4 20L14.5 9.5M13 8l3 3"/><path d="M18 3v3M16.5 4.5h3M20 10v2M19 11h2M10 3v2M9 4h2"/>',
  shadow: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M19.5 8v10a1.5 1.5 0 01-1.5 1.5H8" stroke-width="3" opacity=".45"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8M8 10.5h5M10.5 8v5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8M8 10.5h5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  shuffle: '<path d="M16 4h4v4M4 20L20 4M16 20h4v-4M14.5 14.5L20 20M4 4l5 5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4 17l4.5-4.5 3 3 2.5-2.5 5.5 5.5"/>',
  sparkle: '<path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  grip: `<circle cx="9" cy="7" r="1.3" ${F}/><circle cx="15" cy="7" r="1.3" ${F}/><circle cx="9" cy="12" r="1.3" ${F}/><circle cx="15" cy="12" r="1.3" ${F}/><circle cx="9" cy="17" r="1.3" ${F}/><circle cx="15" cy="17" r="1.3" ${F}/>`,
  palette: '<path d="M12 3.5a8.5 8.5 0 100 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6s.8-1.7 1.9-1.7h2.2a3.6 3.6 0 003.6-3.6c0-4.3-3.8-7.4-8.5-7.4z"/><circle cx="7.8" cy="11" r="1.2" ' + F + '/><circle cx="10.5" cy="7.5" r="1.2" ' + F + '/><circle cx="14.8" cy="7.8" r="1.2" ' + F + '/>',
  radius0: '<path d="M6 19V6h13"/>',
  radius1: '<path d="M6 19v-9a4 4 0 014-4h9"/>',
  radius2: '<path d="M6 19v-4a9 9 0 019-9h4"/>',
  rulerH: '<path d="M3.5 12h17M3.5 8v8M20.5 8v8"/>',
  rulerV: '<path d="M12 3.5v17M8 3.5h8M8 20.5h8"/>',
  eraser: '<path d="M15.5 4.5l4.5 4.5-9 9H6.5l-3-3z"/><path d="M9 20.5h11M8.5 9.5l6 6"/>',
  blurMode: '<circle cx="12" cy="12" r="7.5" stroke-dasharray="1.6 2.4"/><circle cx="12" cy="12" r="3.8" fill="currentColor" fill-opacity=".35"/>',
  pixelMode: '<path d="M4 4h5.3v5.3H4zM14.7 4H20v5.3h-5.3zM9.3 9.3h5.4v5.4H9.3zM4 14.7h5.3V20H4zM14.7 14.7H20V20h-5.3z" fill="currentColor" fill-opacity=".45"/>',
  textOnly: '<path d="M4 7V5.5h10V7M9 5.5V16"/><path d="M13 12h7M13 15.5h7M13 19h5" opacity=".7"/>',
  removeBg: '<path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16"/><circle cx="12" cy="10" r="2.6"/><path d="M7.5 18c.8-2.6 2.5-3.8 4.5-3.8s3.7 1.2 4.5 3.8"/>',
  lasso: '<path d="M6.4 15.4C4.3 14.3 3 12.7 3 10.9 3 7.3 7 4.4 12 4.4s9 2.9 9 6.5-4 6.5-9 6.5c-.9 0-1.8-.1-2.6-.3"/><path d="M9.8 16.9a2.1 2.1 0 10-2.9 1.6c.6.3.9 1 .6 1.8"/>',
  lassoPoly: '<path d="M5 17.5l2.3-11.5L17.5 4l3 8.5-9.5 7.5z" stroke-dasharray="2.4 2.2"/>',
  marqueeRect: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="2.4 2.2"/>',
  marqueeEllipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7" stroke-dasharray="2.4 2.2"/>',
  selKeep: '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="2 2.2" opacity=".55"/><path d="M12 6.5l5.2 9.5H6.8z" fill="currentColor" fill-opacity=".35"/>',
  bucket: '<path d="M5 11.5L11.5 5l6.5 6.5-6.5 6.5z"/><path d="M11.5 5L9 2.5M5 11.5h13"/><path d="M20 15.5s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z"/>',
  selInvert: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M5 19.5L19.5 5v13a1.5 1.5 0 01-1.5 1.5z" fill="currentColor" fill-opacity=".4" stroke="none"/>',
  contiguous: '<circle cx="6.5" cy="12" r="2.6"/><circle cx="17.5" cy="12" r="2.6"/><path d="M9.1 12h5.8"/>',
  antialias: '<path d="M4 20C4 11.2 11.2 4 20 4"/><path d="M4 15.5V12h3.5V8.5H11V5h4" opacity=".45"/>',
  // Arrow styles
  arrowClassic: `<path d="M5 19L15.5 8.5"/><path d="M19.5 4.5l-2.6 8.2-5.6-5.6z" ${F}/>`,
  arrowCurved: `<path d="M4.5 19.5C5 12 9.5 7.5 15 6.8"/><path d="M19.8 6.4l-6.3 4.1-.8-6.8z" ${F}/>`,
  arrowDouble: `<path d="M8 16L16 8"/><path d="M19.5 4.5l-2.4 7.6-5.2-5.2zM4.5 19.5l2.4-7.6 5.2 5.2z" ${F}/>`,
  arrowThin: '<path d="M5 19L19 5" stroke-width="1.3"/><path d="M12.5 5H19v6.5" stroke-width="1.3"/>',
  arrowTapered: `<path d="M4.3 19.9l10.3-11.6 1.3 1.3L4.9 20.3z" ${F}/><path d="M19.8 4.2l-2.4 8.4-6-6z" ${F}/>`,
  // Fill styles
  fillOutline: '<rect x="4.5" y="5.5" width="15" height="13" rx="2"/>',
  fillSemi: '<rect x="4.5" y="5.5" width="15" height="13" rx="2" fill="currentColor" fill-opacity=".3"/>',
  fillSolid: `<rect x="4.5" y="5.5" width="15" height="13" rx="2" fill="currentColor"/>`,
  ovalOutline: '<ellipse cx="12" cy="12" rx="8" ry="6.5"/>',
  ovalSemi: '<ellipse cx="12" cy="12" rx="8" ry="6.5" fill="currentColor" fill-opacity=".3"/>',
  ovalSolid: '<ellipse cx="12" cy="12" rx="8" ry="6.5" fill="currentColor"/>',
  // Line styles
  lineSolid: '<path d="M4 12h16" stroke-width="2.2"/>',
  lineDashed: '<path d="M4 12h16" stroke-width="2.2" stroke-dasharray="4 3" stroke-linecap="butt"/>',
  lineDotted: '<path d="M4 12h16" stroke-width="2.6" stroke-dasharray="0.1 4.5"/>',
};

export function icon(name, cls = '') {
  const body = PATHS[name] || PATHS.more;
  return `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${body}</svg>`;
}

// Returns a DOM node (for use with el()).
export function iconNode(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
}
