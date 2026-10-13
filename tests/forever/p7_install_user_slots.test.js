'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('user slot installer creates 20 marked slots, is idempotent and protects unmarked folders', () => {
  const addons = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-user-slots-'));
  const script = path.resolve(__dirname, '../../tools/install-user-slots.js');
  const run = () => spawnSync(process.execPath, [script, '--addons', addons, '--interface', '16002'], { encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  for (let i = 1; i <= 20; i++) {
    const slot = `Runback_U${String(i).padStart(2, '0')}`;
    const dir = path.join(addons, slot);
    assert.ok(fs.existsSync(path.join(dir, '.runback-slot')));
    assert.match(fs.readFileSync(path.join(dir, `${slot}.toc`), 'utf8'), /## Interface: 16002/);
    assert.equal(fs.readFileSync(path.join(dir, 'main.lua'), 'utf8'), '-- Reserved for the Runback builder.\n');
  }
  result = run();
  assert.equal(result.status, 0, result.stderr);
  const unmarked = path.join(addons, 'Runback_U01');
  fs.unlinkSync(path.join(unmarked, '.runback-slot'));
  const before = fs.readFileSync(path.join(unmarked, 'main.lua'), 'utf8');
  result = run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(unmarked, 'main.lua'), 'utf8'), before);
});
