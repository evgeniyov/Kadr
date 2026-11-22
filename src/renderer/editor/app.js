// Editor state: document, history, renderer, view, tools, selection, current properties.
// UI modules listen to events: 'tool', 'selection', 'props', 'history', 'backdrop', 'zoom', 'cursor'.
import { kadr, t, toast, setSettings, canvasToBytes } from '../../shared/ui.js';
import { Doc, History, makeCanvas } from './doc.js';
import { Renderer } from './render.js';
import { View } from './view.js';
import { typeOf, createObject, newObjectId } from './objects/index.js';
import { parseConcealType } from './objects/effects.js';
import { SIZES, OBJECT_TOOLS, EXTRA_DEFAULTS } from './consts.js';
import { readPixels, pixelAt } from './pixels.js';
import { rectKey, intersect, dist } from './geom.js';
import { normalizeHex } from './color.js';

// Objects whose whole area is "grabbable" even while a drawing tool is active.
const SOLID = new Set(['text', 'counter', 'magnifier']);
// Tools remembered in settings.editor.tool
const PERSIST_TOOLS = new Set([...OBJECT_TOOLS, 'select', 'wand', 'lasso']);
// Toolbar property → name in a type's `props` list.
const PROP_ACCEPT = {
  color: 'color',
  size: 'size',
  opacity: 'opacity',
  shadow: 'shadow',
  arrowStyle: 'arrowStyle',
  fill: 'fill',
  rectRadius: 'radius',
  lineStyle: 'lineStyle',
  textStyle: 'textStyle',
  concealType: 'concealMode',
  spotlightShape: 'spotlightShape',
  spotlightDim: 'dim',
  magnifierZoom: 'magnifierZoom',
  rulerUnit: 'rulerUnit',
};
const SLIDER_PROPS = new Set(['opacity', 'spotlightDim']);

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export async function loadBitmap(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await createImageBitmap(await res.blob());
  } catch {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }
}

export class App extends EventTarget {
  constructor({ params, settings, base, dom }) {
    super();
    this.params = params;
    this.dom = dom;
    this.settings = settings;
    const ed = { ...EXTRA_DEFAULTS, ...(settings.editor || {}) };
    this.doc = new Doc(base, params.scale || 1);
    this.original = base;
    this.history = new History(this.doc, { onChange: () => this.emit('history') });
    this.renderer = new Renderer(this.doc);
    this.view = new View(dom.viewport, dom.canvas);
    this.view.onChange = () => {
      this.invalidate(false);
      this.emit('zoom');
    };
    this.composite = makeCanvas(1, 1);
    this.layout = null;

    this.props = {
      color: normalizeHex(ed.color || '#FF3B30'),
      size: ed.size || 3,
      opacity: ed.opacity ?? 1,
      shadow: ed.shadow ?? true,
      arrowStyle: ed.arrowStyle || 'classic',
      rectFill: ed.rectFill || 'outline',
      ovalFill: ed.ovalFill || 'outline',
      rectRadius: ed.rectRadius ?? 0,
      lineStyle: ed.lineStyle || 'solid',
      textStyle: ed.textStyle || 'outline',
      concealType: ed.concealType || 'pixelate',
      spotlightShape: ed.spotlightShape || 'rect',
      spotlightDim: ed.spotlightDim ?? 0.55,
      magnifierZoom: ed.magnifierZoom || 2,
      rulerUnit: ed.rulerUnit || 'px',
      rulerAxis: 'h',
      wandTolerance: ed.wandTolerance ?? 32,
      wandSample: ed.wandSample ?? 1,
      wandContiguous: ed.wandContiguous ?? true,
      wandAntialias: ed.wandAntialias ?? true,
      lassoShape: ed.lassoShape || 'free',
      bgTolerance: ed.bgTolerance ?? 30,
    };
    this.customColors = Array.isArray(ed.customColors) ? ed.customColors.map(normalizeHex) : [];
    this.backdrop = { ...(ed.backdrop || {}) };
    if (params.options?.backdrop) Object.assign(this.backdrop, { enabled: true, innerRadius: 0, shadow: 0 });
    this.backdropVersion = 0;
    this.unit = ed.unit === 'pt' ? 'pt' : 'px';

    this.tools = {};
    this.tool = null;
    this.toolId = null;
    this.prevToolId = null;
    this.selectedId = null;
    this.hoverId = null;
    this.freezeIndex = null;
    this.cursor = null; // { sx, sy, x, y } of the pointer over the canvas
    this.exportCache = null;
    this._dirty = false;
    this.ocrInFlight = new Map();
    this.compositePixels = null;
    this.basePixels = null;
    this.raf = 0;
    this.needsComposite = true;

    // Settings writes are batched (several keys may change within one gesture).
    let pending = {};
    const flush = debounce(() => {
      const patch = pending;
      pending = {};
      setSettings({ editor: patch }).catch(() => {});
    }, 250);
    this.persistEditor = (patch) => {
      Object.assign(pending, patch);
      flush();
    };
    this.persistBackdrop = debounce(() => {
      const { enabled, type, gradient, gradientFrom, gradientTo, gradientAngle, solid, imagePath, padding, innerRadius, outerRadius, shadow, ratio, autocrop } = this.backdrop;
      setSettings({ editor: { backdrop: { enabled, type, gradient, gradientFrom, gradientTo, gradientAngle, solid, imagePath, padding, innerRadius, outerRadius, shadow, ratio, autocrop } } }).catch(() => {});
    }, 300);
    this.readCompositeLater = debounce(() => {
      if (!this.compositePixels) {
        this.compositePixels = readPixels(this.composite);
        this.emit('cursor');
      }
    }, 140);

    this.doc.addEventListener('change', (e) => {
      if (e.detail.base || e.detail.restore) this.renderer.unfreeze();
      if (e.detail.base) this.basePixels = null;
      if (e.detail.base || e.detail.restore) {
        for (const o of this.doc.objects) this.ensureConcealOcr(o);
      }
      this.exportCache = null;
      if (this.selectedId && !this.doc.get(this.selectedId)) this.select(null);
      if (e.detail.restore) this.emit('selection');
      this.invalidate();
    });
  }

  // Unsaved changes. Changes are announced ('dirty') so the window can reflect them.
  get dirty() {
    return this._dirty;
  }
  set dirty(v) {
    if (this._dirty === !!v) return;
    this._dirty = !!v;
    this.emit('dirty', this._dirty);
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  on(name, fn) {
    this.addEventListener(name, (e) => fn(e.detail));
  }

  // ---- rendering -------------------------------------------------------------
  invalidate(composite = true) {
    if (composite) this.needsComposite = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  currentLayout() {
    return this.renderer.layout(this.backdrop, { raw: this.toolId === 'crop' });
  }

  frame() {
    this.raf = 0;
    if (this.needsComposite || !this.layout) {
      this.needsComposite = false;
      this.layout = this.currentLayout();
      this.renderer.render(this.composite, {
        layout: this.layout,
        backdrop: this.layout.backdrop ? this.backdrop : null,
        freezeIndex: this.freezeIndex,
      });
      this.compositePixels = null;
      if (this.cursor) this.readCompositeLater();
    }
    this.view.setContent(this.layout.width, this.layout.height, this.doc.scale);
    this.view.draw(this.composite, (g) => this.drawOverlay(g));
    this.emit('frame');
  }

  drawOverlay(g) {
    this.overlay?.(g);
  }

  toDoc(sx, sy) {
    const [ox, oy] = this.view.screenToOut(sx, sy);
    return [ox - this.layout.ox, oy - this.layout.oy];
  }
  toScreen(x, y) {
    return this.view.outToScreen(x + this.layout.ox, y + this.layout.oy);
  }
  get vs() {
    return this.view.vs;
  }

  // ---- tools -----------------------------------------------------------------
  registerTool(id, tool) {
    this.tools[id] = tool;
  }

  setTool(id, { force = false } = {}) {
    if (!this.tools[id]) return;
    if (id === this.toolId && !force) return;
    this.textEditor?.commit();
    this.tool?.deactivate?.();
    if (this.toolId && this.toolId !== id && !this.tools[this.toolId]?.transient) this.prevToolId = this.toolId;
    this.toolId = id;
    this.tool = this.tools[id];
    if (id !== 'select' && this.selected && this.selected.type !== id) this.select(null);
    this.tool.activate?.();
    if (PERSIST_TOOLS.has(id)) this.persistEditor({ tool: id });
    this.hoverId = null;
    this.emit('tool');
    this.invalidate();
  }

  restorePrevTool() {
    this.setTool(this.prevToolId && this.prevToolId !== this.toolId ? this.prevToolId : 'select');
  }

  // Object type the property bar should describe.
  contextType() {
    const o = this.selected;
    if (o) return o.type;
    if (OBJECT_TOOLS.has(this.toolId) || this.toolId === 'ruler') return this.toolId;
    return null;
  }

  // ---- selection & objects ----------------------------------------------------
  get selected() {
    return this.selectedId ? this.doc.get(this.selectedId) : null;
  }

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('selection');
    this.invalidate(false);
  }

  objectEnv() {
    return { counterNumber: (o) => this.doc.counterNumber(o), assets: this.doc.assets };
  }

  // mode: 'all' (select tool), 'draw' (strokes + solid objects + the selected one), 'selected'.
  // Hits are 'stroke' | 'fill' | 'weak' (transparent interior of an outline shape); the topmost
  // strong hit wins, a weak hit only when nothing else is under the pointer.
  hitTest(p, mode = 'draw') {
    const tol = 5 / this.vs;
    const env = this.objectEnv();
    const list = this.doc.objects;
    let weak = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (mode === 'selected' && o.id !== this.selectedId) continue;
      const h = typeOf(o)?.hit(o, p.x, p.y, tol, env);
      if (!h) continue;
      const mine = o.id === this.selectedId;
      if (h === 'weak') {
        if (!weak && (mode !== 'draw' || mine)) weak = o;
        continue;
      }
      if (mode !== 'draw' || mine || h === 'stroke' || SOLID.has(o.type)) return o;
    }
    return weak;
  }

  handleAt(o, p) {
    const hs = typeOf(o)?.handles?.(o, this.objectEnv()) || [];
    let best = null;
    let bestD = 9;
    for (const h of hs) {
      const [hx, hy] = this.toScreen(h.x, h.y);
      const d = dist(hx, hy, p.sx, p.sy);
      if (d <= bestD) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }

  newObject(type, x, y, extra = {}) {
    const props = { ...this.props, k: this.doc.scale, fontSize: SIZES.text[(this.props.size || 3) - 1], ...extra };
    return createObject(type, props, x, y);
  }

  // Cache everything below the edited object while dragging (see Renderer.render freezeIndex).
  beginInteraction(id) {
    let idx = this.doc.indexOf(id);
    const o = this.doc.get(id);
    if (o?.type === 'spotlight') idx = Math.min(idx, this.doc.objects.findIndex((x) => x.type === 'spotlight'));
    this.freezeIndex = idx > 0 ? idx : null;
    this.renderer.unfreeze();
  }
  endInteraction() {
    this.freezeIndex = null;
    this.renderer.unfreeze();
    this.invalidate();
  }

  commit(key = null) {
    this.history.commit(key);
    this.dirty = true;
    this.exportCache = null;
  }

  undo() {
    this.textEditor?.commit();
    if (this.tool?.cancel?.()) return;
    if (this.history.undo()) this.dirty = true;
  }
  redo() {
    this.textEditor?.commit();
    if (this.history.redo()) this.dirty = true;
  }

  deleteSelected() {
    const o = this.selected;
    if (!o) return false;
    this.doc.remove(o.id);
    this.select(null);
    this.commit();
    return true;
  }

  duplicateSelected() {
    const o = this.selected;
    if (!o) return;
    const c = structuredClone(o);
    c.id = newObjectId();
    const d = 14 * (o.k || 1);
    typeOf(c).translate(c, d, d);
    this.doc.add(c, this.doc.indexOf(o.id) + 1);
    this.select(c.id);
    this.commit();
  }

  arrangeSelected(dir) {
    const o = this.selected;
    if (o && this.doc.arrange(o.id, dir)) this.commit();
  }

  nudgeSelected(dx, dy) {
    const o = this.selected;
    if (!o) return;
    typeOf(o).translate(o, dx, dy);
    this.doc.changed();
    this.commit(`nudge:${o.id}`);
    this.afterGeometryChange(o);
  }

  afterGeometryChange(o) {
    if (o?.type === 'conceal') this.ensureConcealOcr(o);
  }

  // ---- properties -----------------------------------------------------------
  accepts(o, name) {
    const T = typeOf(o);
    return !!T && T.props.includes(PROP_ACCEPT[name]);
  }

  propValue(name) {
    const o = this.selected;
    if (o && this.accepts(o, name)) {
      switch (name) {
        case 'arrowStyle':
        case 'textStyle':
          return o.style;
        case 'rectRadius':
          return o.radius ?? 0;
        case 'lineStyle':
          return o.dash;
        case 'concealType':
          return o.mode + (o.textOnly ? '-text' : '');
        case 'spotlightShape':
          return o.shape;
        case 'spotlightDim':
          return o.dim;
        case 'magnifierZoom':
          return o.zoom;
        case 'rulerUnit':
          return o.unit;
        default:
          return o[name];
      }
    }
    if (name === 'fill') return this.contextType() === 'oval' ? this.props.ovalFill : this.props.rectFill;
    return this.props[name];
  }

  #applyProp(o, name, v) {
    switch (name) {
      case 'size':
        o.size = v;
        if (o.type === 'text') o.fontSize = SIZES.text[v - 1];
        break;
      case 'arrowStyle':
        typeOf(o).setStyle(o, v);
        break;
      case 'textStyle':
        o.style = v;
        break;
      case 'rectRadius':
        o.radius = v;
        break;
      case 'lineStyle':
        o.dash = v;
        break;
      case 'concealType': {
        const { mode, textOnly } = parseConcealType(v);
        o.mode = mode;
        o.textOnly = textOnly;
        break;
      }
      case 'spotlightShape':
        o.shape = v;
        break;
      case 'spotlightDim':
        for (const s of this.doc.objects) if (s.type === 'spotlight') s.dim = v;
        break;
      case 'magnifierZoom':
        o.zoom = v;
        break;
      case 'rulerUnit':
        o.unit = v;
        break;
      default:
        o[name] = v;
    }
  }

  setProp(name, value) {
    let key = name;
    if (name === 'fill') key = this.contextType() === 'oval' ? 'ovalFill' : 'rectFill';
    this.props[key] = value;
    if (name !== 'rulerAxis') this.persistEditor({ [key]: value });
    const o = this.selected;
    if (o && this.accepts(o, name)) {
      this.#applyProp(o, name, value);
      this.doc.changed();
      this.commit(SLIDER_PROPS.has(name) ? `prop:${name}:${o.id}` : null);
      if (name === 'concealType') this.ensureConcealOcr(o);
    }
    this.emit('props');
  }

  addCustomColor(hex) {
    hex = normalizeHex(hex);
    if (!this.customColors.includes(hex)) {
      this.customColors = [...this.customColors, hex].slice(-14);
      setSettings({ editor: { customColors: this.customColors } }).catch(() => {});
    }
    this.setProp('color', hex);
  }

  removeCustomColor(hex) {
    this.customColors = this.customColors.filter((c) => c !== hex);
    setSettings({ editor: { customColors: this.customColors } }).catch(() => {});
    this.emit('props');
  }

  // ---- backdrop -------------------------------------------------------------
  setBackdrop(patch, { persist = true } = {}) {
    if (Object.entries(patch).every(([key, value]) => this.backdrop[key] === value)) return;
    Object.assign(this.backdrop, patch);
    this.backdropVersion++;
    this.dirty = true;
    this.exportCache = null;
    this.renderer.unfreeze();
    if (persist) this.persistBackdrop();
    this.emit('backdrop');
    this.invalidate();
  }

  async loadBackdropImage(url) {
    if (!url) return;
    try {
      this.renderer.bgImage = await loadBitmap(url);
      this.backdropImageUrl = url;
      this.exportCache = null;
      this.invalidate();
    } catch (e) {
      console.warn('backdrop image failed', e);
      this.renderer.bgImage = null;
    }
  }

  // ---- pixels ---------------------------------------------------------------
  // Colour of the rendered composite under a screen point (null while pixels are refreshing).
  colorAtScreen(sx, sy) {
    if (!this.compositePixels) {
      this.readCompositeLater();
      return null;
    }
    const [ox, oy] = this.view.screenToOut(sx, sy);
    return pixelAt(this.compositePixels, ox, oy);
  }

  getBasePixels() {
    if (!this.basePixels) this.basePixels = readPixels(this.doc.base);
    return this.basePixels;
  }

  // ---- OCR ------------------------------------------------------------------
  async ocrRegion(rect) {
    const full = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const r = rect ? intersect(rect, full) : full;
    if (!r || r.w < 3 || r.h < 3) return null;
    const x = Math.floor(r.x);
    const y = Math.floor(r.y);
    const c = makeCanvas(Math.ceil(r.w), Math.ceil(r.h));
    c.getContext('2d').drawImage(this.doc.base, -x, -y);
    const data = await canvasToBytes(c, 'png');
    let timer;
    let res;
    try {
      res = await Promise.race([
        kadr.invoke('native:ocr', { data }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR timed out')), 180000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { ...(res || {}), rect: { x, y, w: c.width, h: c.height } };
  }

  // "…-text" conceal modes: find text lines inside the area and conceal only those.
  async ensureConcealOcr(o) {
    if (!o || o.type !== 'conceal' || !o.textOnly) return;
    const key = rectKey(o);
    if (o.ocrKey === key && Array.isArray(o.boxes)) return;
    const baseVersion = this.doc.baseVersion;
    const pending = this.ocrInFlight.get(o.id);
    if (pending?.key === key && pending.baseVersion === baseVersion && pending.object === o) return;
    const request = { key, baseVersion, object: o };
    this.ocrInFlight.set(o.id, request);
    try {
      const res = await this.ocrRegion(o);
      const cur = this.doc.get(o.id);
      if (cur !== o || !res || this.doc.baseVersion !== baseVersion || rectKey(cur) !== key || !cur.textOnly) return;
      const off = res.rect;
      cur.boxes = (res.lines || []).filter((l) => l.box).map((l) => ({ x: off.x + l.box.x, y: off.y + l.box.y, w: l.box.width, h: l.box.height }));
      cur.ocrKey = key;
      this.doc.changed();
      this.history.amend();
      this.dirty = true;
      if (!cur.boxes.length) toast(t('editor.toast.noTextInArea'));
    } catch (e) {
      console.warn('conceal OCR failed', e);
      toast(t('editor.toast.ocrConcealFallback'));
    } finally {
      if (this.ocrInFlight.get(o.id) === request) this.ocrInFlight.delete(o.id);
    }
  }
}
