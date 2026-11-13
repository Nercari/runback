#!/usr/bin/env node
'use strict';
// Unit 8 score: (Linux install steps over 6) + (8 − doctor checks) + (6 − agent probes).
// Locked baselines in tools/u8-gap-cases.json.

const fs = require('node:fs');
const path = require('node:path');
const cases = require('./u8-gap-cases.json');

const ROOT = path.join(__dirname, '..');

function countQuickStartSteps(docRel = cases.installDoc) {
  const file = path.join(ROOT, docRel);
  if (!fs.existsSync(file)) return cases.baselineSteps;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let inSection = false;
  let steps = 0;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) break;
      if (line.trim() === cases.quickStartHeading) inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^\d+\.\s/.test(line)) steps += 1;
  }
  if (!inSection || steps === 0) return cases.baselineSteps;
  return steps;
}

function loadDoctor() {
  const p = path.join(ROOT, 'tools', 'doctor.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

function countGap() {
  const steps = countQuickStartSteps();
  const stepGap = Math.max(0, steps - cases.maxSteps);

  const D = loadDoctor();
  const checks = typeof D.checkCount === 'function' ? D.checkCount() : cases.baselineDoctorChecks;
  const doctorGap = Math.max(0, cases.doctorChecks - checks);

  const probes = Array.isArray(D.LOGIN_PROBES) ? D.LOGIN_PROBES.length : cases.baselineAgentProbes;
  const agentGap = Math.max(0, cases.agentProbes - probes);

  return { gap: stepGap + doctorGap + agentGap, steps, checks, probes, stepGap, doctorGap, agentGap };
}

function main() {
  const { gap, steps, checks, probes, stepGap, doctorGap, agentGap } = countGap();
  console.error(`u8-gap: steps=${steps} checks=${checks} probes=${probes}`);
  console.error(`  step gap ${stepGap}, doctor gap ${doctorGap}, agent gap ${agentGap}`);
  console.log(`u8-gap: ${gap}`);
  console.log(gap);
  process.exit(gap === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { countGap, countQuickStartSteps, cases };
