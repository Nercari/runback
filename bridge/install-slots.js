#!/usr/bin/env node
'use strict';
// Creates the reply-slot addons and signal files that the no-reload transport needs.
// WoW only indexes addon folders and files at launch, so run this once, then restart
// the game. Safe to re-run: existing files are left alone, except the `## Interface:`
// line of a slot .toc, which follows the TOC number the client now reports.

const fs = require('fs');
const path = require('path');

function install(cfg) {
  const addons = cfg.addonDir;
  const N = cfg.slots || 200;
  const ACT = cfg.actMax || 60;
  const PRESENCE = cfg.presenceMax || 2000;
  const iface = cfg.tocInterface || '16001';

  if (!fs.existsSync(path.join(addons, 'Runback', 'Runback.toc'))) {
    throw new Error('Runback addon not found under ' + addons);
  }

  let made = 0, kept = 0, refreshed = 0;
  function ensure(file, content) {
    if (fs.existsSync(file)) { kept++; return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    made++;
  }
  // A slot .toc made for an older client marks every slot addon out of date.
  function ensureToc(file, content) {
    if (!fs.existsSync(file)) { ensure(file, content); return; }
    kept++;
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(/^## Interface:.*$/m, '## Interface: ' + iface);
    if (next !== text) {
      fs.writeFileSync(file, next);
      refreshed++;
    }
  }

  for (let i = 1; i <= N; i++) {
    const name = 'Runback_S' + String(i).padStart(3, '0');
    const dir = path.join(addons, name);
    ensureToc(path.join(dir, name + '.toc'), [
      '## Interface: ' + iface,
      '## Title: Runback slot ' + String(i).padStart(3, '0'),
      '## Notes: Reply slot for Runback. Load-on-demand; leave it enabled.',
      '## LoadOnDemand: 1',
      '## Dependencies: Runback',
      '',
      'Inbox.lua',
      '',
    ].join('\n'));
    ensure(path.join(dir, 'Inbox.lua'), 'Runback_SlotData = nil\n');
    ensure(path.join(addons, 'Runback', 'sig', String(i).padStart(3, '0') + '.wav'), '');
    ensure(path.join(addons, 'Runback', 'ack', String(i).padStart(3, '0') + '.wav'), '');
    // Heartbeat files: one per agent action, flipped valid by the bridge as it works.
    for (let k = 1; k <= ACT; k++) {
      ensure(path.join(addons, 'Runback', 'act', String(i).padStart(3, '0'), String(k).padStart(2, '0') + '.wav'), '');
    }
  }

  // Presence files: the bridge flips one every 30 s so the game can show "connected".
  for (let k = 1; k <= PRESENCE; k++) {
    ensure(path.join(addons, 'Runback', 'presence', String(k).padStart(4, '0') + '.wav'), '');
  }

  // Control files for the addon's self-test: one always empty, one always valid.
  ensure(path.join(addons, 'Runback', 'ctl', 'empty.wav'), '');
  ensure(path.join(addons, 'Runback', 'ctl', 'valid.wav'), require('./protocol').SILENT_WAV);

  return { slots: N, made, kept, refreshed };
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  let r;
  try {
    r = install(cfg);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log(`slots: ${r.slots}  files created: ${r.made}  already present: ${r.kept}  interface refreshed: ${r.refreshed}`);
  if (r.made > 0) console.log('Now fully quit and relaunch WoW so it sees the new files.');
}

if (require.main === module) main();

module.exports = { install };
