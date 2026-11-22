// Pointer, wheel and keyboard handling for the canvas and global shortcuts.
import { isMac } from '../../shared/ui.js';
import { TOOLS } from './consts.js';
import { clamp } from './geom.js';

const TOOL_KEYS = new Map(TOOLS.map((t) => [t.key, t.id]));

function isTyping(el) {
  return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'button'].includes(el.type)) || el.isContentEditable);
}

// actions: { copy, save, saveAs, pin, paste, escape, toggleBackdrop, ocr, close, contextMenu }
export function attachInput(app, actions) {
  const vp = app.dom.viewport;
  let pan = null;
  let spaceHeld = false;
  let downOnCanvas = false;

  const capture = (e) => {
    try {
      vp.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
  };

  const pointer = (e) => {
    const r = vp.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const [x, y] = app.toDoc(sx, sy);
    return { x, y, sx, sy, shift: e.shiftKey, alt: e.altKey, meta: isMac ? e.metaKey : e.ctrlKey };
  };

  const updateCursor = (p) => {
    let c = 'default';
    if (pan) c = 'grabbing';
    else if (spaceHeld) c = 'grab';
    else if (p && app.tool?.cursorFor) c = app.tool.cursorFor(p) || 'default';
    vp.style.cursor = c;
  };

  // Keep focus in the text editor while clicking the canvas (and avoid text selection).
  vp.addEventListener('mousedown', (e) => {
    if (e.target !== app.dom.textarea) e.preventDefault();
  });

  vp.addEventListener('pointerdown', (e) => {
    if (e.target === app.dom.textarea) return;
    if (!app.layout) return;
    app.closePopovers?.();
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      pan = { x: e.clientX, y: e.clientY };
      capture(e);
      updateCursor();
      return;
    }
    if (e.button !== 0) return;
    if (app.textEditor.active) {
      app.textEditor.commit();
      return;
    }
    downOnCanvas = true;
    capture(e);
    const p = pointer(e);
    app.tool?.onDown?.(p, e);
    app.invalidate(false);
  });

  vp.addEventListener('pointermove', (e) => {
    if (!app.layout) return;
    if (pan) {
      app.view.panBy(e.clientX - pan.x, e.clientY - pan.y);
      pan = { x: e.clientX, y: e.clientY };
      return;
    }
    const p = pointer(e);
    app.cursor = p;
    if (downOnCanvas) app.tool?.onMove?.(p, e);
    else app.tool?.onHover?.(p, e);
    updateCursor(p);
    app.emit('cursor');
  });

  const up = (e) => {
    if (pan) {
      pan = null;
      updateCursor();
      return;
    }
    if (!downOnCanvas) return;
    downOnCanvas = false;
    app.tool?.onUp?.(pointer(e), e);
    updateCursor(pointer(e));
    app.invalidate(false);
  };
  vp.addEventListener('pointerup', up);
  vp.addEventListener('pointercancel', up);

  vp.addEventListener('pointerleave', () => {
    if (downOnCanvas || pan) return;
    app.cursor = null;
    if (app.hoverId) {
      app.hoverId = null;
      app.invalidate(false);
    }
    app.emit('cursor');
  });

  vp.addEventListener('dblclick', (e) => {
    if (e.target === app.dom.textarea) return;
    const p = pointer(e);
    const o = app.hitTest(p, 'all');
    if (o && (o.type === 'text' || o.type === 'counter')) app.textEditor.begin(o);
  });

  vp.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = pointer(e);
    const o = app.hitTest(p, 'all');
    if (o) app.select(o.id);
    actions.contextMenu?.(e, o);
  });

  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      if (e.ctrlKey || e.metaKey) {
        const f = clamp(Math.exp(-e.deltaY * unit * 0.01), 0.75, 1.33);
        app.view.setZoom(app.view.zoom * f, sx, sy);
      } else {
        let dx = e.deltaX * unit;
        let dy = e.deltaY * unit;
        if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
        app.view.panBy(-dx, -dy);
      }
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || app.modalOpen?.()) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        updateCursor();
      }
      return;
    }
    if (mod) {
      const code = e.code;
      const handled = {
        KeyZ: () => (e.shiftKey ? app.redo() : app.undo()),
        KeyY: () => app.redo(),
        KeyC: () => actions.copy(),
        KeyA: () => app.pixelSelection.selectAll(),
        KeyI: () => e.shiftKey && app.pixelSelection.invert(),
        KeyS: () => (e.shiftKey ? actions.saveAs() : actions.save()),
        KeyP: () => actions.pin(),
        KeyV: () => actions.paste(),
        KeyD: () => app.duplicateSelected(),
        KeyW: () => actions.close(),
        Equal: () => app.view.zoomStep(1),
        NumpadAdd: () => app.view.zoomStep(1),
        Minus: () => app.view.zoomStep(-1),
        NumpadSubtract: () => app.view.zoomStep(-1),
        Digit0: () => app.view.fit(false),
        Digit1: () => app.view.setZoom(1),
        BracketRight: () => app.arrangeSelected(e.shiftKey ? 'front' : 'forward'),
        BracketLeft: () => app.arrangeSelected(e.shiftKey ? 'back' : 'backward'),
      }[code];
      if (handled) {
        e.preventDefault();
        handled();
      }
      return;
    }
    if (e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      actions.escape();
      return;
    }
    if (e.key === 'Enter') {
      if (app.tool?.onEnter?.()) return e.preventDefault();
      const o = app.selected;
      if (o && (o.type === 'text' || o.type === 'counter')) {
        e.preventDefault();
        app.textEditor.begin(o);
      }
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (app.deleteSelected() || app.pixelSelection.erase()) e.preventDefault();
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      if (!app.selected) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      app.nudgeSelected(arrows[e.key][0] * step, arrows[e.key][1] * step);
      return;
    }
    if (e.shiftKey || e.repeat) return;
    // Physical key codes, so the hotkeys also work with a Russian keyboard layout.
    const up = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : k.toUpperCase();
    if (up === '1' || up === '2') {
      app.setProp('rulerAxis', up === '1' ? 'h' : 'v');
      app.setTool('ruler', { force: true });
      return;
    }
    if (up === 'K') return actions.toggleBackdrop();
    const tool = TOOL_KEYS.get(up);
    if (tool) {
      e.preventDefault();
      app.setTool(tool);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && spaceHeld) {
      spaceHeld = false;
      updateCursor(app.cursor);
    }
  });

  window.addEventListener('blur', () => {
    spaceHeld = false;
  });
}
