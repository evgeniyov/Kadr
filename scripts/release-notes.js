'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');

const tag = process.argv[2];
if (tag !== `v${version}`) throw new Error(`Release tag must match package version v${version}`);

const lines = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((line) => line.match(/^##\s+([^\s,]+)(?:,|\s|$)/)?.[1] === version);
if (start < 0) throw new Error(`CHANGELOG.md has no entry for ${version}`);
const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
const notes = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
if (!notes) throw new Error(`CHANGELOG.md has an empty entry for ${version}`);
console.log(notes);
