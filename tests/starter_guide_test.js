// The shipped starter guide (backlog 74): valid, kept whole by the validator,
// in quest order, and free of anything that looks like automation.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGuideText } = require('../bridge/guide');

const file = path.join(__dirname, '..', 'guides', 'starter-deathknell.json');
const text = fs.readFileSync(file, 'utf8');
const raw = JSON.parse(text);
const { guides, why } = parseGuideText(text);
const guide = guides[0];

test('starter guide parses with no reasons and nothing cleaned away', () => {
  assert.deepEqual(why, []);
  assert.equal(guides.length, 1);
  assert.deepEqual(guide, raw);
});

test('starter guide is a Horde guide for levels 1 to 5 with a source', () => {
  assert.equal(guide.id, 'starter-deathknell');
  assert.equal(guide.faction, 'Horde');
  assert.equal(guide.minLevel, 1);
  assert.equal(guide.maxLevel, 5);
  assert.ok(guide.source && guide.source.length > 0);
});

test('per quest: accept comes before do, and do before turnin', () => {
  const rank = { accept: 0, do: 1, turnin: 2 };
  const seen = new Map(); // questId -> highest rank so far
  guide.steps.forEach((s, i) => {
    if (!(s.kind in rank)) return;
    assert.ok(s.questId, `step ${i + 1}: ${s.kind} without questId`);
    const r = rank[s.kind];
    if (r > 0) assert.ok(seen.has(s.questId), `step ${i + 1}: ${s.kind} of ${s.questId} before its accept`);
    else assert.ok(!seen.has(s.questId), `step ${i + 1}: quest ${s.questId} accepted twice`);
    assert.ok(!seen.has(s.questId) || seen.get(s.questId) <= r, `step ${i + 1}: ${s.kind} of ${s.questId} out of order`);
    seen.set(s.questId, r);
  });
});

test('no step text reads like a script or macro', () => {
  for (const [i, s] of guide.steps.entries()) {
    assert.doesNotMatch(s.text, /\/run|\/script|macro/i, `step ${i + 1}`);
  }
});
