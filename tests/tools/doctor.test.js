'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../../tools/doctor');

const loggedIn = () => [{ status: 0, stdout: 'logged in\n', stderr: '' }];
const loggedOut = () => [{ status: 0, stdout: '', stderr: 'Not logged in\n' }];

function env(over) {
  return {
    nodeVersion: '22.2.0',
    platform: 'linux',
    env: { DISPLAY: ':0' },
    probe: loggedIn,
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
    '',
  ].join('\n'));
});

test('Wayland warns that capture needs X11 or XWayland', () => {
  const display = run(env({ env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } }));
  assert.equal(display.code, 0);
  assert.equal(display.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'PASS x11: DISPLAY=:0',
    'WARN: Screen capture needs X11 or XWayland.',
    '',
  ].join('\n'));

  const session = run(env({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'Wayland' } }));
  assert.equal(session.code, 0);
  assert.equal(session.text, display.text);

  const blocked = run(env({ env: { WAYLAND_DISPLAY: 'wayland-0' } }));
  assert.equal(blocked.code, 1);
  assert.equal(blocked.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'FAIL x11: DISPLAY is not set. Start an X11 session, or set DISPLAY under XWayland.',
    'WARN: Screen capture needs X11 or XWayland.',
    '',
  ].join('\n'));
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
    '',
  ].join('\n'));

  const windows = run(env({ platform: 'win32', env: {} }));
  assert.equal(windows.code, 0);
  assert.equal(windows.text, [
    'PASS node: Node.js 22.2.0',
    'PASS login: an agent CLI is logged in',
    'PASS x11: Windows does not need X11 for capture',
    '',
  ].join('\n'));
});
