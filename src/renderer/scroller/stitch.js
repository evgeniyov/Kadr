// Stitches consecutive frames of scrolling content into one tall image.
//
// Each frame is compared with the previous one using per-row hashes:
// - rows identical at the same position at the top/bottom are "fixed" (sticky
//   headers/footers) and are excluded from matching;
// - the vertical shift `dy` is the offset where the scrolling band of the new frame
//   best matches the previous one (only rows with actual detail are counted);
// - the new rows at the bottom of the band are appended; the footer of the last
//   frame is added once at the end.

function rowHashes(img) {
  const { data, width, height } = img;
  const hashes = new Uint32Array(height);
  const informative = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let h = 2166136261;
    let min = 255;
    let max = 0;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const r = data[i] >> 3;
      const g = data[i + 1] >> 3;
      const b = data[i + 2] >> 3;
      h = Math.imul(h ^ ((r << 10) | (g << 5) | b), 16777619);
      const l = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    hashes[y] = h >>> 0;
    informative[y] = max - min > 10 ? 1 : 0;
  }
  return { hashes, informative };
}

function sliceRows(img, from, to) {
  const { width, data } = img;
  const out = new ImageData(width, Math.max(1, to - from));
  out.data.set(data.subarray(from * width * 4, to * width * 4));
  return out;
}

export class Stitcher {
  constructor(width, height, { maxHeight = 30000 } = {}) {
    this.w = width;
    this.h = height;
    this.max = Math.max(1, Math.floor(Number(maxHeight) || 30000));
    this.chunks = []; // ImageData slices in order
    this.prev = null; // { img, hashes, informative }
    this.lastTo = 0; // end row (in prev frame coordinates) of the stitched content
    this.total = 0;
    this.full = false;
    this.thumb = null; // incremental preview canvas
  }

  get height() {
    return Math.min(this.max, this.total + (this.h - this.lastTo));
  }

  // Returns { first?, changed, height, full, dy? }
  add(img, expected = 0) {
    const cur = { img, ...rowHashes(img) };
    if (!this.prev) {
      this.prev = cur;
      this.lastTo = Math.min(this.h, this.max);
      this._push(sliceRows(img, 0, this.lastTo));
      this.full = this.height >= this.max;
      return { first: true, changed: true, height: this.height, full: this.full };
    }
    if (this.full) return { changed: false, height: this.height, full: true };

    const a = this.prev.hashes;
    const b = cur.hashes;
    const h = this.h;
    let same = 0;
    for (let y = 0; y < h; y++) if (a[y] === b[y]) same++;
    if (same === h) return { changed: false, height: this.height, full: false };

    const limit = Math.floor(h / 3);
    let top = 0;
    while (top < limit && a[top] === b[top]) top++;
    let bottom = 0;
    while (bottom < limit && a[h - 1 - bottom] === b[h - 1 - bottom]) bottom++;

    const dy = this._findShift(a, b, cur.informative, top, h - bottom, expected);
    if (!dy) return { changed: false, height: this.height, full: false, lost: true };

    // Drop the previous frame's footer from the stitched content.
    const footerStart = h - bottom;
    if (this.lastTo > footerStart) {
      const last = this.chunks[this.chunks.length - 1];
      const cut = this.lastTo - footerStart;
      if (last && last.height > cut) {
        this.chunks[this.chunks.length - 1] = sliceRows(last, 0, last.height - cut);
        this.total -= cut;
        this._rebuildThumbTail();
      }
      this.lastTo = footerStart;
    }

    const from = Math.max(top, this.lastTo - dy);
    let to = footerStart;
    if (this.total + (to - from) > this.max) {
      to = from + Math.max(0, this.max - this.total);
      this.full = true;
    }
    if (to > from) this._push(sliceRows(img, from, to));
    this.lastTo = to;
    this.prev = cur;
    this.full = this.height >= this.max;
    return { changed: true, height: this.height, full: this.full, dy };
  }

  _findShift(a, b, info, top, end, expected) {
    const band = end - top;
    const minOverlap = Math.max(8, Math.floor(band * 0.12));
    let best = 0;
    let bestScore = -1;
    for (let dy = 1; dy <= band - minOverlap; dy++) {
      let match = 0;
      let count = 0;
      let miss = 0;
      const last = end - dy;
      for (let i = top; i < last; i++) {
        if (!info[i]) continue;
        count++;
        if (b[i] === a[i + dy]) match++;
        else if (++miss > (last - top) * 0.25) break;
      }
      if (count < 5) continue;
      const score = match / count;
      const closer = expected && Math.abs(dy - expected) < Math.abs(best - expected);
      if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && closer)) {
        best = dy;
        bestScore = score;
      }
    }
    return bestScore >= 0.8 ? best : 0;
  }

  _push(slice) {
    this.chunks.push(slice);
    this.total += slice.height;
    this._appendThumb(slice);
  }

  // ---- preview ---------------------------------------------------------------
  _thumbScale() {
    return Math.min(1, 220 / this.w);
  }

  _appendThumb(slice) {
    const k = this._thumbScale();
    const needH = Math.ceil(this.total * k);
    if (!this.thumb || this.thumb.height < needH) {
      const next = new OffscreenCanvas(Math.max(1, Math.round(this.w * k)), Math.max(needH, (this.thumb?.height || 0) * 2, 64));
      if (this.thumb) next.getContext('2d').drawImage(this.thumb, 0, 0);
      this.thumb = next;
    }
    const tmp = new OffscreenCanvas(slice.width, slice.height);
    tmp.getContext('2d').putImageData(slice, 0, 0);
    const y = (this.total - slice.height) * k;
    this.thumb.getContext('2d').drawImage(tmp, 0, 0, slice.width, slice.height, 0, y, this.thumb.width, slice.height * k);
  }

  _rebuildThumbTail() {
    if (!this.thumb) return;
    const k = this._thumbScale();
    const c = this.thumb.getContext('2d');
    c.clearRect(0, this.total * k, this.thumb.width, this.thumb.height);
  }

  // Data URL of the last part of the stitched image (what the user just captured).
  thumbnail(width = 220, flip = false) {
    if (!this.thumb) return null;
    const k = this._thumbScale();
    const h = Math.max(1, Math.ceil(this.total * k));
    const show = Math.min(h, Math.round(width * 1.4));
    const out = document.createElement('canvas');
    out.width = this.thumb.width;
    out.height = show;
    const c = out.getContext('2d');
    if (flip) {
      c.translate(0, show);
      c.scale(1, -1);
    }
    c.drawImage(this.thumb, 0, h - show, this.thumb.width, show, 0, 0, this.thumb.width, show);
    return out.toDataURL('image/jpeg', 0.8);
  }

  // Final image as an OffscreenCanvas (flip=true for "scrolling up" captures).
  compose(flip = false) {
    if (!this.chunks.length) return null;
    // At the height limit, unappended rows are truncated content, not a footer.
    const footer = this.prev ? Math.max(0, this.height - this.total) : 0;
    const H = this.total + footer;
    const out = new OffscreenCanvas(this.w, H);
    const c = out.getContext('2d');
    let y = 0;
    for (const ch of this.chunks) {
      c.putImageData(ch, 0, y);
      y += ch.height;
    }
    if (footer > 0) c.putImageData(sliceRows(this.prev.img, this.lastTo, this.lastTo + footer), 0, y);
    if (!flip) return out;
    const flipped = new OffscreenCanvas(this.w, H);
    const f = flipped.getContext('2d');
    f.translate(0, H);
    f.scale(1, -1);
    f.drawImage(out, 0, 0);
    return flipped;
  }
}
