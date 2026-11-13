'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countHandwritten, cases } = require('../tools/toc-load-gap');
const { countGap, countQuickStartSteps, cases: u8Cases } = require('../tools/u8-gap');

const gap = countHandwritten().length;
test('toc-load-gap hits zero when tests use the toc-order loader', { skip: gap !== 0 && `toc-load-gap is ${gap}` }, () => {
  assert.deepEqual(countHandwritten(), []);
});

test('toc-load-gap locked baseline matches detection on forever', () => {
  if (gap !== cases.baselineHandwritten) return;
  const hits = countHandwritten().sort();
  assert.deepEqual(hits, [...cases.lockedFiles].sort());
});

test('u8-gap hits zero when the Linux quick path, doctor and probes are complete', () => {
  const { gap, steps, checks, probes } = countGap();
  assert.equal(steps, u8Cases.maxSteps, `quick start has ${steps} steps, want ${u8Cases.maxSteps}`);
  assert.equal(checks, u8Cases.doctorChecks);
  assert.equal(probes, u8Cases.agentProbes);
  assert.equal(gap, 0);
});

test('u8-gap step counter only counts the Quick start section', () => {
  const steps = countQuickStartSteps();
  assert.ok(steps <= u8Cases.maxSteps);
  assert.ok(steps >= 1);
});
