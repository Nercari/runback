'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { go } = require('../../tools/go');

const ROOT = path.join(__dirname, '..', '..');

test('go refuses non-Linux platforms', () => {
  const r = go({ platform: 'win32', argv: ['--no-update'] });
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /Windows use Runback\.cmd/);
});

test('go runs update, setup, doctor, and starts the bridge on Linux with fakes', () => {
  const calls = [];
  const r = go({
    platform: 'linux',
    root: ROOT,
    argv: ['--no-update'],
    updater: () => ({ changed: false, note: 'skipped (--no-update)' }),
    runner: (script, args = []) => {
      calls.push({ script, args });
      if (script.endsWith('setup.js')) return { ok: true, out: 'setup ok\n', code: 0 };
      if (script.endsWith('doctor.js')) {
        assert.deepEqual(args, ['--pre-start']);
        return { ok: true, out: 'PASS node: Node.js 22.2.0\n', code: 0 };
      }
      return { ok: false, out: '', code: 1 };
    },
    bridgeRunning: () => false,
    start: () => calls.push('start-supervisor'),
  });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.script.endsWith('setup.js')));
  assert.ok(calls.some((c) => c.script.endsWith('doctor.js')));
  assert.ok(calls.includes('start-supervisor'));
});

test('go reaches start when doctor would fail only on a stopped bridge', () => {
  let started = false;
  const r = go({
    platform: 'linux',
    root: ROOT,
    argv: ['--no-update'],
    updater: () => ({ note: 'ok' }),
    runner: (script, args = []) => {
      if (script.endsWith('setup.js')) return { ok: true, out: '', code: 0 };
      if (script.endsWith('doctor.js')) {
        assert.deepEqual(args, ['--pre-start']);
        return { ok: true, out: 'PASS bridge: supervisor not running yet\n', code: 0 };
      }
      return { ok: true, out: '', code: 0 };
    },
    bridgeRunning: () => false,
    start: () => { started = true; },
  });
  assert.equal(r.ok, true);
  assert.equal(started, true);
});

test('go stops when doctor fails', () => {
  const r = go({
    platform: 'linux',
    root: ROOT,
    argv: ['--no-update'],
    updater: () => ({ note: 'ok' }),
    runner: (script) => {
      if (script.endsWith('setup.js')) return { ok: true, out: '', code: 0 };
      if (script.endsWith('doctor.js')) return { ok: false, out: 'FAIL login: nope\n', code: 1 };
      return { ok: true, out: '', code: 0 };
    },
    bridgeRunning: () => false,
    start: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /Doctor reported failures/);
});

test('go skips starting the bridge when it is already running', () => {
  let started = false;
  const r = go({
    platform: 'linux',
    root: ROOT,
    argv: ['--no-update'],
    updater: () => ({ note: 'ok' }),
    runner: (script) => {
      if (script.endsWith('setup.js')) return { ok: true, out: '', code: 0 };
      if (script.endsWith('doctor.js')) return { ok: true, out: 'PASS\n', code: 0 };
      return { ok: true, out: '', code: 0 };
    },
    bridgeRunning: () => true,
    start: () => { started = true; },
  });
  assert.equal(r.ok, true);
  assert.equal(started, false);
  assert.match(r.lines.join('\n'), /already running/);
});
