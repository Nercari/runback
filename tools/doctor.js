#!/usr/bin/env node
'use strict';

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

function main() {
  const out = run({
    nodeVersion: process.versions.node,
    platform: process.platform,
    env: process.env,
    probe: () => realProbe(process.env),
  });
  process.stdout.write(out.text);
  process.exit(out.code);
}

module.exports = { run };

if (require.main === module) main();
