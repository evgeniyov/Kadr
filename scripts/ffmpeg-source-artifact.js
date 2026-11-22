'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function copySources({ artifactPaths, outDir }) {
  if (!artifactPaths.some((file) => /\.(dmg|zip|msi)$/.test(file))) return [];
  const target = `${process.platform}-${process.arch}`;
  const filename = `ffmpeg-source-${target}.tar.gz`;
  const input = path.join(__dirname, '..', 'resources', 'bin', 'ffmpeg', target, filename);
  const output = path.join(outDir, filename);
  await fs.copyFile(input, output);
  return [output];
};
