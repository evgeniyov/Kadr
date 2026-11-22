'use strict';
// electron-builder mac.sign hook. A stable self-signed identity keeps existing
// macOS permissions across reinstalls. CI uses the imported identity if provided.

const signing = require('./mac-signing');
const { signAsync } = require(require.resolve('@electron/osx-sign', { paths: [require.resolve('app-builder-lib')] }));

const { KADR_SIGNING_P12: p12, KADR_SIGNING_P12_PASSWORD: password } = process.env;
if (process.env.CI) {
  delete process.env.KADR_SIGNING_P12;
  delete process.env.KADR_SIGNING_P12_PASSWORD;
}

module.exports = async function sign(opts) {
  const optionsForFile = opts.optionsForFile;
  const signWith = (id) => signAsync({
    ...opts,
    identity: id?.hash || '-',
    keychain: id?.keychain ?? opts.keychain,
    identityValidation: false,
    hardenedRuntime: false,
    optionsForFile: (file) => ({ ...optionsForFile?.(file), hardenedRuntime: false, timestamp: 'none' }),
  });

  if (process.env.KADR_ADHOC) return signWith(null);
  if (process.env.CI) {
    if (p12 && password) return signing.withCIIdentity(p12, password, signWith);
    return signWith(null);
  }

  let id = null;
  try {
    id = signing.ensure();
  } catch {
    console.warn('  • local Kadr signing identity unavailable, signing ad-hoc');
  }
  return signWith(id);
};
