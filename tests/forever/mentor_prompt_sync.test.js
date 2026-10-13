'use strict';
// Backlog items 29, 30 and 37 fix the coach's instructions in mentor/AGENTS.md.
// The workspace is a one-time copy, so those fixes must be carried over.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncPrompt } = require('../../bridge/forever/modules/05-mentor-guard.js');

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-sync-'));
  const template = path.join(root, 'mentor'), work = path.join(root, 'wow-mentor');
  fs.mkdirSync(template); fs.mkdirSync(work);
  fs.writeFileSync(path.join(template, 'AGENTS.md'), 'new rules\n');
  return { root, template, work };
}

test('an existing workspace gets the new AGENTS.md; the old one is kept and player files stay', () => {
  const { template, work } = dirs();
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'old rules\n');
  fs.writeFileSync(path.join(work, 'LOCAL.md'), 'my paths\n');
  assert.equal(syncPrompt(template, work), true);
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), 'new rules\n');
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md.bak'), 'utf8'), 'old rules\n');
  assert.equal(fs.readFileSync(path.join(work, 'LOCAL.md'), 'utf8'), 'my paths\n');
  assert.deepEqual(fs.readdirSync(work).sort(), ['AGENTS.md', 'AGENTS.md.bak', 'LOCAL.md']);
});

test('an up-to-date workspace is left alone, and a missing one is not created', () => {
  const { root, template, work } = dirs();
  fs.writeFileSync(path.join(work, 'AGENTS.md'), 'new rules\n');
  assert.equal(syncPrompt(template, work), false);
  assert.equal(fs.existsSync(path.join(work, 'AGENTS.md.bak')), false);
  assert.equal(syncPrompt(template, path.join(root, 'nowhere')), false);
  assert.equal(fs.existsSync(path.join(root, 'nowhere')), false);
});
