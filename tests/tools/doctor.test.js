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
  supervisorPgrepPatterns,
  repoRootFromBridge,
} = require('../../tools/doctor');

const ROOT = path.join(__dirname, '..', '..');

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

test('doctor exposes eight checks and six agent login probes', () => {
  assert.equal(checkCount(), 8);
  assert.equal(LOGIN_PROBES.length, 6);
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

test('linuxBridgeRunning matches npm start relative supervisor path for this checkout only', () => {
  const bridgeDir = path.join(ROOT, 'bridge');
  const repoRoot = repoRootFromBridge(bridgeDir);
  assert.ok(supervisorPgrepPatterns(bridgeDir).includes('bridge/supervisor.js'));
  const fakePgrep = (_cmd, args) => {
    const pattern = args[1];
    if (pattern === 'bridge/supervisor.js') return { status: 0, stdout: '999\n', error: null };
    return { status: 1, stdout: '', error: null };
  };
  const cwdHere = (pid) => (pid === 999 ? repoRoot : '/other/runback');
  assert.equal(linuxBridgeRunning(bridgeDir, fakePgrep, cwdHere), true);
  assert.equal(linuxBridgeRunning(bridgeDir, fakePgrep, () => '/other/runback'), false);
});

test('stopLinuxSupervisor kills only this checkout supervisor', () => {
  const bridgeDir = path.join(ROOT, 'bridge');
  const repoRoot = repoRootFromBridge(bridgeDir);
  const killed = [];
  const fakePgrep = (_cmd, args) => {
    if (args[1] === 'bridge/supervisor.js') return { status: 0, stdout: '42\n99\n', error: null };
    return { status: 1, stdout: '', error: null };
  };
  const cwdHere = (pid) => (pid === 42 ? repoRoot : '/other/runback');
  const fakeKill = (_cmd, args) => {
    killed.push(Number(args[0]));
    return { status: 0, stdout: '', error: null };
  };
  stopLinuxSupervisor(bridgeDir, fakeKill, fakePgrep, cwdHere);
  assert.deepEqual(killed, [42]);
  assert.deepEqual(listSupervisorPids(bridgeDir, fakePgrep, cwdHere), [42]);
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
