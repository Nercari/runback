'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { countAddon, scanAddon, bannedRe } = require('../../tools/addon-model-name-ban');

const ADDON = path.join(__dirname, '../../addon/Runback');

test('addon lua has no pinned model-id strings', () => {
  assert.equal(countAddon(ADDON), 0, scanAddon(ADDON).map(h => `${h.file}:${h.line}`).join('\n') || 'clean');
});

test('the ban rejects a planted model id in a scratch lua file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-ban-'));
  const file = path.join(dir, 'Planted.lua');
  fs.writeFileSync(file, '-- comment with haiku should count\nlocal x = "sonnet"\n');
  assert.ok(bannedRe.test('haiku'));
  assert.equal(countAddon(dir), 2, 'one live string and one comment hit');
  assert.equal(countAddon(ADDON), 0, 'the real addon tree stays clean');
});
