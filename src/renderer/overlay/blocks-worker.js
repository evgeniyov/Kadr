// Worker around blocks.js: block detection runs off the overlay's thread, so hovering stays smooth.
import { setImage, findBlocks } from './blocks.js';

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'image') {
    const c = new OffscreenCanvas(m.bitmap.width, m.bitmap.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(m.bitmap, 0, 0);
    m.bitmap.close();
    setImage(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  } else if (m.type === 'query') {
    let rects = [];
    try {
      rects = findBlocks(m.x, m.y, m.rect);
    } catch (err) {
      console.warn('blocks: query failed', err);
    }
    self.postMessage({ type: 'blocks', rect: m.rect, rects });
  }
};
