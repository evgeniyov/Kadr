'use strict';
// Local code-signing identity for macOS builds.
//
// Ad-hoc signed builds get a new code identity on every build, so macOS forgets Screen
// Recording, Accessibility and Microphone access after each reinstall. Signing every build
// with the same self-signed certificate keeps the identity ("app.kadr.screenshots" + this
// certificate) stable, and access granted once stays granted.
//
// The certificate lives in its own keychain in ~/.kadr-signing (outside the project, never
// committed). It is not added to the keychain search list and not trusted system-wide:
// codesign doesn't need either. Anyone holding that folder can sign apps macOS treats as
// Kadr, so keep it private; copy it to a new Mac to keep permissions there too.
//
//   node scripts/mac-signing.js      create the identity (once) and print it

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = process.env.KADR_SIGNING_DIR || path.join(os.homedir(), '.kadr-signing');
const KEYCHAIN = path.join(DIR, 'kadr-signing.keychain-db');
const PASSWORD = path.join(DIR, 'keychain-password');
const NAME = 'Kadr Local Signing';
const SECURITY = '/usr/bin/security';
const OPENSSL = '/usr/bin/openssl'; // LibreSSL: its .p12 files import into the keychain as is

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function unlock() {
  run(SECURITY, ['unlock-keychain', '-p', fs.readFileSync(PASSWORD, 'utf8').trim(), KEYCHAIN]);
}

function searchList() {
  return run(SECURITY, ['list-keychains', '-d', 'user'])
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function createKeychain(keychain, password) {
  // security create-keychain adds the keychain to the search list.
  const previous = searchList();
  try {
    run(SECURITY, ['create-keychain', '-p', password, keychain]);
  } finally {
    run(SECURITY, ['list-keychains', '-d', 'user', '-s', ...previous]);
  }
}

function importIdentity(p12, p12Password, keychain, password) {
  run(SECURITY, ['set-keychain-settings', keychain]);
  run(SECURITY, ['unlock-keychain', '-p', password, keychain]);
  run(SECURITY, ['import', p12, '-k', keychain, '-P', p12Password, '-T', '/usr/bin/codesign']);
  // Lets codesign use the key without a keychain access dialog.
  run(SECURITY, ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
}

function findInKeychain(keychain) {
  // Self-signed identities appear in the matching list but need no system trust.
  const identities = run(SECURITY, ['find-identity', '-p', 'codesigning', keychain]);
  const hashes = new Set([...identities.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)]
    .filter((match) => match[2] === NAME)
    .map((match) => match[1]));
  if (hashes.size !== 1) return null;
  return { hash: [...hashes][0], name: NAME, keychain };
}

function find() {
  if (!fs.existsSync(KEYCHAIN) || !fs.existsSync(PASSWORD)) return null;
  unlock();
  return findInKeychain(KEYCHAIN);
}

async function withCIIdentity(encoded, p12Password, sign) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-ci-signing-'));
  const keychain = path.join(tmp, 'identity.keychain-db');
  const p12 = path.join(tmp, 'identity.p12');
  try {
    let identity;
    try {
      const password = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(p12, Buffer.from(encoded, 'base64'), { mode: 0o600 });
      createKeychain(keychain, password);
      importIdentity(p12, p12Password, keychain, password);
      identity = findInKeychain(keychain);
    } catch {
      // execFileSync errors can include command arguments with passwords.
      throw new Error('Could not import the CI signing identity. Check KADR_SIGNING_P12 and KADR_SIGNING_P12_PASSWORD.');
    } finally {
      fs.rmSync(p12, { force: true });
    }
    if (!identity) throw new Error(`The CI PKCS#12 must contain one "${NAME}" identity.`);
    return await sign(identity);
  } finally {
    try {
      if (fs.existsSync(keychain)) run(SECURITY, ['delete-keychain', keychain]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function create() {
  // Never replace an existing key: builds signed with it would lose their permissions.
  if (fs.existsSync(KEYCHAIN)) throw new Error(`${KEYCHAIN} exists but has no usable identity`);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-signing-'));
  try {
    const cnf = path.join(tmp, 'cert.cnf');
    const key = path.join(tmp, 'key.pem');
    const cert = path.join(tmp, 'cert.pem');
    const p12 = path.join(tmp, 'identity.p12');
    const password = crypto.randomBytes(24).toString('hex');
    const p12Password = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = ext',
        '[dn]',
        `CN = ${NAME}`,
        '[ext]',
        'basicConstraints = critical, CA:false',
        'keyUsage = critical, digitalSignature',
        'extendedKeyUsage = critical, codeSigning',
        'subjectKeyIdentifier = hash',
        '',
      ].join('\n'),
    );
    run(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '7300', '-nodes', '-keyout', key, '-out', cert, '-config', cnf]);
    run(OPENSSL, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', NAME, '-out', p12, '-passout', `pass:${p12Password}`]);

    createKeychain(KEYCHAIN, password);
    fs.writeFileSync(PASSWORD, password, { mode: 0o600 });
    importIdentity(p12, p12Password, KEYCHAIN, password);
    fs.copyFileSync(cert, path.join(DIR, 'certificate.pem'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const id = find();
  if (!id) throw new Error('the new signing identity was not found');
  return id;
}

function ensure({ create: allowCreate = true } = {}) {
  return find() || (allowCreate ? create() : null);
}

if (require.main === module) {
  const id = ensure();
  console.log(`Identity: ${id.name}\nSHA-1:    ${id.hash}\nKeychain: ${id.keychain}`);
}

module.exports = { ensure, find, withCIIdentity, DIR };
