'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrateOldInstall, backupName, upgradeConfig, findClient, repairClientPaths } = require('../../setup');
const { install } = require('../../bridge/install-slots');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge', 'config.example.json'), 'utf8'));

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

test('the WoWAI addon and its slot folders move to that backup and WoWAI_Nodes stays', (t) => {
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
  assert.equal(fs.existsSync(path.join(addons, 'WoWAI_S001')), false);
  assert.equal(fs.readFileSync(path.join(backup, 'WoWAI_S001', 'slot.txt'), 'utf8'), 'leave-slot');
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

test('a config written for WoWAI points at Runback after setup', () => {
  const addonDir = path.join('C:', 'WoW', 'Interface', 'AddOns');
  const cfg = {
    addonDir,
    inboxFile: path.join(addonDir, 'WoWAI', 'Inbox.lua'),
    savedVariablesFile: path.join('C:', 'WoW', 'WTF', 'Account', 'A', 'SavedVariables', 'WoWAI.lua'),
    agents: {},
  };
  const notes = upgradeConfig(cfg, {});
  assert.deepEqual(notes, ['inboxFile', 'savedVariablesFile']);
  assert.equal(cfg.inboxFile, path.join(addonDir, 'Runback', 'Inbox.lua'));
  assert.equal(path.basename(cfg.savedVariablesFile), 'Runback.lua');
  const nodes = { addonDir, inboxFile: path.join(addonDir, 'WoWAI_Nodes', 'x.lua'), agents: {} };
  assert.deepEqual(upgradeConfig(nodes, {}), []);
});

// Launch day renames the client folder to `_forever_` and bumps `## Interface`.
// These checks run in temporary folders and never touch bridge/config.json.
function flavor(root, name) {
  const dir = path.join(root, name);
  write(dir, path.join('Interface', 'AddOns', 'Runback', 'Runback.toc'), '## Interface: 16001\n');
  write(dir, 'Wow.exe', '');
  return dir;
}

test('setup finds a temp game folder named _forever_', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forever = flavor(root, '_forever_');
  assert.equal(findClient('', [root]), forever);
  // Both folders on disk: launch day wins over the beta.
  flavor(root, '_classic_beta_');
  assert.equal(findClient('', [root]), forever);
  // Beta names keep working when that is what is installed.
  const betaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(betaRoot, { recursive: true, force: true }));
  const beta = flavor(betaRoot, '_classic_beta_');
  assert.equal(findClient('', [betaRoot]), beta);
});

test('setup accepts a macOS client folder, which has an .app and no Wow.exe (issue 145)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '_forever_');
  write(dir, path.join('Interface', 'AddOns', 'Runback', 'Runback.toc'), '## Interface: 16001\n');
  fs.mkdirSync(path.join(dir, 'World of Warcraft.app'));
  assert.equal(findClient(dir), dir);
  assert.equal(findClient('', [root]), dir);
});

test('a Forever folder on another drive beats retail in the first root', (t) => {  const retailRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(retailRoot, { recursive: true, force: true }));
  const gamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(gamesRoot, { recursive: true, force: true }));
  flavor(retailRoot, '_retail_');
  const forever = flavor(gamesRoot, '_forever_');
  assert.equal(findClient('', [retailRoot, gamesRoot]), forever);
});

test('a working Forever config is not repointed at a retail install', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retail = flavor(root, '_retail_');
  const forever = path.join('F:', 'WoW', '_forever_');
  const cfg = {
    addonDir: path.join(forever, 'Interface', 'AddOns'),
    inboxFile: path.join(forever, 'Interface', 'AddOns', 'Runback', 'Inbox.lua'),
    savedVariablesFile: path.join(forever, 'WTF', 'Account', 'Alpha', 'SavedVariables', 'Runback.lua'),
    tocInterface: '17000',
    capture: { processName: 'WowB' },
  };
  assert.deepEqual(repairClientPaths(cfg, retail, 'Alpha', { tocInterface: '17000' }), []);
  assert.equal(cfg.addonDir, path.join(forever, 'Interface', 'AddOns'));
  assert.equal(cfg.tocInterface, '17000');
  assert.equal(cfg.capture.processName, 'WowB');
});

test('the Interface number only goes up, so a newer config value is kept', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = flavor(root, '_forever_');
  const cfg = { tocInterface: '17000' };
  assert.deepEqual(repairClientPaths(cfg, client, 'Alpha', { tocInterface: '16001' }), ['addonDir', 'inboxFile', 'savedVariablesFile', 'capture.processName']);
  assert.equal(cfg.tocInterface, '17000');
});

test('an existing config follows the folder setup found, with no edit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = flavor(path.join(root, 'World of Warcraft'), '_forever_');
  const beta = path.join(root, 'World of Warcraft', '_classic_beta_');
  const account = 'Alpha';
  const cfg = {
    addonDir: path.join(beta, 'Interface', 'AddOns'),
    inboxFile: path.join(beta, 'Interface', 'AddOns', 'Runback', 'Inbox.lua'),
    savedVariablesFile: path.join(beta, 'WTF', 'Account', account, 'SavedVariables', 'Runback.lua'),
    tocInterface: '16001',
    defaultCwd: '/keep/me',
    capture: { processName: 'WowB' },
  };
  const notes = repairClientPaths(cfg, client, 'Other', { tocInterface: '17000' });
  assert.deepEqual(notes.sort(), ['addonDir', 'capture.processName', 'inboxFile', 'savedVariablesFile', 'tocInterface']);
  assert.equal(cfg.addonDir, path.join(client, 'Interface', 'AddOns'));
  assert.equal(cfg.inboxFile, path.join(client, 'Interface', 'AddOns', 'Runback', 'Inbox.lua'));
  // The account the player already used is kept, not the first account found.
  assert.equal(cfg.savedVariablesFile, path.join(client, 'WTF', 'Account', account, 'SavedVariables', 'Runback.lua'));
  assert.equal(cfg.tocInterface, '17000');
  assert.equal(cfg.capture.processName, 'Wow');
  assert.equal(cfg.defaultCwd, '/keep/me');

  assert.deepEqual(repairClientPaths(cfg, client, 'Other', { tocInterface: '17000' }), []);
});

test('install rewrites the old ## Interface number in the slot tocs', (t) => {
  const addons = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-slots-'));
  t.after(() => fs.rmSync(addons, { recursive: true, force: true }));
  write(addons, path.join('Runback', 'Runback.toc'), '## Interface: 16001\n');
  for (const n of ['001', '002']) {
    write(addons, path.join('Runback_S' + n, 'Runback_S' + n + '.toc'), [
      '## Interface: 16001',
      '## Title: Runback slot ' + n,
      '## LoadOnDemand: 1',
      '',
      'Inbox.lua',
      '',
    ].join('\n'));
    write(addons, path.join('Runback_S' + n, 'Inbox.lua'), 'player data ' + n + '\n');
  }
  const cfg = { addonDir: addons, slots: 3, actMax: 1, presenceMax: 1, tocInterface: '17000' };
  const first = install(cfg);
  assert.equal(first.slots, 3);
  assert.equal(first.refreshed, 2);
  for (const n of ['001', '002', '003']) {
    const toc = fs.readFileSync(path.join(addons, 'Runback_S' + n, 'Runback_S' + n + '.toc'), 'utf8');
    assert.match(toc, /^## Interface: 17000$/m);
    assert.match(toc, new RegExp('^## Title: Runback slot ' + n + '$', 'm'));
  }
  assert.equal(fs.readFileSync(path.join(addons, 'Runback_S001', 'Inbox.lua'), 'utf8'), 'player data 001\n');

  const again = install(cfg);
  assert.equal(again.refreshed, 0);
  assert.equal(again.made, 0);
});

test('the addon TOC and the shipped slot TOC number agree', () => {
  const toc = fs.readFileSync(path.join(ROOT, 'addon', 'Runback', 'Runback.toc'), 'utf8');
  const m = /^## Interface:\s*(\d+)/m.exec(toc);
  assert.ok(m, 'Runback.toc has an ## Interface line');
  assert.equal(m[1], String(EXAMPLE.tocInterface));
});
