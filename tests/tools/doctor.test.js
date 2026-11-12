'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run,
  findClientInfo,
  tocNumber,
  LOGIN_PROBES,
  isLoggedIn,
  checkCount,
  combatLogOnDisk,
  linuxBridgeRunning,
  stopLinuxSupervisor,
  listSupervisorPids,
  supervisorPidFile,
  writeSupervisorPidFile,
  readSupervisorPid,
  repoRootFromBridge,
  supervisorMatchesCheckout,
} = require('../../tools/doctor');
const { go, setupArgsFor } = require('../../tools/go');
const { stopBridge } = require('../../tools/stop-bridge');

const ROOT = path.join(__dirname, '..', '..');

function trustSupervisor() {
  return () => true;
}

const loggedIn = () => LOGIN_PROBES.map(() => ({ status: 0, stdout: 'logged in\n', stderr: '' }));
const loggedOut = () => LOGIN_PROBES.map((entry) => {
  const kind = entry[2] || 'default';
  if (kind === 'hermes-list') return { status: 0, stdout: '', stderr: '' };
  if (kind === 'opencode-list') return { status: 0, stdout: 'No authenticated integrations\n', stderr: '' };
  if (kind === 'agy-headless' || kind === 'grok-headless') {
    return { status: 0, stdout: '', stderr: 'authentication required\n' };
  }
  return { status: 0, stdout: '', stderr: 'Not logged in\n' };
});
const pythonOk = () => ({ ok: true, version: 'Python 3.12.3' });
const pythonMissing = () => ({ ok: false, version: '' });

function env(over) {
  return {
    nodeVersion: '22.2.0',
    platform: 'linux',
    env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
    probe: loggedIn,
    pythonProbe: pythonOk,
    bridgeRunning: () => true,
    combatLogState: () => 'unknown',
    client: { dir: '/wow/_forever_', interface: '16001', slots: true },
    ...over,
  };
}

function tail(lines) {
  return lines.join('\n') + '\n';
}

function tempBridgeDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-bridge-'));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return bridgeDir;
}

test('doctor exposes eight checks and six agent login probes', () => {
  assert.equal(checkCount(), 8);
  assert.equal(LOGIN_PROBES.length, 6);
});

test('agy login probe attaches prompt with -p=0', () => {
  const agy = LOGIN_PROBES.find(([id]) => id === 'agy');
  assert.deepEqual(agy[1].slice(0, 1), ['-p=0']);
});

function probeResults(overrides) {
  return LOGIN_PROBES.map((entry) => {
    const [id] = entry;
    if (Object.hasOwn(overrides, id)) return overrides[id];
    return { status: 2, stdout: '', stderr: 'unknown subcommand\n' };
  });
}

test('hermes-only login passes via auth list credential counts', () => {
  const out = run(env({
    probe: () => probeResults({
      hermes: { status: 0, stdout: 'nous (1 credentials):\n', stderr: '' },
    }),
  }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS login:.*hermes/m);
});

test('opencode-only login passes via auth list', () => {
  const out = run(env({
    probe: () => probeResults({
      opencode: { status: 0, stdout: 'opencode\n', stderr: '' },
    }),
  }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS login:.*opencode/m);
});

test('agy-only login passes via headless probe without authentication required', () => {
  const out = run(env({
    probe: () => probeResults({
      agy: { status: 0, stdout: 'ok\n', stderr: '' },
    }),
  }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS login:.*agy/m);
});

test('invalid auth subcommands do not count as logged in', () => {
  const hermesStatus = LOGIN_PROBES.find(([id]) => id === 'hermes');
  assert.equal(isLoggedIn(['hermes', ['auth', 'status']], { status: 2, stdout: '', stderr: 'usage\n' }), false);
  assert.equal(isLoggedIn(hermesStatus, { status: 0, stdout: 'nous (1 credentials):\n', stderr: '' }), true);
  const opencode = LOGIN_PROBES.find(([id]) => id === 'opencode');
  assert.equal(isLoggedIn(opencode, { status: 0, stdout: 'No authenticated integrations\n', stderr: '' }), false);
  const agy = LOGIN_PROBES.find(([id]) => id === 'agy');
  assert.equal(isLoggedIn(agy, { status: 1, stdout: '', stderr: 'authentication required\n' }), false);
});

test('old Node fails with a one-line fix', () => {
  const out = run(env({ nodeVersion: '22.1.0' }));
  assert.equal(out.code, 1);
  assert.match(out.text, /^FAIL node:/m);
});

test('missing python3 on Linux fails with a one-line fix', () => {
  const out = run(env({ pythonProbe: pythonMissing }));
  assert.equal(out.code, 1);
  assert.match(out.text, /^FAIL python3:/m);
});

test('missing login fails with a one-line fix', () => {
  const out = run(env({ probe: loggedOut }));
  assert.equal(out.code, 1);
  assert.match(out.text, /^FAIL login:/m);
});

test('a Wayland session fails the X11 check even with XWayland DISPLAY set', () => {
  const display = run(env({ env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } }));
  assert.equal(display.code, 1);
  assert.match(display.text, /^FAIL x11:/m);

  const session = run(env({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'Wayland' } }));
  assert.equal(session.code, 1);
  assert.match(session.text, /^FAIL x11:/m);
});

test('an X11 session passes the X11 check', () => {
  const out = run(env({ env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' } }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS x11: DISPLAY=:0$/m);
});

test('missing slots fails with a one-line fix', () => {
  const out = run(env({ client: { dir: '/wow/_forever_', interface: '16001' } }));
  assert.equal(out.code, 1);
  assert.match(out.text, /^FAIL slots:/m);
});

test('a stopped bridge on Linux fails with a one-line fix', () => {
  const out = run(env({ bridgeRunning: () => false }));
  assert.equal(out.code, 1);
  assert.match(out.text, /^FAIL bridge:/m);
});

test('pre-start doctor passes a stopped bridge so npm run go can start it', () => {
  const out = run(env({ bridgeRunning: () => false, preStart: true }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS bridge: supervisor not running yet/m);
});

test('supervisorMatchesCheckout accepts npm start (repo root cwd, relative supervisor path)', () => {
  const bridgeDir = path.join(ROOT, 'bridge');
  const repoRoot = repoRootFromBridge(bridgeDir);
  const readers = {
    cmdline: () => `${process.execPath} bridge/supervisor.js`,
    cwd: () => repoRoot,
  };
  assert.equal(supervisorMatchesCheckout(9001, bridgeDir, () => true, readers), true);
});

test('readSupervisorPid keeps npm-start supervisor identity without clearing pid file', (t) => {
  const bridgeDir = tempBridgeDir(t);
  const repoRoot = repoRootFromBridge(bridgeDir);
  writeSupervisorPidFile(bridgeDir, 9001);
  const npmStart = (pid, dir) => supervisorMatchesCheckout(pid, dir, () => true, {
    cmdline: () => 'node bridge/supervisor.js',
    cwd: () => repoRoot,
  });
  assert.equal(readSupervisorPid(bridgeDir, (pid) => pid === 9001, npmStart), 9001);
  assert.equal(fs.existsSync(supervisorPidFile(bridgeDir)), true);
});

test('linuxBridgeRunning trusts only this checkout supervisor.pid record', (t) => {
  const bridgeDir = tempBridgeDir(t);
  const pidFile = supervisorPidFile(bridgeDir);
  writeSupervisorPidFile(bridgeDir, 4242);
  const alive4242 = (pid) => pid === 4242;
  const identity = trustSupervisor();
  assert.equal(linuxBridgeRunning(bridgeDir, alive4242, identity), true);
  assert.deepEqual(listSupervisorPids(bridgeDir, alive4242, identity), [4242]);
  assert.equal(linuxBridgeRunning(bridgeDir, () => false, identity), false);
  assert.equal(fs.existsSync(pidFile), false);
});

test('supervisor pid file works when go starts with cwd bridge (not repo root)', (t) => {
  const bridgeDir = tempBridgeDir(t);
  writeSupervisorPidFile(bridgeDir, 5150);
  const fromBridgeCwd = (pid, dir) => supervisorMatchesCheckout(pid, dir, () => true, {
    cmdline: () => 'node supervisor.js',
    cwd: () => bridgeDir,
  });
  assert.equal(readSupervisorPid(bridgeDir, (pid) => pid === 5150, fromBridgeCwd), 5150);
});

test('bridge.js stops capture and running agents on SIGTERM without persisting KILLED', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bridge', 'bridge.js'), 'utf8');
  assert.match(src, /process\.on\('SIGTERM'/);
  assert.match(src, /stopCapture\(\)/);
  assert.match(src, /stopRunning\(\)/);
  const shutdown = /function shutdownBridge\(\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(shutdown);
  assert.doesNotMatch(shutdown[0], /KILLED/);
});

test('stopLinuxSupervisor sends SIGTERM to the process group then clears the pid file', (t) => {
  const bridgeDir = tempBridgeDir(t);
  const pidFile = supervisorPidFile(bridgeDir);
  writeSupervisorPidFile(bridgeDir, 77);
  const killed = [];
  let alive = true;
  const fakeKill = (_cmd, args) => {
    killed.push(args);
    if (args[0] === '-TERM' && args[1] === '-77') alive = false;
    return { status: 0, stdout: '', error: null };
  };
  stopLinuxSupervisor(bridgeDir, fakeKill, () => alive, trustSupervisor());
  assert.deepEqual(killed, [['-TERM', '-77']]);
  assert.equal(fs.existsSync(pidFile), false);
});

test('readSupervisorPid drops a reused pid that is not this checkout supervisor', (t) => {
  const bridgeDir = tempBridgeDir(t);
  const pidFile = supervisorPidFile(bridgeDir);
  writeSupervisorPidFile(bridgeDir, 4242);
  const alien = (pid, dir) => supervisorMatchesCheckout(pid, dir, () => true, {
    cmdline: () => 'sleep 999',
    cwd: () => '/tmp',
  });
  assert.equal(readSupervisorPid(bridgeDir, () => true, alien), 0);
  assert.equal(fs.existsSync(pidFile), false);
});

test('stopLinuxSupervisor waits for the process to exit before clearing the pid file', (t) => {
  const bridgeDir = tempBridgeDir(t);
  const pidFile = supervisorPidFile(bridgeDir);
  writeSupervisorPidFile(bridgeDir, 88);
  let aliveTicks = 0;
  const alive = () => aliveTicks++ < 2;
  const fakeKill = (cmd, args) => {
    if (cmd === 'sleep') return { status: 0, stdout: '', error: null };
    if (args[0] === '-TERM') return { status: 0, stdout: '', error: null };
    return { status: 0, stdout: '', error: null };
  };
  stopLinuxSupervisor(bridgeDir, fakeKill, alive, trustSupervisor());
  assert.ok(aliveTicks >= 2);
  assert.equal(fs.existsSync(pidFile), false);
});

test('go waits for stopSupervisor before start when restarting after an update', () => {
  const order = [];
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
    stopSupervisor: () => { order.push('stop'); },
    start: () => { order.push('start'); },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['stop', 'start']);
});

test('missing combat log files on disk fails with a one-line fix', () => {
  const out = run(env({ combatLogState: () => 'off' }));
  assert.equal(out.code, 1);
  assert.match(out.text, /^FAIL combatlog:/m);
});

test('pre-start doctor passes missing combat logs when Logs exists but no file yet', () => {
  const out = run(env({ combatLogState: () => 'off', preStart: true }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS combatlog:/m);
  assert.doesNotMatch(out.text, /^FAIL combatlog:/m);
});

test('pre-start doctor passes when Logs exists empty and combatLogOnDisk reports off', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-prestart-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Logs'));
  const out = run(env({
    preStart: true,
    combatLogState: combatLogOnDisk,
    client: { dir: root, interface: '17000', slots: true },
  }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS combatlog:/m);
  assert.doesNotMatch(out.text, /^FAIL combatlog:/m);
});

test('doctor --pre-start exits 0 for combatlog when Logs dir exists but no WoWCombatLog file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-prestart-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'client');
  fs.mkdirSync(path.join(client, 'Logs'), { recursive: true });
  fs.mkdirSync(path.join(client, 'Interface', 'AddOns', 'Runback'), { recursive: true });
  fs.writeFileSync(path.join(client, 'Interface', 'AddOns', 'Runback', 'Runback.toc'), '## Interface: 17000\n');
  fs.mkdirSync(path.join(client, 'Interface', 'AddOns', 'Runback_S001'), { recursive: true });
  fs.writeFileSync(path.join(client, 'Interface', 'AddOns', 'Runback_S001', 'Runback_S001.toc'), '## Interface: 17000\n');
  const bridge = path.join(root, 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({ addonDir: path.join(client, 'Interface', 'AddOns') }));
  const info = findClientInfo(path.join(bridge, 'config.json'));
  const out = run(env({
    preStart: true,
    combatLogState: combatLogOnDisk,
    client: { ...info, slots: true },
  }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS combatlog:/m);
  assert.doesNotMatch(out.text, /^FAIL combatlog:/m);
});

test('all good passes with no warning', () => {
  const out = run(env({
    probe: () => [
      { status: 1, stdout: '', stderr: 'Not logged in\n' },
      { status: 0, stdout: 'logged in\n', stderr: '' },
      ...loggedIn().slice(2),
    ],
  }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS login:/m);

  const windows = run(env({ platform: 'win32', env: {} }));
  assert.equal(windows.code, 0);
  assert.match(windows.text, /^PASS python3: Linux capture only/m);
  assert.match(windows.text, /^PASS bridge: bridge process check is for Linux/m);

  const mac = run(env({ platform: 'darwin', env: {} }));
  assert.equal(mac.code, 0);
  assert.match(mac.text, /^PASS x11: macOS captures/m);
});

test('doctor names the client folder and the TOC number it found', () => {
  const out = run(env({ client: { dir: 'D:/Games/World of Warcraft/_forever_', interface: '17000', slots: true } }));
  assert.equal(out.code, 0);
  assert.match(out.text, /^PASS client: D:\/Games\/World of Warcraft\/_forever_ \(Interface 17000\)$/m);
});

test('no client folder, or no addon in it, fails with a one-line fix', () => {
  const missing = run(env({ client: null }));
  assert.equal(missing.code, 1);
  assert.match(missing.text, /^FAIL client: no WoW client folder/m);

  const noAddon = run(env({ client: { dir: '/wow/_forever_', interface: '', slots: true } }));
  assert.equal(noAddon.code, 1);
  assert.match(noAddon.text, /^FAIL client: the Runback addon is not installed under \/wow\/_forever_\./m);
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

test('combatLogOnDisk sees a WoWCombatLog file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'Logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'WoWCombatLog-112026.txt'), 'line\n');
  assert.equal(combatLogOnDisk({ dir: root }), 'on');
  assert.equal(combatLogOnDisk({ dir: path.join(root, 'nope') }), 'unknown');
});

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

test('go prints npm run stop after starting a detached supervisor', () => {
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
    bridgeRunning: () => false,
    start: () => {},
  });
  assert.equal(r.ok, true);
  assert.match(r.lines.join('\n'), /npm run stop/);
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

test('stopBridge refuses non-Linux platforms', () => {
  assert.equal(stopBridge('win32'), 1);
});
