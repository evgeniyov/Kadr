// Colour parsing, contrast and the colour-picker output formats.

export function parseHex(hex) {
  let s = String(hex || '').trim().replace(/^#/, '');
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0, a: 1 };
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
}

const h2 = (v) => Math.round(v).toString(16).padStart(2, '0');

export function toHex({ r, g, b }) {
  return `#${h2(r)}${h2(g)}${h2(b)}`.toUpperCase();
}

export function normalizeHex(hex) {
  return toHex(parseHex(hex));
}

export function isValidHex(s) {
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(s).trim());
}

export function rgba(hex, alpha = 1) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Relative luminance (sRGB), 0..1.
export function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Text/outline colour that reads well on top of `hex`.
export function contrastColor(hex) {
  return luminance(hex) > 0.45 ? '#1D1D1F' : '#FFFFFF';
}

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

const f3 = (v) => (v / 255).toFixed(3);
const HEX = (v) => h2(v).toUpperCase();

// Format a picked colour according to settings.colorFormat.
export function formatColor({ r, g, b, a = 255 }, format = 'hex') {
  const alpha = +(a / 255).toFixed(2);
  switch (format) {
    case 'HEX':
      return `#${HEX(r)}${HEX(g)}${HEX(b)}`;
    case 'rgb':
      return `rgb(${r}, ${g}, ${b})`;
    case 'hsl': {
      const { h, s, l } = rgbToHsl(r, g, b);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    case 'css-rgba':
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    case 'swiftui':
      return `Color(red: ${f3(r)}, green: ${f3(g)}, blue: ${f3(b)})`;
    case 'uicolor':
      return `UIColor(red: ${f3(r)}, green: ${f3(g)}, blue: ${f3(b)}, alpha: ${(a / 255).toFixed(1)})`;
    case 'android':
      return `0x${HEX(a)}${HEX(r)}${HEX(g)}${HEX(b)}`;
    case 'csharp':
      return `Color.FromArgb(${r}, ${g}, ${b})`;
    case 'flutter':
      return `Color(0x${HEX(a)}${HEX(r)}${HEX(g)}${HEX(b)})`;
    case 'hex':
    default:
      return `#${h2(r)}${h2(g)}${h2(b)}`;
  }
}

export function randomColor(minL = 45, maxL = 75) {
  const h = Math.floor(Math.random() * 360);
  const s = 55 + Math.floor(Math.random() * 40);
  const l = minL + Math.floor(Math.random() * (maxL - minL));
  return hslToHex(h, s, l);
}
