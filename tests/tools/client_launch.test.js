'use strict';
// Launch day renames the client folder to `_forever_` and bumps `## Interface`.
// These checks run in temporary folders and never touch bridge/config.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findClient, repairClientPaths } = require('../../setup');
const { install } = require('../../bridge/install-slots');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge', 'config.example.json'), 'utf8'));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function flavor(root, name) {
  const dir = path.join(root, name);
  write(path.join(dir, 'Interface', 'AddOns', 'Runback', 'Runback.toc'), '## Interface: 16001\n');
  write(path.join(dir, 'Wow.exe'), '');
  return dir;
}

test('setup finds a temp game folder named _forever_', (t) => {
  const root = tmp(t);
  const forever = flavor(root, '_forever_');
  assert.equal(findClient('', [root]), forever);
  // Both folders on disk: launch day wins over the beta.
  flavor(root, '_classic_beta_');
  assert.equal(findClient('', [root]), forever);
  // Beta names keep working when that is what is installed.
  const betaRoot = tmp(t);
  const beta = flavor(betaRoot, '_classic_beta_');
  assert.equal(findClient('', [betaRoot]), beta);
});

test('an existing config follows the folder setup found, with no edit', (t) => {
  const root = tmp(t);
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
  const addons = tmp(t);
  write(path.join(addons, 'Runback', 'Runback.toc'), '## Interface: 16001\n');
  for (const n of ['001', '002']) {
    write(path.join(addons, 'Runback_S' + n, 'Runback_S' + n + '.toc'), [
      '## Interface: 16001',
      '## Title: Runback slot ' + n,
      '## LoadOnDemand: 1',
      '',
      'Inbox.lua',
      '',
    ].join('\n'));
    write(path.join(addons, 'Runback_S' + n, 'Inbox.lua'), 'player data ' + n + '\n');
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
