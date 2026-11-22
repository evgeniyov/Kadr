// In-place text editing: a transparent <textarea> over the canvas provides the caret and
// selection while the object itself is rendered live underneath (WYSIWYG).
import { layoutText, counterGeometry, textFont, LINE_HEIGHT, measure } from '../objects/text.js';

export class TextEditor {
  constructor(app, textarea, { save } = {}) {
    this.app = app;
    this.ta = textarea;
    this.obj = null;
    this.field = 'text';
    this.save = save;
    textarea.addEventListener('input', () => this.#onInput());
    textarea.addEventListener('keydown', (e) => this.#onKey(e));
    textarea.addEventListener('blur', () => this.commit());
    app.on('zoom', () => this.position());
  }

  get active() {
    return !!this.obj;
  }

  begin(o, { isNew = false } = {}) {
    if (this.obj) this.commit();
    this.obj = o;
    this.field = o.type === 'counter' ? 'label' : 'text';
    this.isNew = isNew;
    this.before = o[this.field] || '';
    this.ta.value = this.before;
    this.ta.classList.remove('hidden');
    this.ta.style.caretColor = o.type === 'text' && o.style !== 'box' ? o.color : '#fff';
    this.app.select(o.id);
    this.position();
    this.ta.focus();
    if (!isNew) this.ta.select();
    this.app.emit('textedit');
    this.app.invalidate();
  }

  #geometry() {
    const o = this.obj;
    if (this.field === 'text') {
      const L = layoutText(o);
      return { x: o.x + L.padX, y: o.y + L.padY, fs: L.fs, lh: L.lh, lines: L.lines, width: Math.max(...L.widths, 0) };
    }
    const g = counterGeometry(o, this.app.doc.counterNumber(o));
    const fs = g.R * 0.95;
    const lines = String(o.label || '').split('\n');
    const h = lines.length * fs * LINE_HEIGHT + fs * 0.44;
    const width = Math.max(0, ...lines.map((l) => measure(l, fs)));
    return { x: o.x + g.R * 1.25 + fs * 0.45, y: o.y - h / 2 + fs * 0.22, fs, lh: fs * LINE_HEIGHT, lines, width };
  }

  position() {
    if (!this.obj) return;
    const G = this.#geometry();
    const vs = this.app.vs;
    const [sx, sy] = this.app.toScreen(G.x, G.y);
    const fs = G.fs * vs;
    const s = this.ta.style;
    s.left = `${sx}px`;
    s.top = `${sy}px`;
    s.font = textFont(fs);
    s.lineHeight = `${G.lh * vs}px`;
    s.width = `${Math.ceil(G.width * vs + fs * 1.2 + 4)}px`;
    s.height = `${Math.ceil(G.lines.length * G.lh * vs + 2)}px`;
  }

  #onInput() {
    if (!this.obj) return;
    this.obj[this.field] = this.ta.value;
    this.app.doc.changed();
    // The native close button can be used before blur commits the history step.
    this.app.dirty = true;
    this.position();
  }

  #onKey(e) {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') {
      e.preventDefault();
      this.save?.({ saveAs: !!e.shiftKey });
      return;
    }
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      this.commit();
    }
  }

  commit() {
    const o = this.obj;
    if (!o) return;
    this.obj = null;
    this.ta.classList.add('hidden');
    this.ta.blur();
    const app = this.app;
    if (app.doc.get(o.id)) {
      const val = o[this.field] || '';
      if (this.field === 'text' && !val.trim()) {
        app.doc.remove(o.id);
        app.select(null);
        if (!this.isNew) app.commit();
      } else if (this.isNew || val !== this.before) {
        app.commit();
      }
    }
    app.emit('textedit');
    app.invalidate();
  }
}
