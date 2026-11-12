'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { go, setupArgsFor } = require('../../tools/go');

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

test('setupArgsFor passes the configured client folder to setup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-go-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'World of Warcraft', '_forever_');
  const addons = path.join(client, 'Interface', 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  const bridge = path.join(root, 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({ addonDir: addons }));
  assert.deepEqual(setupArgsFor(root), ['--wow', client]);
});

test('go forwards configured client path to setup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-go-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'World of Warcraft', '_forever_');
  const addons = path.join(client, 'Interface', 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  const bridge = path.join(root, 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({ addonDir: addons }));
  let setupArgs;
  const r = go({
    platform: 'linux',
    root,
    argv: ['--no-update'],
    updater: () => ({ changed: false, files: [], note: 'skipped' }),
    runner: (script, args = []) => {
      if (script.endsWith('setup.js')) {
        setupArgs = args;
        return { ok: true, out: '', code: 0 };
      }
      if (script.endsWith('doctor.js')) return { ok: true, out: 'PASS\n', code: 0 };
      return { ok: true, out: '', code: 0 };
    },
    bridgeRunning: () => false,
    start: () => {},
  });
  assert.equal(r.ok, true);
  assert.deepEqual(setupArgs, ['--wow', client]);
});

test('go restarts the bridge when an update changed bridge code', () => {
  let stopped = false;
  let started = false;
  const r = go({
    platform: 'linux',
    root: ROOT,
    argv: [],
    updater: () => ({ changed: true, files: ['bridge/bridge.js'], note: 'updated' }),
    runner: (script) => {
      if (script.endsWith('setup.js')) return { ok: true, out: '', code: 0 };
      if (script.endsWith('doctor.js')) return { ok: true, out: 'PASS\n', code: 0 };
      return { ok: true, out: '', code: 0 };
    },
    bridgeRunning: () => true,
    stopSupervisor: () => { stopped = true; },
    start: () => { started = true; },
  });
  assert.equal(r.ok, true);
  assert.equal(stopped, true);
  assert.equal(started, true);
  assert.match(r.lines.join('\n'), /restarted supervisor after a bridge update/);
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
