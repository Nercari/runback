#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const LOGIN_PROBES = [
  ['claude', ['auth', 'status']],
  ['codex', ['login', 'status']],
  ['grok', ['-p', '0', '--print-timeout', '2s', '--output-format', 'text'], 'grok-headless'],
  ['agy', ['-p', '0', '--print-timeout', '2s', '--output-format', 'text'], 'agy-headless'],
  ['hermes', ['auth', 'list'], 'hermes-list'],
  ['opencode', ['auth', 'list'], 'opencode-list'],
];

const CHECK_ORDER = ['node', 'python3', 'login', 'x11', 'client', 'slots', 'bridge', 'combatlog'];

function nodeNewer(version) {
  const match = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(String(version).trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 2);
}

function nodeCheck(version) {
  const shown = String(version).trim().replace(/^v/, '');
  if (nodeNewer(version)) return { name: 'node', status: 'PASS', detail: `Node.js ${shown}` };
  return {
    name: 'node',
    status: 'FAIL',
    detail: `Node.js ${shown} is older than 22.2.`,
    fix: 'Install Node.js 22.2 or newer from https://nodejs.org.',
  };
}

function pythonCheck(platform, pythonProbe) {
  if (platform !== 'linux') {
    return { name: 'python3', status: 'PASS', detail: 'Linux capture only; python3 is not checked here' };
  }
  const r = pythonProbe();
  if (r.ok) return { name: 'python3', status: 'PASS', detail: r.version };
  return {
    name: 'python3',
    status: 'FAIL',
    detail: 'python3 is missing or too old for bridge/capture_x11.py.',
    fix: 'Install python3 (on Arch: sudo pacman -S python).',
  };
}

function loginProbeText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function hermesListLoggedIn(text) {
  return [...text.matchAll(/\((\d+)\s+credentials?\)/gi)].some((m) => Number(m[1]) > 0);
}

function isLoggedIn(entry, result) {
  if (!result || result.error) return false;
  const kind = Array.isArray(entry) ? (entry[2] || 'default') : 'default';
  const text = loginProbeText(result);

  if (kind === 'hermes-list') {
    if (result.status !== 0) return false;
    return hermesListLoggedIn(text);
  }
  if (kind === 'opencode-list') {
    if (result.status !== 0) return false;
    if (/no authenticated integrations/i.test(text)) return false;
    if (text.trim() === '[]') return false;
    return true;
  }
  if (kind === 'agy-headless' || kind === 'grok-headless') {
    if (/authentication required|not signed in|not logged in/i.test(text)) return false;
    if (result.status === 0) return true;
    return false;
  }
  if (result.status !== 0) return false;
  if (/not logged in|login required|please log in|not authenticated|not signed in|"loggedIn"\s*:\s*false/i.test(text)) return false;
  return true;
}

function loginCheck(probe) {
  const results = probe();
  const logged = LOGIN_PROBES.filter((entry, i) => isLoggedIn(entry, results[i])).map(([id]) => id);
  if (logged.length) {
    return {
      name: 'login',
      status: 'PASS',
      detail: `${logged.length} of ${LOGIN_PROBES.length} agent CLIs logged in (${logged.join(', ')})`,
    };
  }
  return {
    name: 'login',
    status: 'FAIL',
    detail: 'no agent CLI is logged in.',
    fix: 'Log in once in a terminal (see docs/AGENTS.md: claude, codex, grok login, agy, hermes setup, opencode auth login).',
  };
}

// A Wayland session has DISPLAY set (XWayland) and still cannot be counted on to
// hand back another window's pixels, so it fails here instead of passing on DISPLAY.
function x11Check(env, platform) {
  if (platform === 'win32') return { name: 'x11', status: 'PASS', detail: 'Windows does not need X11 for capture' };
  if (platform === 'darwin') return { name: 'x11', status: 'PASS', detail: 'macOS captures with screencapture, not X11' };
  const session = String(env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  const display = String(env.DISPLAY || '').trim();
  if (String(env.WAYLAND_DISPLAY || '').trim() || session === 'wayland') {
    const where = display ? `DISPLAY=${display} is XWayland` : 'DISPLAY is not set';
    return {
      name: 'x11',
      status: 'FAIL',
      detail: `XDG_SESSION_TYPE=${session || 'unset'}, ${where}: capture needs an X11 session.`,
      fix: 'Log out and pick an X11 session at the login screen (docs/INSTALL-LINUX.md, "No X11 session yet").',
    };
  }
  if (display) return { name: 'x11', status: 'PASS', detail: `DISPLAY=${display}` };
  return {
    name: 'x11',
    status: 'FAIL',
    detail: 'DISPLAY is not set.',
    fix: 'Start an X11 session (docs/INSTALL-LINUX.md, "No X11 session yet").',
  };
}

// Which client folder setup found, and the TOC number inside the addon there.
function clientCheck(client) {
  if (!client || !client.dir) {
    return {
      name: 'client',
      status: 'FAIL',
      detail: 'no WoW client folder was found.',
      fix: 'Run node setup.js, or pass --wow "<client folder>" to it.',
    };
  }
  if (!client.interface) {
    return {
      name: 'client',
      status: 'FAIL',
      detail: `the Runback addon is not installed under ${client.dir}.`,
      fix: 'Run node setup.js to install it.',
    };
  }
  return { name: 'client', status: 'PASS', detail: `${client.dir} (Interface ${client.interface})` };
}

function slotsCheck(client) {
  if (client && client.slots === true) {
    return { name: 'slots', status: 'PASS', detail: 'reply slots are installed' };
  }
  if (!client || !client.dir) {
    return {
      name: 'slots',
      status: 'FAIL',
      detail: 'no client folder to check slots in.',
      fix: 'Run node setup.js first.',
    };
  }
  const toc = path.join(client.dir, 'Interface', 'AddOns', 'Runback_S001', 'Runback_S001.toc');
  if (fs.existsSync(toc)) return { name: 'slots', status: 'PASS', detail: 'reply slots are installed' };
  return {
    name: 'slots',
    status: 'FAIL',
    detail: 'Runback_S001 is missing under the client folder.',
    fix: 'Run node setup.js or npm run slots, then fully restart the game.',
  };
}

function bridgeCheck(platform, bridgeRunning, preStart) {
  if (platform !== 'linux') {
    return { name: 'bridge', status: 'PASS', detail: 'bridge process check is for Linux sessions' };
  }
  if (bridgeRunning()) {
    return { name: 'bridge', status: 'PASS', detail: 'supervisor is running' };
  }
  if (preStart) {
    return { name: 'bridge', status: 'PASS', detail: 'supervisor not running yet; npm run go will start it' };
  }
  return {
    name: 'bridge',
    status: 'FAIL',
    detail: 'the bridge supervisor is not running.',
    fix: 'Start it with npm run go or npm start in this repo.',
  };
}

// Combat logging is read-only from the host: a log file means the player turned it on.
function combatlogCheck(client, combatLogState, preStart) {
  const state = typeof combatLogState === 'function' ? combatLogState(client) : combatLogState;
  if (state === 'on') return { name: 'combatlog', status: 'PASS', detail: 'a WoW combat log file is present' };
  const advisory = {
    name: 'combatlog',
    status: 'PASS',
    detail: 'enable combat logging in game before reviews (INSTALL-LINUX.md step 5)',
  };
  if (preStart) return advisory;
  if (state === 'off') {
    return {
      name: 'combatlog',
      status: 'FAIL',
      detail: 'no combat log file was found under the client.',
      fix: 'Turn on combat logging in game (INSTALL-LINUX.md step 5), fight once, then run doctor again.',
    };
  }
  return advisory;
}

function formatCheck(check) {
  if (check.status === 'PASS') return `PASS ${check.name}: ${check.detail}`;
  return `FAIL ${check.name}: ${check.detail} ${check.fix}`;
}

function buildChecks(opts) {
  return [
    nodeCheck(opts.nodeVersion),
    pythonCheck(opts.platform, opts.pythonProbe),
    loginCheck(opts.probe),
    x11Check(opts.env || {}, opts.platform),
    clientCheck(opts.client),
    slotsCheck(opts.client),
    bridgeCheck(opts.platform, opts.bridgeRunning, opts.preStart),
    combatlogCheck(opts.client, opts.combatLogState, opts.preStart),
  ];
}

function checkCount() {
  return CHECK_ORDER.length;
}

function run(opts) {
  const checks = buildChecks(opts);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  const ordered = CHECK_ORDER.map((n) => byName[n]);
  const lines = ordered.map(formatCheck);
  const code = ordered.every((check) => check.status === 'PASS') ? 0 : 1;
  return { code, text: `${lines.join('\n')}\n`, checks: ordered };
}

function realPythonProbe() {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: !r.error && r.status === 0 && /^Python 3\./.test(text), version: text || 'python3' };
}

function realProbe(env) {
  return LOGIN_PROBES.map(([cmd, args]) => {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 5000,
      env,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error ? (result.error.code || 'error') : '',
    };
  });
}

function combatLogOnDisk(client) {
  if (!client || !client.dir) return 'unknown';
  const logs = path.join(client.dir, 'Logs');
  try {
    const names = fs.readdirSync(logs);
    if (names.some((n) => /^WoWCombatLog/i.test(n))) return 'on';
    if (fs.existsSync(logs)) return 'off';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

function supervisorPidFile(bridgeDir = path.join(__dirname, '..', 'bridge')) {
  return path.join(bridgeDir, 'supervisor.pid');
}

function repoRootFromBridge(bridgeDir) {
  return path.resolve(path.join(bridgeDir, '..'));
}

function pidAlive(pid, killer = process.kill) {
  if (!pid) return false;
  try {
    killer(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearSupervisorPidFile(bridgeDir = path.join(__dirname, '..', 'bridge')) {
  try { fs.unlinkSync(supervisorPidFile(bridgeDir)); } catch {}
}

function writeSupervisorPidFile(bridgeDir, pid) {
  if (!pid) return;
  fs.writeFileSync(supervisorPidFile(bridgeDir), `${pid}\n`);
}

function readSupervisorPid(bridgeDir = path.join(__dirname, '..', 'bridge'), alive = pidAlive) {
  let text = '';
  try { text = fs.readFileSync(supervisorPidFile(bridgeDir), 'utf8'); } catch {
    return 0;
  }
  const pid = Number(String(text).trim());
  if (!pid) {
    clearSupervisorPidFile(bridgeDir);
    return 0;
  }
  if (!alive(pid)) {
    clearSupervisorPidFile(bridgeDir);
    return 0;
  }
  return pid;
}

function listSupervisorPids(bridgeDir = path.join(__dirname, '..', 'bridge'), alive = pidAlive) {
  const pid = readSupervisorPid(bridgeDir, alive);
  return pid ? [pid] : [];
}

function linuxBridgeRunning(bridgeDir = path.join(__dirname, '..', 'bridge'), alive = pidAlive) {
  return listSupervisorPids(bridgeDir, alive).length > 0;
}

function stopLinuxSupervisor(bridgeDir = path.join(__dirname, '..', 'bridge'), killer = spawnSync, alive = pidAlive) {
  const pid = readSupervisorPid(bridgeDir, alive);
  if (!pid) return;
  killer('kill', ['-TERM', `-${pid}`], { encoding: 'utf8' });
  if (alive(pid)) killer('kill', ['-TERM', String(pid)], { encoding: 'utf8' });
  clearSupervisorPidFile(bridgeDir);
}

// Legacy export for older call sites that matched pgrep patterns.
function supervisorPgrepPatterns(bridgeDir = path.join(__dirname, '..', 'bridge')) {
  const sup = path.join(bridgeDir, 'supervisor.js');
  return [sup, path.join('bridge', 'supervisor.js')];
}

function readProcCwd(pid) {
  try {
    return fs.realpathSync(path.join('/proc', String(pid), 'cwd'));
  } catch {
    return '';
  }
}

function bridgeCodeChanged(files = []) {
  return files.some((f) => f.startsWith('bridge/') || f.startsWith('mentor/') || f === 'package.json');
}

function tocNumber(clientDir) {
  try {
    const text = fs.readFileSync(path.join(clientDir, 'Interface', 'AddOns', 'Runback', 'Runback.toc'), 'utf8');
    const m = /^## Interface:\s*(\d+)/m.exec(text);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// The configured client folder wins; a fresh machine with no config gets the
// same folder search setup.js does, so both name the same folder.
function findClientInfo(configFile = path.join(__dirname, '..', 'bridge', 'config.json')) {
  let dir = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (cfg.addonDir) dir = path.resolve(cfg.addonDir, '..', '..');
  } catch {}
  if (!dir || !fs.existsSync(dir)) {
    try {
      dir = require('../setup').findClient();
    } catch {
      return null;
    }
  }
  return { dir, interface: tocNumber(dir) };
}

function main(argv = process.argv.slice(2)) {
  const preStart = argv.includes('--pre-start');
  const out = run({
    nodeVersion: process.versions.node,
    platform: process.platform,
    env: process.env,
    probe: () => realProbe(process.env),
    pythonProbe: realPythonProbe,
    bridgeRunning: () => linuxBridgeRunning(),
    combatLogState: combatLogOnDisk,
    client: findClientInfo(),
    preStart,
  });
  process.stdout.write(out.text);
  process.exit(out.code);
}

module.exports = {
  run,
  findClientInfo,
  tocNumber,
  LOGIN_PROBES,
  CHECK_ORDER,
  checkCount,
  buildChecks,
  isLoggedIn,
  hermesListLoggedIn,
  combatLogOnDisk,
  linuxBridgeRunning,
  stopLinuxSupervisor,
  bridgeCodeChanged,
  supervisorPgrepPatterns,
  supervisorPidFile,
  writeSupervisorPidFile,
  readSupervisorPid,
  pidAlive,
  clearSupervisorPidFile,
  listSupervisorPids,
  repoRootFromBridge,
  readProcCwd,
  realPythonProbe,
};

if (require.main === module) main();
