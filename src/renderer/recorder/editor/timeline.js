// Trim timeline: filmstrip thumbnails, draggable in/out handles, scrubbable playhead.
const MIN_CLIP = 0.1; // s

export class Timeline {
  constructor(root, { onSeek, onTrim }) {
    this.root = root;
    this.onSeek = onSeek;
    this.onTrim = onTrim;
    this.duration = 0;
    this.trim = { start: 0, end: 0 };
    this.time = 0;
    this.thumbToken = 0;
    root.replaceChildren();
    this.canvas = Object.assign(document.createElement('canvas'), { className: 'thumbs' });
    this.shadeL = div('shade left');
    this.shadeR = div('shade right');
    this.range = div('range');
    this.hIn = div('handle in');
    this.hOut = div('handle out');
    this.range.append(this.hIn, this.hOut);
    this.playhead = div('playhead');
    root.append(this.canvas, this.shadeL, this.shadeR, this.range, this.playhead);
    root.addEventListener('pointerdown', (e) => this.pointerDown(e));
  }

  timeAt(clientX) {
    const r = this.root.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.duration;
  }

  pointerDown(e) {
    if (!this.duration || e.button !== 0) return;
    e.preventDefault();
    const what = e.target === this.hIn ? 'in' : e.target === this.hOut ? 'out' : 'seek';
    this.root.setPointerCapture(e.pointerId);
    this.root.classList.add('dragging');
    const move = (ev) => {
      const t = this.timeAt(ev.clientX);
      if (what === 'in') {
        this.trim.start = Math.min(t, this.trim.end - MIN_CLIP);
        this.onTrim({ ...this.trim }, this.trim.start);
      } else if (what === 'out') {
        this.trim.end = Math.max(t, this.trim.start + MIN_CLIP);
        this.onTrim({ ...this.trim }, this.trim.end);
      } else {
        this.onSeek(t);
      }
      this.render();
    };
    const up = () => {
      this.root.removeEventListener('pointermove', move);
      this.root.classList.remove('dragging');
    };
    this.root.addEventListener('pointermove', move);
    this.root.addEventListener('pointerup', up, { once: true });
    this.root.addEventListener('pointercancel', up, { once: true });
    move(e);
  }

  set({ duration, trim, time }) {
    if (duration != null) this.duration = duration;
    if (trim) this.trim = { ...trim };
    if (time != null) this.time = time;
    this.render();
  }

  render() {
    const pct = (v) => `${this.duration ? (v / this.duration) * 100 : 0}%`;
    const { start, end } = this.trim;
    this.shadeL.style.width = pct(start);
    this.shadeR.style.left = pct(end);
    Object.assign(this.range.style, { left: pct(start), width: `calc(${pct(end - start)})` });
    this.playhead.style.left = pct(this.time);
  }

  // Filmstrip drawn from a hidden, muted copy of the video (sequential seeks).
  async buildThumbs(url, aspect) {
    const token = ++this.thumbToken;
    const dpr = window.devicePixelRatio || 1;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (!w || !h || !url) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.canvas.getContext('2d');
    const tw = Math.max(24, h * (aspect || 16 / 9));
    const count = Math.max(1, Math.ceil(w / tw));
    const v = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', src: url });
    try {
      await once(v, 'loadeddata', 8000);
      for (let i = 0; i < count && token === this.thumbToken; i++) {
        v.currentTime = Math.min(this.duration - 0.05, ((i + 0.5) / count) * this.duration);
        await once(v, 'seeked', 3000);
        const k = Math.max(tw / v.videoWidth, h / v.videoHeight);
        const dw = v.videoWidth * k;
        const dh = v.videoHeight * k;
        g.save();
        g.beginPath();
        g.rect(i * tw * dpr, 0, tw * dpr, h * dpr);
        g.clip();
        g.drawImage(v, (i * tw + (tw - dw) / 2) * dpr, ((h - dh) / 2) * dpr, dw * dpr, dh * dpr);
        g.restore();
      }
    } catch {
      /* thumbnails are decoration only */
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  }
}

function div(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function once(target, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener('error', () => (clearTimeout(timer), reject(new Error('media error'))), { once: true });
  });
}
