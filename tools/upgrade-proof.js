#!/usr/bin/env node
'use strict';
// Two-SHA install proof (spec item 87). Runs setup.js in throwaway folders and
// never touches a real client or this checkout's bridge/config.json.
//
//   node tools/upgrade-proof.js [headRef] [oldRef]
//
// Clean install: setup.js from headRef into an empty client.
// Upgrade: setup.js from oldRef (before the rename), sample WoWAI saved data and
// a WoWAI_Nodes folder, then setup.js from headRef over it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const head = process.argv[2] || 'HEAD';
const old = process.argv[3] || 'fdc5d0c';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-proof-'));
const ACCOUNT = 'PROOF';
let failed = 0;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}

// A fresh copy of ref per use, so each run starts without a bridge/config.json.
function extract(ref, name) {
  const sha = run('git', ['rev-parse', ref], { cwd: REPO });
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const tar = path.join(dir, name + '.tar');
  run('git', ['archive', '-o', tar, sha], { cwd: REPO });
  run('tar', ['-xf', path.basename(tar)], { cwd: dir }); // relative: GNU tar reads C: as a host
  return { sha, dir };
}

function client(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'Interface', 'AddOns'), { recursive: true });
  fs.mkdirSync(path.join(root, 'WTF', 'Account', ACCOUNT, 'SavedVariables'), { recursive: true });
  fs.writeFileSync(path.join(root, 'WowClassic.exe'), '');
  return root;
}

function setup(src, root) {
  run(process.execPath, [path.join(src.dir, 'setup.js'), '--wow', root, '--account', ACCOUNT], { cwd: src.dir });
}

function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}

try {
  const H = extract(head, 'head');
  const O = extract(old, 'old');
  console.log(`head ${H.sha}\nold  ${O.sha}`);

  const clean = client('clean');
  setup(H, clean);
  const addons = path.join(clean, 'Interface', 'AddOns');
  check('clean: Interface/AddOns/Runback/Runback.toc', fs.existsSync(path.join(addons, 'Runback', 'Runback.toc')));
  check('clean: no WoWAI folder', !fs.readdirSync(addons).some(n => /^WoWAI/.test(n)));

  const up = client('upgrade');
  setup(O, up);
  const upAddons = path.join(up, 'Interface', 'AddOns');
  const saved = path.join(up, 'WTF', 'Account', ACCOUNT, 'SavedVariables');
  fs.writeFileSync(path.join(saved, 'WoWAI.lua'), 'WoWAIDB = { proof = 1 }\nWoWAIMapDB = { proof = 2 }\n');
  fs.mkdirSync(path.join(upAddons, 'WoWAI_Nodes'));
  fs.writeFileSync(path.join(upAddons, 'WoWAI_Nodes', 'Nodes.lua'), 'nodes\n');
  const before = fs.readdirSync(upAddons).filter(n => /^WoWAI(_S\d{3})?$/.test(n));
  // Updating keeps the checkout and its config.json; only the code changes.
  const H2 = extract(head, 'head-upgrade');
  fs.copyFileSync(path.join(O.dir, 'bridge', 'config.json'), path.join(H2.dir, 'bridge', 'config.json'));
  setup(H2, up);
  const after = fs.readdirSync(upAddons);
  const backup = fs.readdirSync(up).find(n => /^Runback-backup-\d{4}-\d{2}-\d{2}$/.test(n));
  check(`upgrade: ${before.length} old WoWAI folder(s) left Interface/AddOns`, !after.some(n => /^WoWAI(_S\d{3})?$/.test(n)));
  check('upgrade: each old folder is in the dated backup', !!backup && before.every(n => fs.existsSync(path.join(up, backup, n))));
  check('upgrade: Runback.lua present', fs.existsSync(path.join(saved, 'Runback.lua')));
  check('upgrade: WoWAI.lua still on disk', fs.readFileSync(path.join(saved, 'WoWAI.lua'), 'utf8').includes('proof = 1'));
  check('upgrade: WoWAI_Nodes unchanged in place', fs.readFileSync(path.join(upAddons, 'WoWAI_Nodes', 'Nodes.lua'), 'utf8') === 'nodes\n');
  const cfg = JSON.parse(fs.readFileSync(path.join(H2.dir, 'bridge', 'config.json'), 'utf8'));
  check('upgrade: config.json inboxFile and savedVariablesFile name Runback',
    /[\\/]Runback[\\/]Inbox\.lua$/.test(cfg.inboxFile) && /Runback\.lua$/.test(cfg.savedVariablesFile));
} catch (e) {
  console.log('FAIL  ' + e.message);
  failed++;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `UPGRADE PROOF FAIL (${failed})` : 'UPGRADE PROOF PASS');
process.exit(failed ? 1 : 0);
