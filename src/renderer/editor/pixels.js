// CPU pixel helpers: reading a canvas, smart-ruler edge scanning, uniform border detection.

export function readPixels(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}

export function pixelAt(img, x, y) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (!img || x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
}

// Smart ruler: from (x,y) walk left/right (axis 'h') or up/down ('v') while the colour stays
// close to the starting pixel. Returns the inclusive pixel range { a, b } along the axis.
export function scanEdges(img, x, y, axis = 'h', tol = 12) {
  x = Math.floor(x);
  y = Math.floor(y);
  const W = img.width;
  const H = img.height;
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const d = img.data;
  const i0 = (y * W + x) * 4;
  const r0 = d[i0];
  const g0 = d[i0 + 1];
  const b0 = d[i0 + 2];
  const a0 = d[i0 + 3];
  const same = (px, py) => {
    const i = (py * W + px) * 4;
    return Math.abs(d[i] - r0) <= tol && Math.abs(d[i + 1] - g0) <= tol && Math.abs(d[i + 2] - b0) <= tol && Math.abs(d[i + 3] - a0) <= tol;
  };
  let a;
  let b;
  if (axis === 'h') {
    a = x;
    b = x;
    while (a > 0 && same(a - 1, y)) a--;
    while (b < W - 1 && same(b + 1, y)) b++;
  } else {
    a = y;
    b = y;
    while (a > 0 && same(x, a - 1)) a--;
    while (b < H - 1 && same(x, b + 1)) b++;
  }
  return { a, b };
}

// Detect uniform borders (same colour as the corner pixel) → content rect to keep.
export function computeTrim(img, tol = 10) {
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const ref = (x, y) => {
    const i = (y * W + x) * 4;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  };
  const near = (i, c) => Math.abs(d[i] - c[0]) <= tol && Math.abs(d[i + 1] - c[1]) <= tol && Math.abs(d[i + 2] - c[2]) <= tol && Math.abs(d[i + 3] - c[3]) <= tol;
  const tl = ref(0, 0);
  const br = ref(W - 1, H - 1);
  const rowUniform = (y, c) => {
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) if (!near(i, c)) return false;
    return true;
  };
  const colUniform = (x, c, y0, y1) => {
    for (let y = y0; y < y1; y++) if (!near((y * W + x) * 4, c)) return false;
    return true;
  };
  let top = 0;
  while (top < H && rowUniform(top, tl)) top++;
  if (top >= H) return { x: 0, y: 0, w: W, h: H };
  let bottom = H;
  while (bottom > top + 1 && rowUniform(bottom - 1, br)) bottom--;
  let left = 0;
  while (left < W - 1 && colUniform(left, tl, top, bottom)) left++;
  let right = W;
  while (right > left + 1 && colUniform(right - 1, br, top, bottom)) right--;
  return { x: left, y: top, w: right - left, h: bottom - top };
}
