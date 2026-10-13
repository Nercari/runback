#!/usr/bin/env node
'use strict';
// One-shot installer.
//
//   node setup.js [--wow "<client folder>"] [--project "<default work folder>"] [--account <name>]
//
// Finds the WoW: Forever client, copies the addon into Interface\AddOns, writes
// bridge/config.json from the example (if missing), and builds the slot pool.
// Re-running is safe: existing config and generated files are kept.
//
// An install under an old name is migrated: saved data is copied when
// Runback.lua is absent, and the old addon folders are moved to a dated
// backup outside Interface\AddOns so two addons don't fight over /ai and /r.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const ADDON_SRC = path.join(ROOT, 'addon', 'Runback');
const BRIDGE = path.join(ROOT, 'bridge');
const CONFIG = path.join(BRIDGE, 'config.json');
const EXAMPLE = path.join(BRIDGE, 'config.example.json');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}

function isClient(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Interface')) && fs.readdirSync(dir).some(f => /^Wow.*\.exe$/i.test(f));
  } catch { return false; }
}

function findClient() {
  if (args.wow) {
    if (isClient(args.wow)) return args.wow;
    throw new Error(`--wow "${args.wow}" does not look like a WoW client folder (needs Interface\\ and a Wow*.exe)`);
  }
  const roots = process.platform === 'win32'
    ? [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'D:\\', 'E:\\', 'D:\\Games', 'E:\\Games', 'C:\\Games']
      .filter(Boolean).map(r => path.join(r, 'World of Warcraft'))
    // Linux: the client lives inside a Wine prefix.
    : [process.env.WINEPREFIX, path.join(os.homedir(), '.wine'),
      path.join(os.homedir(), 'Games', 'battlenet')]
      .filter(Boolean).flatMap(p => ['Program Files (x86)', 'Program Files'].map(pf => path.join(p, 'drive_c', pf, 'World of Warcraft')));
  for (const root of roots) {
    for (const flavor of ['_classic_beta_', '_forever_', '_retail_', '_classic_era_', '_classic_']) {
      const dir = path.join(root, flavor);
      if (isClient(dir)) return dir;
    }
  }
  throw new Error('Could not find the WoW client. Pass --wow "C:\\path\\to\\World of Warcraft\\_classic_beta_"');
}

function findAccount(client) {
  const base = path.join(client, 'WTF', 'Account');
  let names = [];
  try { names = fs.readdirSync(base).filter(n => n !== 'SavedVariables' && fs.statSync(path.join(base, n)).isDirectory()); } catch {}
  if (args.account) {
    if (!names.includes(args.account)) throw new Error(`Account "${args.account}" not found under ${base}`);
    return args.account;
  }
  if (!names.length) throw new Error(`No account folder under ${base}. Log into the game once, then run setup again.`);
  if (names.length > 1) console.log(`Several accounts found (${names.join(', ')}); using "${names[0]}". Pass --account to choose another.`);
  return names[0];
}

function backupDir(client, now) {
  const day = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  return path.join(client, 'Runback-backup-' + day);
}

function moveAside(src, backup) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(backup, { recursive: true });
  const base = path.basename(src);
  let dest = path.join(backup, base);
  if (fs.existsSync(dest)) {
    let n = 2;
    while (fs.existsSync(path.join(backup, base + '-' + n))) n++;
    dest = path.join(backup, base + '-' + n);
  }
  fs.renameSync(src, dest);
  return true;
}

function copyWoWAISaved(client) {
  const accounts = path.join(client, 'WTF', 'Account');
  let names = [];
  try { names = fs.readdirSync(accounts); } catch { return 0; }
  let copied = 0;
  for (const name of names) {
    const accountDir = path.join(accounts, name);
    let st;
    try { st = fs.statSync(accountDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const savedDir = path.join(accountDir, 'SavedVariables');
    const oldSaved = path.join(savedDir, 'WoWAI.lua');
    const newSaved = path.join(savedDir, 'Runback.lua');
    if (!fs.existsSync(oldSaved) || fs.existsSync(newSaved)) continue;
    fs.copyFileSync(oldSaved, newSaved);
    copied++;
  }
  if (copied) console.log(`migrate  : copied WoWAI.lua to Runback.lua for ${copied} account(s); WoWAI.lua kept`);
  return copied;
}

function migrateOldInstall(client, account, now = new Date()) {
  const addons = path.join(client, 'Interface', 'AddOns');
  const savedDir = path.join(client, 'WTF', 'Account', account, 'SavedVariables');
  const oldSaved = path.join(savedDir, 'WoWClaude.lua');
  const newSaved = path.join(savedDir, 'Runback.lua');
  if (fs.existsSync(oldSaved) && !fs.existsSync(newSaved)) {
    const src = fs.readFileSync(oldSaved, 'utf8').replace(/^WoWClaudeDB\s*=/m, 'RunbackDB =');
    fs.writeFileSync(newSaved, src);
    console.log(`migrate  : chats and settings copied from ${path.basename(oldSaved)} to ${path.basename(newSaved)}`);
  }
  copyWoWAISaved(client);
  const backup = backupDir(client, now);
  let moved = 0;
  for (const name of fs.existsSync(addons) ? fs.readdirSync(addons) : []) {
    if ((name === 'WoWClaude' || name === 'WoWAI' || /^WoWClaude_S\d{3}$/.test(name)) && moveAside(path.join(addons, name), backup)) moved++;
  }
  if (moved) console.log(`migrate  : moved ${moved} old addon folder(s) to ${backup}`);
  return backup;
}

function copyAddon(client) {
  const dest = path.join(client, 'Interface', 'AddOns', 'Runback');
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(ADDON_SRC)) {
    const target = path.join(dest, f);
    if (f === 'Inbox.lua' && fs.existsSync(target)) continue; // the bridge owns it once running
    fs.copyFileSync(path.join(ADDON_SRC, f), target);
    copied++;
  }
  return { dest, copied };
}

// A config.json from before the rename, or from before agents: fix the paths
// that named the old addon, and move Claude's settings under agents.claude next
// to the codex and grok blocks from the example. Everything else is kept.
function upgradeConfig(cfg, example) {
  const notes = [];
  if (/WoWClaude/.test(cfg.inboxFile || '')) {
    cfg.inboxFile = path.join(cfg.addonDir, 'Runback', 'Inbox.lua');
    notes.push('inboxFile');
  }
  if (/WoWClaude\.lua$/.test(cfg.savedVariablesFile || '')) {
    cfg.savedVariablesFile = cfg.savedVariablesFile.replace(/WoWClaude\.lua$/, 'Runback.lua');
    notes.push('savedVariablesFile');
  }
  if (!cfg.agents) {
    const claude = { ...example.agents.claude };
    if (cfg.claudePath) claude.path = cfg.claudePath;
    if (cfg.model) claude.model = cfg.model;
    if (cfg.permissionMode) claude.permissionMode = cfg.permissionMode;
    if (Array.isArray(cfg.allowedTools)) claude.allowedTools = cfg.allowedTools;
    cfg.agent = cfg.agent || example.agent;
    cfg.agents = { claude, codex: { ...example.agents.codex }, grok: { ...example.agents.grok } };
    for (const k of ['claudePath', 'model', 'permissionMode', 'allowedTools']) delete cfg[k];
    notes.push('agents');
  }
  return notes;
}

function writeConfig(client, account) {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  if (fs.existsSync(CONFIG)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const notes = upgradeConfig(cfg, example);
    if (notes.length) {
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`config   : ${CONFIG} updated (${notes.join(', ')}); everything else kept`);
    } else {
      console.log(`config   : ${CONFIG} already exists, keeping it`);
    }
    return cfg;
  }
  const cfg = example;
  cfg.addonDir = path.join(client, 'Interface', 'AddOns');
  cfg.inboxFile = path.join(cfg.addonDir, 'Runback', 'Inbox.lua');
  cfg.savedVariablesFile = path.join(client, 'WTF', 'Account', account, 'SavedVariables', 'Runback.lua');
  cfg.defaultCwd = args.project ? path.resolve(args.project) : ''; // empty: the bridge uses the mentor workspace
  const exe = fs.readdirSync(client).find(f => /^Wow.*\.exe$/i.test(f));
  if (exe) cfg.capture.processName = exe.replace(/\.exe$/i, '');
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`config   : wrote ${CONFIG}`);
  return cfg;
}

// Which agent CLIs this PC has, so the last lines of setup can say what is missing.
function agentReport(cfg) {
  const A = require(path.join(BRIDGE, 'agents.js'));
  const lines = [];
  for (const id of A.agentIds()) {
    const r = A.resolveCommand(id, A.agentConfig(cfg, id));
    lines.push(`  ${A.AGENTS[id].name.padEnd(7)}: ${r.found ? r.file + (r.args.length ? ' ' + r.args.join(' ') : '') : 'not found (' + A.AGENTS[id].install + ')'}`);
  }
  return lines.join('\n');
}

function main() {
try {
  const client = findClient();
  console.log(`client   : ${client}`);
  const account = findAccount(client);
  console.log(`account  : ${account}`);
  migrateOldInstall(client, account);
  const { dest, copied } = copyAddon(client);
  console.log(`addon    : ${copied} file(s) -> ${dest}`);
  const cfg = writeConfig(client, account);
  console.log(`project  : ${cfg.defaultCwd || 'the mentor workspace'}  (change with /runback cd in game, or defaultCwd in config.json)`);
  console.log(`agent    : ${cfg.agent} by default (change with /runback agent in game, or "agent" in config.json)`);
  console.log(agentReport(cfg));
  console.log('slots    : building the reply-slot pool and signal files...');
  const r = spawnSync(process.execPath, [path.join(BRIDGE, 'install-slots.js')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('install-slots.js failed');
  console.log(`
Done. Next:
  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch).
  2. Enable "Runback" at the character select AddOns screen (the Runback slot ### entries stay enabled).
  3. Start the bridge:  npm start   (in this terminal${process.platform === 'win32' ? '; bridge\\start-window.cmd opens its own window' : '; on Linux keep the game borderless/windowed and check the capture with: npm run probe'})
  4. In game:  /runback
`);
} catch (e) {
  console.error('setup failed:', e.message);
  process.exit(1);
}
}

if (require.main === module) main();

module.exports = { migrateOldInstall };
