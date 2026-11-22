// Generic tool for annotation objects: grab handles of the selected object, move objects,
// or create a new object by dragging. The select tool (V) is this tool without creation.
import { typeOf } from '../objects/index.js';
import { LINE_HEIGHT } from '../objects/text.js';
import { SIZES } from '../consts.js';

const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export class ObjectTool {
  // creates: object type created by dragging (null = select tool)
  // hitMode: which existing objects can be grabbed (see App.hitTest)
  constructor(app, id, { creates = null, hitMode = 'draw' } = {}) {
    this.app = app;
    this.id = id;
    this.creates = creates;
    this.hitMode = hitMode;
    this.drag = null;
  }

  get busy() {
    return !!this.drag;
  }

  cursorFor(p) {
    const app = this.app;
    const sel = app.selected;
    const h = sel && app.handleAt(sel, p);
    if (h) return HANDLE_CURSORS[h.id] || 'grab';
    if (app.hitTest(p, this.hitMode)) return 'move';
    return this.creates ? 'crosshair' : 'default';
  }

  onHover(p) {
    const o = this.app.hitTest(p, this.hitMode);
    const id = o ? o.id : null;
    if (id !== this.app.hoverId) {
      this.app.hoverId = id;
      this.app.invalidate(false);
    }
  }

  onDown(p) {
    const app = this.app;
    const sel = app.selected;
    const h = sel && app.handleAt(sel, p);
    if (h) {
      this.drag = { kind: 'handle', id: sel.id, handle: h.id, orig: structuredClone(sel), start: p, moved: false };
      return;
    }
    const o = app.hitTest(p, this.hitMode);
    if (o) {
      app.select(o.id);
      this.drag = { kind: 'move', id: o.id, orig: structuredClone(o), start: p, moved: false };
      return;
    }
    if (this.creates) {
      this.startCreate(p);
      return;
    }
    app.select(null);
    if (p.meta) app.pixelSelection?.deselect();
  }

  startCreate(p, extra) {
    const app = this.app;
    app.select(null);
    const obj = app.newObject(this.creates, p.x, p.y, extra);
    app.doc.add(obj);
    app.beginInteraction(obj.id);
    this.drag = { kind: 'create', id: obj.id, start: p, moved: false };
    return obj;
  }

  onMove(p) {
    const d = this.drag;
    if (!d) return;
    const app = this.app;
    const o = app.doc.get(d.id);
    if (!o) {
      this.drag = null;
      return;
    }
    const T = typeOf(o);
    if (!d.moved) {
      if (Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) < 3) return;
      d.moved = true;
      if (d.kind !== 'create') app.beginInteraction(o.id);
    }
    const mods = { shift: p.shift, alt: p.alt };
    if (d.kind === 'handle') {
      T.setHandle(o, d.handle, p.x, p.y, mods, d.orig);
    } else if (d.kind === 'move') {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      Object.assign(o, structuredClone(d.orig));
      if (T.moveBody) T.moveBody(o, dx, dy, d.orig);
      else T.translate(o, dx, dy);
    } else {
      T.drag(o, d.start.x, d.start.y, p.x, p.y, mods);
    }
    app.doc.changed();
  }

  onUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const app = this.app;
    const o = app.doc.get(d.id);
    app.endInteraction();
    if (!o) return;
    const T = typeOf(o);
    if (d.kind === 'create') {
      if (!d.moved && T.drag && this.creates === 'magnifier') T.drag(o, d.start.x, d.start.y, d.start.x, d.start.y, {});
      T.finish?.(o);
      if (T.isEmpty(o)) {
        app.doc.remove(o.id);
        return;
      }
      app.select(o.id);
      app.commit();
      app.afterGeometryChange(o);
      return;
    }
    if (d.moved) {
      app.commit();
      app.afterGeometryChange(o);
    } else if (d.kind === 'move') {
      this.onClickObject?.(o, p);
    }
  }

  // Esc during a drag restores the object (or removes one being created).
  cancel() {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    const app = this.app;
    const o = app.doc.get(d.id);
    if (o) {
      if (d.kind === 'create') app.doc.remove(o.id);
      else {
        Object.assign(o, structuredClone(d.orig));
        app.doc.changed();
      }
    }
    app.endInteraction();
    return true;
  }
}

// Text: click to create (then type), click a text to edit it.
export class TextTool extends ObjectTool {
  constructor(app) {
    super(app, 'text', { creates: 'text' });
  }
  cursorFor(p) {
    const c = super.cursorFor(p);
    return c === 'crosshair' ? 'text' : c;
  }
  startCreate(p) {
    const app = this.app;
    app.select(null);
    const fs = SIZES.text[(app.props.size || 3) - 1] * app.doc.scale;
    const obj = app.newObject('text', p.x - fs * 0.15, p.y - (fs * LINE_HEIGHT) / 2);
    app.doc.add(obj);
    app.select(obj.id);
    app.textEditor.begin(obj, { isNew: true });
  }
  onClickObject(o) {
    if (o.type === 'text') this.app.textEditor.begin(o);
  }
}

// Counter: every click adds the next number.
export class CounterTool extends ObjectTool {
  constructor(app) {
    super(app, 'counter', { creates: 'counter' });
  }
  startCreate(p) {
    const app = this.app;
    const obj = app.newObject('counter', p.x, p.y);
    app.doc.add(obj);
    app.select(obj.id);
    app.commit();
    // Keep dragging to position the new counter precisely.
    this.drag = { kind: 'move', id: obj.id, orig: structuredClone(obj), start: p, moved: false };
  }
}
