'use strict';
// Flush a sibling temporary file before replacing the destination on the same volume.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function destination(file) {
  try { return fs.realpathSync(file); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return path.resolve(file); }
}
function modeFor(file) {
  try { return fs.statSync(file).mode & 0o777; }
  catch (e) { if (e.code !== 'ENOENT') throw e; return 0o600; }
}
function temporary(file) { return path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); }
function syncDirectory(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR', 'EACCES'].includes(e.code)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeFileAtomicSync(file, data) {
  file = destination(file);
  const tmp = temporary(file);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', modeFor(file));
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
async function writeFileAtomic(file, data) {
  file = destination(file);
  const tmp = temporary(file);
  let fh;
  try {
    fh = await fs.promises.open(tmp, 'wx', modeFor(file));
    await fh.writeFile(data);
    await fh.sync(); await fh.close(); fh = null;
    await fs.promises.rename(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fh) await fh.close();
    await fs.promises.unlink(tmp).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }
}
// Keep two current copies. An older backup would retain text removed by redaction.
function writeJsonSync(file, data) {
  const bytes = JSON.stringify(data, null, 2);
  writeFileAtomicSync(file, bytes);
  writeFileAtomicSync(`${file}.bak`, bytes);
}
async function writeJson(file, data) {
  const bytes = JSON.stringify(data);
  await writeFileAtomic(file, bytes);
  await writeFileAtomic(`${file}.bak`, bytes);
}
function readJson(file, valid) {
  let damaged = false;
  for (const candidate of [file, `${file}.bak`]) {
    let raw;
    try { raw = fs.readFileSync(candidate, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try {
      const data = JSON.parse(raw);
      if (!valid(data)) throw new Error('invalid JSON shape');
      return { data, recovered: candidate !== file };
    } catch {
      damaged = true;
      // Preserve unreadable bytes before a later save replaces them.
      fs.copyFileSync(candidate, `${candidate}.corrupt-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
    }
  }
  return { data: null, recovered: damaged };
}
module.exports = { writeFileAtomic, writeFileAtomicSync, writeJson, writeJsonSync, readJson };
