// Crop rectangle over the video preview. Works in source pixels; the layer is laid
// out over the letterboxed video content by the caller (layout()).
const MIN = 32;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const evenDown = (v) => Math.max(2, Math.floor(v / 2) * 2);

export class CropTool {
  constructor(layer, { onChange }) {
    this.layer = layer;
    this.onChange = onChange;
    this.src = { width: 0, height: 0 };
    this.rect = null;
    this.aspect = null; // width / height, or null for free
    this.scale = 1;
    layer.replaceChildren();
    this.box = document.createElement('div');
    this.box.className = 'crop-box';
    this.label = document.createElement('span');
    this.label.className = 'crop-size';
    this.box.append(this.label, ...['v1', 'v2', 'h1', 'h2'].map((c) => Object.assign(document.createElement('i'), { className: `third ${c}` })));
    for (const h of HANDLES) {
      const el = document.createElement('span');
      el.className = `ch ${h}`;
      el.dataset.handle = h;
      this.box.append(el);
    }
    layer.append(this.box);
    this.box.addEventListener('pointerdown', (e) => this.pointerDown(e));
  }

  // content: { left, top, width, height } of the displayed video inside the stage.
  layout(content) {
    Object.assign(this.layer.style, { left: `${content.left}px`, top: `${content.top}px`, width: `${content.width}px`, height: `${content.height}px` });
    this.scale = this.src.width ? content.width / this.src.width : 1;
    this.render();
  }

  show(src, rect) {
    this.src = src;
    this.rect = rect || { x: 0, y: 0, width: evenDown(src.width), height: evenDown(src.height) };
    this.layer.classList.remove('hidden');
    this.render();
  }

  hide() {
    this.layer.classList.add('hidden');
  }

  setAspect(ratio) {
    this.aspect = ratio;
    if (!ratio || !this.rect) return this.commit();
    // Largest rect of that ratio centred on the current one, inside the frame.
    const cx = this.rect.x + this.rect.width / 2;
    const cy = this.rect.y + this.rect.height / 2;
    let w = Math.min(this.src.width, this.rect.width);
    let h = w / ratio;
    if (h > Math.min(this.src.height, this.rect.height)) {
      h = Math.min(this.src.height, this.rect.height);
      w = h * ratio;
    }
    this.rect = this.clamp({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
    this.commit();
  }

  reset() {
    this.rect = { x: 0, y: 0, width: evenDown(this.src.width), height: evenDown(this.src.height) };
    if (this.aspect) return this.setAspect(this.aspect);
    this.commit();
  }

  clamp(r) {
    const width = Math.min(this.src.width, Math.max(MIN, r.width));
    const height = Math.min(this.src.height, Math.max(MIN, r.height));
    return {
      x: Math.max(0, Math.min(this.src.width - width, r.x)),
      y: Math.max(0, Math.min(this.src.height - height, r.y)),
      width,
      height,
    };
  }

  // Final values: integers, even size (x/y even too so chroma planes line up).
  commit() {
    const r = this.rect;
    const x = Math.floor(r.x / 2) * 2;
    const y = Math.floor(r.y / 2) * 2;
    this.rect = { x, y, width: Math.min(evenDown(r.width), evenDown(this.src.width - x)), height: Math.min(evenDown(r.height), evenDown(this.src.height - y)) };
    this.render();
    this.onChange({ ...this.rect });
  }

  render() {
    if (!this.rect) return;
    const k = this.scale;
    Object.assign(this.box.style, {
      left: `${this.rect.x * k}px`,
      top: `${this.rect.y * k}px`,
      width: `${this.rect.width * k}px`,
      height: `${this.rect.height * k}px`,
    });
    this.label.textContent = `${Math.round(this.rect.width)} × ${Math.round(this.rect.height)}`;
  }

  pointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.dataset?.handle || 'move';
    const start = { x: e.clientX, y: e.clientY, rect: { ...this.rect } };
    this.box.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / this.scale;
      const dy = (ev.clientY - start.y) / this.scale;
      this.rect = this.clamp(handle === 'move' ? { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy } : this.resized(start.rect, handle, dx, dy));
      this.render();
    };
    const up = () => {
      this.box.removeEventListener('pointermove', move);
      this.commit();
    };
    this.box.addEventListener('pointermove', move);
    this.box.addEventListener('pointerup', up, { once: true });
    this.box.addEventListener('pointercancel', up, { once: true });
  }

  resized(r, handle, dx, dy) {
    let { x, y, width: w, height: h } = r;
    const right = x + w;
    const bottom = y + h;
    if (handle.includes('w')) x = Math.min(right - MIN, Math.max(0, x + dx));
    if (handle.includes('e')) w = Math.min(this.src.width - x, Math.max(MIN, w + dx));
    if (handle.includes('n')) y = Math.min(bottom - MIN, Math.max(0, y + dy));
    if (handle.includes('s')) h = Math.min(this.src.height - y, Math.max(MIN, h + dy));
    if (handle.includes('w')) w = right - x;
    if (handle.includes('n')) h = bottom - y;
    if (this.aspect) {
      // Keep the ratio; the dragged edge drives, the opposite corner stays put.
      if (handle === 'n' || handle === 's') w = h * this.aspect;
      else h = w / this.aspect;
      if (w > this.src.width) (w = this.src.width), (h = w / this.aspect);
      if (h > this.src.height) (h = this.src.height), (w = h * this.aspect);
      if (handle.includes('w')) x = right - w;
      if (handle.includes('n')) y = bottom - h;
    }
    return { x, y, width: w, height: h };
  }
}
