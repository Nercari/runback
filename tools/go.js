#!/usr/bin/env node
'use strict';
// Linux: npm run go — update, setup, doctor, start the supervisor.
//
//   node tools/go.js [--no-update]

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { update } = require('./launch');
const { linuxBridgeRunning } = require('./doctor');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'bridge');

function runNode(script, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 600000,
    env: opts.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out, code: r.status ?? 1 };
}

function startSupervisor(bridgeDir = BRIDGE) {
  const sup = path.join(bridgeDir, 'supervisor.js');
  const child = spawn(process.execPath, [sup, '--on'], {
    cwd: bridgeDir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function go({ root = ROOT, argv = [], platform = process.platform, updater = update, runner = runNode,
  bridgeRunning = linuxBridgeRunning, start = startSupervisor } = {}) {
  if (platform !== 'linux') {
    return { ok: false, code: 1, lines: ['npm run go is for Linux; on Windows use Runback.cmd'] };
  }
  const lines = ['Runback (Linux)', ''];
  const skipUpdate = argv.includes('--no-update');
  const up = skipUpdate ? { changed: false, note: 'skipped (--no-update)' } : updater(root);
  lines.push(`update : ${up.note}`);

  const setup = runner(path.join(root, 'setup.js'));
  if (!setup.ok) {
    lines.push(setup.out.trim() || 'setup failed');
    return { ok: false, code: 1, lines };
  }

  const doc = runner(path.join(root, 'tools', 'doctor.js'), ['--pre-start']);
  if (doc.out.trim()) lines.push(doc.out.trimEnd());
  if (doc.code !== 0) {
    lines.push('');
    lines.push('Doctor reported failures; fix them, then run npm run go again.');
    return { ok: false, code: doc.code || 1, lines };
  }

  if (bridgeRunning()) lines.push('bridge : already running');
  else {
    start();
    lines.push('bridge : started supervisor (npm start); stop it from that terminal with Ctrl+C');
  }
  return { ok: true, code: 0, lines };
}

function main(argv) {
  const result = go({ argv });
  for (const line of result.lines) console.log(line);
  process.exit(result.code);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { go, runNode, startSupervisor };
