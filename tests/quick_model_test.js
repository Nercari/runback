'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../bridge/agents');

const root = path.join(__dirname, '..');

test('quickModel: the built-in quick tier, the configured one, and agents with none', () => {
  assert.equal(A.quickModel({}, 'claude'), 'haiku');
  assert.equal(A.quickModel({ quickModel: 'sonnet' }, 'claude'), 'sonnet');
  assert.equal(A.quickModel({ quickModel: 'sonnet', models: ['opus'] }, 'claude'), '', 'a model the agent does not offer is ignored');
  assert.equal(A.quickModel({ quickModel: 'not-a-model' }, 'claude'), 'haiku', 'a bad value falls back to the built-in quick tier');
  assert.equal(A.quickModel({ models: ['opus', 'sonnet'] }, 'claude'), '', 'the player left the cheap model out');
  for (const id of ['codex', 'grok', 'agy', 'hermes']) assert.equal(A.quickModel({}, id), '', `${id} has no built-in quick tier`);
  assert.equal(A.quickModel({ models: ['gpt-5.5'], quickModel: 'gpt-5.5' }, 'codex'), 'gpt-5.5');
});

test('user-visible quick tier and stall recovery are documented with a release fragment', () => {
  const configDoc = fs.readFileSync(path.join(root, 'docs/CONFIGURATION.md'), 'utf8');
  assert.match(configDoc, /`quickModel`/, 'configuration reference names the quickModel key');
  assert.match(configDoc, /quick answer tier/i);
  const spec = fs.readFileSync(path.join(root, 'docs/spec.md'), 'utf8');
  assert.match(spec, /another agent installed on the bridge PC/);
  assert.ok(fs.existsSync(path.join(root, 'changes/quick-answer-tier.md')), 'release-note fragment for the quick tier');
});
