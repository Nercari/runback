'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrateOldInstall, backupName } = require('../../setup');

const NOW = new Date('2026-10-13T15:00:00Z');
const LEGACY = [
  'WoWAIDB = { marker = 1 }',
  'WoWAIMapDB = { marker = 2 }',
  'WoWAIGuideDB = { marker = 3 }',
  'WoWAIForeverDB = { marker = 4 }',
  'WoWAI_Bulk = { marker = 5 }',
].join('\n') + '\n';

function client(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Interface', 'AddOns'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Wow.exe'), '');
  return root;
}

function write(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

function migrate(root) {
  return migrateOldInstall(root, 'Alpha', NOW);
}

test('WoWClaude addon folders move to a dated backup outside Interface/AddOns', (t) => {
  const root = client(t);
  write(root, path.join('Interface', 'AddOns', 'WoWClaude', 'marker.txt'), 'user-data');
  write(root, path.join('Interface', 'AddOns', 'WoWClaude_S001', 'slot.txt'), 'slot-data');
  write(root, path.join('Interface', 'AddOns', 'Runback', 'Runback.toc'), 'stay');
  const backup = migrate(root);
  const addons = path.join(root, 'Interface', 'AddOns');
  assert.equal(path.basename(backup), 'Runback-backup-2026-10-13');
  assert.ok(path.relative(addons, backup).startsWith('..'));
  assert.equal(fs.existsSync(path.join(addons, 'WoWClaude')), false);
  assert.equal(fs.existsSync(path.join(addons, 'WoWClaude_S001')), false);
  assert.equal(fs.readFileSync(path.join(backup, 'WoWClaude', 'marker.txt'), 'utf8'), 'user-data');
  assert.equal(fs.readFileSync(path.join(backup, 'WoWClaude_S001', 'slot.txt'), 'utf8'), 'slot-data');
  assert.equal(fs.readFileSync(path.join(addons, 'Runback', 'Runback.toc'), 'utf8'), 'stay');
});

test('each account WoWAI.lua is copied to Runback.lua only when Runback.lua is absent', (t) => {
  const root = client(t);
  for (const account of ['Alpha', 'Beta']) {
    write(root, path.join('WTF', 'Account', account, 'SavedVariables', 'WoWAI.lua'), LEGACY);
  }
  write(root, path.join('WTF', 'Account', 'Gamma', 'SavedVariables', 'WoWAI.lua'), LEGACY);
  write(root, path.join('WTF', 'Account', 'Gamma', 'SavedVariables', 'Runback.lua'), 'KEEP\n');
  migrate(root);
  for (const account of ['Alpha', 'Beta']) {
    const dir = path.join(root, 'WTF', 'Account', account, 'SavedVariables');
    assert.equal(fs.readFileSync(path.join(dir, 'Runback.lua'), 'utf8'), LEGACY);
    assert.equal(fs.readFileSync(path.join(dir, 'WoWAI.lua'), 'utf8'), LEGACY);
    assert.match(fs.readFileSync(path.join(dir, 'Runback.lua'), 'utf8'), /WoWAIDB/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'Runback.lua'), 'utf8'), /^RunbackDB\s*=/m);
  }
  const gamma = path.join(root, 'WTF', 'Account', 'Gamma', 'SavedVariables');
  assert.equal(fs.readFileSync(path.join(gamma, 'Runback.lua'), 'utf8'), 'KEEP\n');
  assert.equal(fs.readFileSync(path.join(gamma, 'WoWAI.lua'), 'utf8'), LEGACY);
});

test('the WoWAI addon folder moves to that backup and WoWAI_Nodes stays', (t) => {
  const root = client(t);
  write(root, path.join('Interface', 'AddOns', 'WoWClaude', 'marker.txt'), 'claude');
  write(root, path.join('Interface', 'AddOns', 'WoWAI', 'WoWAI.toc'), '## Title: WoW AI\n');
  write(root, path.join('Interface', 'AddOns', 'WoWAI_Nodes', 'Nodes.lua'), 'nodes\n');
  write(root, path.join('Interface', 'AddOns', 'WoWAI_S001', 'slot.txt'), 'leave-slot');
  const backup = migrate(root);
  const addons = path.join(root, 'Interface', 'AddOns');
  assert.equal(fs.existsSync(path.join(addons, 'WoWAI')), false);
  assert.equal(fs.readFileSync(path.join(backup, 'WoWAI', 'WoWAI.toc'), 'utf8'), '## Title: WoW AI\n');
  assert.equal(fs.readFileSync(path.join(backup, 'WoWClaude', 'marker.txt'), 'utf8'), 'claude');
  assert.equal(fs.readFileSync(path.join(addons, 'WoWAI_Nodes', 'Nodes.lua'), 'utf8'), 'nodes\n');
  assert.equal(fs.readFileSync(path.join(addons, 'WoWAI_S001', 'slot.txt'), 'utf8'), 'leave-slot');
});

test('backup folder date uses the local calendar day', (t) => {
  const when = new Date('2026-10-14T00:30:00Z');
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  assert.equal(backupName(when), `Runback-backup-${when.getFullYear()}-${month}-${day}`);

  const root = client(t);
  write(root, path.join('Interface', 'AddOns', 'WoWClaude', 'marker.txt'), 'user-data');
  const setup = path.join(__dirname, '..', '..', 'setup.js');
  const script = `
    const path = require('path');
    const { migrateOldInstall } = require(${JSON.stringify(setup)});
    const when = new Date('2026-10-14T00:30:00Z');
    const month = String(when.getMonth() + 1).padStart(2, '0');
    const day = String(when.getDate()).padStart(2, '0');
    const local = 'Runback-backup-' + when.getFullYear() + '-' + month + '-' + day;
    const backup = migrateOldInstall(${JSON.stringify(root)}, 'Alpha', when);
    if (path.basename(backup) !== local) {
      console.error('got ' + path.basename(backup) + ' want ' + local);
      process.exit(1);
    }
    if (local === 'Runback-backup-2026-10-14') process.exit(2);
    if (require('fs').readFileSync(path.join(backup, 'WoWClaude', 'marker.txt'), 'utf8') !== 'user-data') process.exit(3);
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/Sao_Paulo' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
