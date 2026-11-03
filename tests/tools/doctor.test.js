'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, findClientInfo, tocNumber } = require('../../tools/doctor');

const loggedIn = () => [{ status: 0, stdout: 'logged in\n', stderr: '' }];
const loggedOut = () => [{ status: 0, stdout: '', stderr: 'Not logged in\n' }];

function env(over) {
  return {
    nodeVersion: '22.2.0',
    platform: 'linux',
    env: { DISPLAY: ':0' },
    probe: loggedIn,
    client: { dir: '/wow/_forever_', interface: '16001' },
    ...over,
  };
}

test('old Node fails with a one-line fix', () => {
  const out = run(env({ nodeVersion: '22.1.0' }));
  assert.equal(out.code, 1);
  assert.equal(out.text, [
    'FAIL node: Node.js 22.1.0 is older than 22.2. Install Node.js 22.2 or newer from https://nodejs.org.',
    'PASS login: an agent CLI is logged in',
    'PASS x11: DISPLAY=:0',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));
});

test('missing login fails with a one-line fix', () => {
  const out = run(env({ probe: loggedOut }));
  assert.equal(out.code, 1);
  assert.equal(out.text, [
    'PASS node: Node.js 22.2.0',
    'FAIL login: no agent CLI is logged in. Log in once in a terminal with claude, codex, or grok login.',
    'PASS x11: DISPLAY=:0',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));
});

test('a Wayland session fails the X11 check even with XWayland DISPLAY set', () => {
  const display = run(env({ env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } }));
  assert.equal(display.code, 1);
  assert.equal(display.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'FAIL x11: XDG_SESSION_TYPE=unset, DISPLAY=:0 is XWayland: capture needs an X11 session. ' +
      'Log out and pick an X11 session at the login screen (docs/INSTALL-LINUX.md, "No X11 session yet").',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));

  const session = run(env({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'Wayland' } }));
  assert.equal(session.code, 1);
  assert.equal(session.text, display.text.replace('XDG_SESSION_TYPE=unset', 'XDG_SESSION_TYPE=wayland'));

  const blocked = run(env({ env: { WAYLAND_DISPLAY: 'wayland-0' } }));
  assert.equal(blocked.code, 1);
  assert.equal(blocked.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'FAIL x11: XDG_SESSION_TYPE=unset, DISPLAY is not set: capture needs an X11 session. ' +
      'Log out and pick an X11 session at the login screen (docs/INSTALL-LINUX.md, "No X11 session yet").',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));
});

test('an X11 session passes the X11 check', () => {
  const out = run(env({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' } }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS x11: DISPLAY=:0$/m);
});


test('all good passes with no warning', () => {
  const out = run(env({
    probe: () => [
      { status: 1, stdout: '', stderr: 'Not logged in\n' },
      { status: 0, stdout: 'logged in\n', stderr: '' },
    ],
  }));
  assert.equal(out.code, 0);
  assert.equal(out.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'PASS x11: DISPLAY=:0',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));

  const windows = run(env({ platform: 'win32', env: {} }));
  assert.equal(windows.code, 0);
  assert.equal(windows.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'PASS x11: Windows does not need X11 for capture',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));

  const mac = run(env({ platform: 'darwin', env: {} }));
  assert.equal(mac.code, 0);
  assert.equal(mac.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'PASS x11: macOS captures with screencapture, not X11',
    'PASS client: /wow/_forever_ (Interface 16001)',
    '',
  ].join('\n'));
});

test('doctor names the client folder and the TOC number it found', () => {
  const out = run(env({ client: { dir: 'D:/Games/World of Warcraft/_forever_', interface: '17000' } }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS client: D:\/Games\/World of Warcraft\/_forever_ \(Interface 17000\)$/m);
});

test('no client folder, or no addon in it, fails with a one-line fix', () => {
  const missing = run(env({ client: null }));
  assert.equal(missing.code, 1);
  assert.equal(missing.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'PASS x11: DISPLAY=:0',
    'FAIL client: no WoW client folder was found. Run node setup.js, or pass --wow "<client folder>" to it.',
    '',
  ].join('\n'));

  const noAddon = run(env({ client: { dir: '/wow/_forever_', interface: '' } }));
  assert.equal(noAddon.code, 1);
  assert.match(noAddon.text, /^FAIL client: the Runback addon is not installed under \/wow\/_forever_\. Run node setup\.js to install it\.$/m);
});

test('the client folder and TOC number come from the config and the installed addon', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'World of Warcraft', '_forever_');
  const addons = path.join(client, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'Runback'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'Runback', 'Runback.toc'), '## Interface: 17000\n## Title: Runback\n');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ addonDir: addons }));

  const info = findClientInfo(config);
  assert.equal(info.dir, client);
  assert.equal(info.interface, '17000');
  assert.equal(tocNumber(client), '17000');
  assert.equal(tocNumber(path.join(root, 'nope')), '');
});
