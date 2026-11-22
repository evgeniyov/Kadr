// Static tables shared by the editor modules.

// Tool list in toolbar order. `key` is the Shottr hotkey (shown in tooltips).
export const TOOLS = [
  { id: 'select', key: 'V' },
  { id: 'crop', key: 'X' },
  { id: 'wand', key: 'W' },
  { id: 'lasso', key: 'Q' },
  { id: 'arrow', key: 'A' },
  { id: 'rect', key: 'R' },
  { id: 'oval', key: 'O' },
  { id: 'line', key: 'L' },
  { id: 'text', key: 'T' },
  { id: 'counter', key: 'C' },
  { id: 'freehand', key: 'D' },
  { id: 'highlighter', key: 'H' },
  { id: 'conceal', key: 'B' },
  { id: 'spotlight', key: 'S' },
  { id: 'magnifier', key: 'M' },
  { id: 'ruler', key: '1', key2: '2' },
  { id: 'picker', key: 'I' },
];

// Tools that create annotation objects of the same type id.
export const OBJECT_TOOLS = new Set(['arrow', 'rect', 'oval', 'line', 'text', 'counter', 'freehand', 'highlighter', 'conceal', 'spotlight', 'magnifier']);

export const PRESET_COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#0A84FF', '#AF52DE', '#FF2D55', '#1D1D1F', '#FFFFFF'];

// Size presets 1..6, in DIP (multiplied by the capture scale).
export const SIZES = {
  stroke: [1.5, 2.5, 4, 6, 9, 13],
  arrow: [2, 3, 4.5, 6.5, 9, 12.5],
  text: [12, 16, 22, 30, 42, 60],
  counter: [9, 11.5, 14, 17.5, 22, 28],
  highlighter: [8, 12, 16, 22, 30, 40],
  conceal: [4, 7, 10, 14, 20, 28],
};

export const ARROW_STYLES = ['classic', 'curved', 'double', 'thin', 'tapered'];
export const FILL_STYLES = ['outline', 'semi', 'solid'];
export const LINE_STYLES = ['solid', 'dashed', 'dotted'];
export const TEXT_STYLES = ['plain', 'outline', 'box'];
export const CONCEAL_MODES = ['pixelate', 'blur', 'erase'];
export const RECT_RADII = [0, 6, 14]; // DIP
export const MAGNIFIER_ZOOMS = [2, 3, 4];
export const LASSO_SHAPES = ['free', 'polygon', 'rect', 'ellipse'];

export const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, Roboto, sans-serif";

// Backdrop gradient presets (CSS angle convention: 0deg = to top, 90deg = to right).
export const GRADIENTS = [
  { stops: ['#FF9A8B', '#FF6A88', '#FF99AC'], angle: 135 },
  { stops: ['#FFDEE9', '#B5FFFC'], angle: 135 },
  { stops: ['#2E3192', '#1BFFFF'], angle: 135 },
  { stops: ['#7F7FD5', '#86A8E7', '#91EAE4'], angle: 135 },
  { stops: ['#FFE259', '#FFA751'], angle: 135 },
  { stops: ['#A8FF78', '#78FFD6'], angle: 135 },
  { stops: ['#8E2DE2', '#4A00E0'], angle: 135 },
  { stops: ['#F953C6', '#B91D73'], angle: 135 },
  { stops: ['#A1C4FD', '#C2E9FB'], angle: 160 },
  { stops: ['#FC5C7D', '#6A82FB'], angle: 135 },
  { stops: ['#134E5E', '#71B280'], angle: 135 },
  { stops: ['#232526', '#414345'], angle: 160 },
];

// Aspect-ratio templates for the backdrop. `w:h` is a ratio; the output keeps full resolution.
export const RATIOS = [
  { id: 'auto' },
  { id: '1:1', w: 1, h: 1 },
  { id: '4:3', w: 4, h: 3 },
  { id: '3:2', w: 3, h: 2 },
  { id: '16:9', w: 16, h: 9 },
  { id: '9:16', w: 9, h: 16 },
  { id: '4:5', w: 4, h: 5 },
  { id: 'twitter', w: 16, h: 9, px: '1600×900' },
  { id: 'producthunt', w: 1270, h: 760, px: '1270×760' },
  { id: 'dribbble', w: 4, h: 3, px: '1600×1200' },
  { id: 'linkedin', w: 1200, h: 627, px: '1200×627' },
  { id: 'youtube', w: 16, h: 9, px: '1280×720' },
];

// Zoom steps for ⌘+ / ⌘- (fractions of the "real size", 1 = 100%).
export const ZOOM_STEPS = [0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];

export const COLOR_FORMATS = ['hex', 'HEX', 'rgb', 'hsl', 'css-rgba', 'swiftui', 'uicolor', 'android', 'csharp', 'flutter'];

// Editor settings keys that are not in core defaults (registered by src/main/editor.js too).
export const EXTRA_DEFAULTS = {
  opacity: 1,
  shadow: true,
  rectRadius: 0,
  ovalFill: 'outline',
  spotlightShape: 'rect',
  spotlightDim: 0.55,
  magnifierZoom: 2,
  rulerUnit: 'px',
  unit: 'px',
  wandTolerance: 32, // 0..255 levels per channel (Photoshop default)
  wandSample: 1, // sample size: 1 (point) | 3 | 5 | 11 | 31
  wandContiguous: true,
  wandAntialias: true,
  lassoShape: 'free',
  bgTolerance: 30,
};
