'use strict';
// Appends recorder chunks to a temp file strictly in arrival order.
// Nothing is kept in memory beyond the chunk currently being written.

const fs = require('fs');

class ChunkSink {
  constructor(file) {
    this.file = file;
    this.bytes = 0;
    this.error = null;
    this.fh = null;
    this.chain = Promise.resolve();
  }

  async open() {
    this.fh = await fs.promises.open(this.file, 'w');
  }

  // Resolves when this chunk is on disk; rejects (and poisons the sink) on I/O errors.
  write(buf) {
    const job = this.chain.then(async () => {
      if (this.error) throw this.error;
      if (!this.fh) throw new Error('sink is closed');
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, null);
        off += bytesWritten;
      }
      this.bytes += buf.length;
    });
    this.chain = job.catch((e) => {
      this.error = this.error || e;
    });
    return job;
  }

  async close() {
    await this.chain;
    const fh = this.fh;
    this.fh = null;
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { ChunkSink };
