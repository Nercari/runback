#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const LOGIN_PROBES = [
  ['claude', ['auth', 'status']],
  ['codex', ['login', 'status']],
  ['grok', ['auth', 'status']],
];

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

function isLoggedIn(result) {
  if (!result || result.error || result.status !== 0) return false;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/not logged in|login required|please log in|not authenticated|"loggedIn"\s*:\s*false/i.test(text)) return false;
  return true;
}

function loginCheck(probe) {
  if (probe().some(isLoggedIn)) return { name: 'login', status: 'PASS', detail: 'an agent CLI is logged in' };
  return {
    name: 'login',
    status: 'FAIL',
    detail: 'no agent CLI is logged in.',
    fix: 'Log in once in a terminal with claude, codex, or grok login.',
  };
}

function x11Check(env, platform) {
  if (platform === 'win32') return { name: 'x11', status: 'PASS', detail: 'Windows does not need X11 for capture' };
  const display = String(env.DISPLAY || '').trim();
  if (display) return { name: 'x11', status: 'PASS', detail: `DISPLAY=${display}` };
  return {
    name: 'x11',
    status: 'FAIL',
    detail: 'DISPLAY is not set.',
    fix: 'Start an X11 session, or set DISPLAY under XWayland.',
  };
}

function waylandWarning(env) {
  const session = String(env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  if (String(env.WAYLAND_DISPLAY || '').trim() || session === 'wayland') {
    return 'Screen capture needs X11 or XWayland.';
  }
  return '';
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

function formatCheck(check) {
  if (check.status === 'PASS') return `PASS ${check.name}: ${check.detail}`;
  return `FAIL ${check.name}: ${check.detail} ${check.fix}`;
}

function run(opts) {
  const env = opts.env || {};
  const checks = [
    nodeCheck(opts.nodeVersion),
    loginCheck(opts.probe),
    x11Check(env, opts.platform),
    clientCheck(opts.client),
  ];
  const warning = waylandWarning(env);
  const lines = checks.map(formatCheck);
  if (warning) lines.push(`WARN: ${warning}`);
  const code = checks.every((check) => check.status === 'PASS') ? 0 : 1;
  return { code, text: `${lines.join('\n')}\n` };
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

function main() {
  const out = run({
    nodeVersion: process.versions.node,
    platform: process.platform,
    env: process.env,
    probe: () => realProbe(process.env),
    client: findClientInfo(),
  });
  process.stdout.write(out.text);
  process.exit(out.code);
}

module.exports = { run, findClientInfo, tocNumber };

if (require.main === module) main();
