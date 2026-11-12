'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countGap, countQuickStartSteps, cases } = require('../tools/u8-gap');

test('u8-gap hits zero when the Linux quick path, doctor and probes are complete', () => {
  const { gap, steps, checks, probes } = countGap();
  assert.equal(steps, cases.maxSteps, `quick start has ${steps} steps, want ${cases.maxSteps}`);
  assert.equal(checks, cases.doctorChecks);
  assert.equal(probes, cases.agentProbes);
  assert.equal(gap, 0);
});

test('u8-gap step counter only counts the Quick start section', () => {
  const steps = countQuickStartSteps();
  assert.ok(steps <= cases.maxSteps);
  assert.ok(steps >= 1);
});
