'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Arch } = require(require.resolve('builder-util', { paths: [require.resolve('app-builder-lib')] }));

module.exports = async function checkPackage({ appOutDir, arch, packager, electronPlatformName }) {
  if (electronPlatformName !== process.platform || Arch[arch] !== process.arch) {
    throw new Error('Build Kadr on the target platform and architecture to package the matching FFmpeg source.');
  }
  const mac = electronPlatformName === 'darwin';
  const resources = mac
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const licenseRoot = mac ? resources : appOutDir;
  const required = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'licenses/ffmpeg/FFmpeg-COPYING.GPLv2',
    'licenses/ffmpeg/sources.txt',
    'licenses/ffmpeg/build.txt',
    mac ? 'bin/ffmpeg/ffmpeg' : 'bin/ffmpeg/ffmpeg.exe',
  ].map((file) => path.join(resources, file));
  required.push(path.join(licenseRoot, 'LICENSE.electron.txt'), path.join(licenseRoot, 'LICENSES.chromium.html'));
  for (const file of required) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.size || !stat.isFile()) throw new Error(`Required package file missing: ${file}`);
  }
};
