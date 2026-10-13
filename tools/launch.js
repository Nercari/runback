#!/usr/bin/env node
'use strict';
// One double-click to update, install and start Runback (the "Runback.cmd" file
// in the repo root, or the desktop shortcut it makes on first run).
//
//   node tools/launch.js [--no-update] [--no-shortcut]
//
// 1. Update: fast-forwards a clean checkout to the released forever branch
//    (see update()). No network, no git, or local edits: it says so and
//    carries on with what is there.
// 2. Install: runs setup.js (safe to re-run; keeps config.json and the slots).
// 3. Bridge: starts it in its own minimized window, or restarts it when the
//    update changed its code. Left alone when it is running and up to date.
// 4. Game: says whether to /reload, relaunch, or just open it. When the game
//    isn't running it opens the Battle.net app; it never starts or touches the
//    game itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { backupName } = require('../setup');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'bridge');
const ADDON_SRC = path.join(ROOT, 'addon', 'Runback');
const CONFIG = path.join(BRIDGE, 'config.json');
const SHORTCUT_MARK = path.join(BRIDGE, '.shortcut-made');
const WIN = process.platform === 'win32';
const RELEASE_BRANCH = 'forever';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...opts });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), missing: r.error?.code === 'ENOENT' };
}

// Brings a clean checkout to the released version (RELEASE_BRANCH on its
// remote). Fast-forward only: never merges, resets or discards anything; a
// folder with local edits, or a local release branch with commits of its own,
// is left as it is. A clean checkout left on another branch (an agent's work
// branch) is switched to the release branch; that branch is kept. Nothing is
// switched unless the fetch worked. Returns { changed, files, note }: files are
// those that differ on disk afterwards.
function update(root) {
  const git = (...a) => run('git', ['-C', root, ...a], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const lines = r => r.out.split('\n').filter(Boolean);
  // git's own reason, without its "hint:" lines; "...overwritten by checkout:"
  // gets the first file it names.
  const why = r => {
    const ls = r.err.split('\n').filter(l => l.trim() && !/^hint:/.test(l));
    if (!ls.length) return 'no network?';
    const first = ls[0].replace(/^(fatal|error): /, '');
    return first.endsWith(':') && ls[1] ? `${first} ${ls[1].trim()}` : first;
  };
  const keep = note => ({ changed: false, files: [], note });
  if (!fs.existsSync(path.join(root, '.git'))) return keep('not a git checkout; skipping the update');
  const head = git('rev-parse', 'HEAD');
  if (head.missing) return keep('git is not installed; skipping the update');
  if (!head.ok) return keep('git could not read this checkout; skipping the update');
  const done = finishPrevious(root, git);
  if (done.left.length) return keep(`${count(done.left)} from the last update still could not be replaced (${done.left.slice(0, 3).join(', ')}): close anything using them and run this again`);
  if (git('status', '--porcelain', '--untracked-files=no').out) return keep('this folder has local edits, so it was not updated (nothing was changed)');

  // The remote the local release branch tracks, else origin.
  const upstream = git('rev-parse', '--abbrev-ref', `${RELEASE_BRANCH}@{upstream}`);
  const remote = upstream.ok ? upstream.out.split('/')[0] : 'origin';
  const fetch = git('fetch', '--quiet', remote, RELEASE_BRANCH);
  if (!fetch.ok) return keep(`could not update (${why(fetch)}); using the version you have`);
  const release = git('rev-parse', 'FETCH_HEAD').out;

  const local = git('rev-parse', '--verify', '--quiet', `refs/heads/${RELEASE_BRANCH}`);
  if (local.ok && !git('merge-base', '--is-ancestor', local.out, release).ok) {
    return keep(`your ${RELEASE_BRANCH} branch has changes of its own that are not in the release; not updated`);
  }
  const branch = git('branch', '--show-current').out;
  // A detached commit that no branch holds would only be left in the reflog.
  if (!branch && !git('merge-base', '--is-ancestor', head.out, release).ok &&
      !git('for-each-ref', '--contains', head.out, 'refs/heads').out) {
    return keep(`this folder is on commit ${head.out.slice(0, 7)}, which no branch holds; not updated`);
  }
  let switched = '', moved;
  if (branch === RELEASE_BRANCH) {
    moved = git('merge', '--ff-only', '--quiet', release);
  } else {
    // switch -C would move a forever checked out in another worktree under it.
    // Entries whose folder was deleted ("prunable") don't count; newer git still
    // refuses those, hence --ignore-other-worktrees below.
    const elsewhere = git('worktree', 'list', '--porcelain').out.split('\n\n')
      .some(w => w.split('\n').includes(`branch refs/heads/${RELEASE_BRANCH}`) && !/^prunable/m.test(w));
    if (elsewhere) return keep(`${RELEASE_BRANCH} is open in another folder (a git worktree); not updated`);
    // One checkout straight to the release: the local release branch (an
    // ancestor, checked above) is moved up to it in the same step, so a
    // refused checkout leaves the folder exactly where it was.
    moved = git('switch', '--quiet', '--ignore-other-worktrees', '-C', RELEASE_BRANCH, release);
    if (git('branch', '--show-current').out === RELEASE_BRANCH) {
      git('branch', '--quiet', `--set-upstream-to=${remote}/${RELEASE_BRANCH}`);
      switched = ` (switched from "${branch || 'a detached commit'}" to ${RELEASE_BRANCH}; ${branch ? 'that branch is' : 'its commits are'} kept)`;
    }
  }
  // Judge by where HEAD ended up, not the exit code: a failing post-checkout
  // hook makes git exit non-zero after the checkout already happened.
  const after = git('rev-parse', 'HEAD').out;
  const onRelease = git('branch', '--show-current').out === RELEASE_BRANCH;
  if (!moved.ok && after === head.out && (branch === RELEASE_BRANCH || !onRelease)) {
    return keep(`could not update (${why(moved)}); using the version you have`);
  }
  // A file git could not replace, create or delete (in use, read-only) keeps
  // the previous checkout's bytes. List only the files that really changed,
  // say which didn't, and note them so the next run can finish the job.
  const deleted = after === head.out ? [] : lines(git('diff', '--name-only', '--diff-filter=D', head.out, after));
  const stuck = [...lines(git('diff', '--name-only', 'HEAD')), ...deleted.filter(f => fs.existsSync(path.join(root, f)))];
  const files = [...done.files, ...(after === head.out ? [] : lines(git('diff', '--name-only', head.out, after)).filter(f => !stuck.includes(f)))];
  if (stuck.length) {
    fs.writeFileSync(pendingFile(root, git), JSON.stringify({ from: head.out, paths: stuck }));
    return { changed: files.length > 0, files, note: `partly updated: ${count(stuck)} could not be replaced (${stuck.slice(0, 3).join(', ')}): close anything using them and run this again${switched}` };
  }
  if (!files.length) return { changed: false, files, note: `already up to date${switched}` };
  return { changed: true, files, note: `updated to the latest release (${count(files)} changed)${switched}` };
}

const count = fs_ => `${fs_.length} file${fs_.length === 1 ? '' : 's'}`;
const pendingFile = (root, git) => path.resolve(root, git('rev-parse', '--git-path', 'runback-unfinished').out);

// Finishes an update that left files behind (see the end of update()). A file
// is replaced only while it still holds exactly what the previous checkout
// put there (or is still absent when that checkout had none); anything else
// is the player's edit and is left alone. Returns the files it finished and
// the ones still stuck.
function finishPrevious(root, git) {
  const file = pendingFile(root, git);
  let pending;
  try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { files: [], left: [] }; }
  const blob = (rev, f) => git('rev-parse', '--verify', '--quiet', `${rev}:${f}`).out;
  const files = [], left = [];
  for (const f of pending.paths) {
    const disk = fs.existsSync(path.join(root, f)) ? git('hash-object', '--', f).out : '';
    const want = blob('HEAD', f);
    if (disk === want) { files.push(f); continue; }
    if (disk !== blob(pending.from, f)) continue;
    if (want) {
      if (git('checkout', 'HEAD', '--', f).ok && git('hash-object', '--', f).out === want) files.push(f); else left.push(f);
    } else {
      try { fs.unlinkSync(path.join(root, f)); files.push(f); } catch { left.push(f); }
    }
  }
  if (left.length) fs.writeFileSync(file, JSON.stringify({ from: pending.from, paths: left }));
  else fs.rmSync(file, { force: true });
  return { files, left };
}

// True when an installed addon file is missing or differs from the repo copy.
// Inbox.lua is skipped: the bridge owns the installed one.
function addonDiffers(src, dest) {
  for (const f of fs.readdirSync(src)) {
    if (f === 'Inbox.lua') continue;
    const target = path.join(dest, f);
    if (!fs.existsSync(target)) return true;
    if (!fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(target))) return true;
  }
  return false;
}

// "slots: 200  files created: 15000  already present: 0" from install-slots.js.
function slotsCreated(setupOutput) {
  const m = /files created: (\d+)/.exec(setupOutput);
  return m ? Number(m[1]) : 0;
}

// What to do with the bridge and what to tell the player about the game.
function plan({ bridgeRunning, bridgeChanged, gameRunning, addonChanged, newFiles }) {
  const bridge = !bridgeRunning ? 'start' : bridgeChanged ? 'restart' : 'keep';
  let game;
  if (!gameRunning) game = 'open';
  else if (newFiles) game = 'relaunch';
  else if (addonChanged) game = 'reload';
  else game = 'ready';
  return { bridge, game };
}

const GAME_TEXT = {
  open: 'Open WoW: Forever as usual, then type /ai in game.',
  relaunch: 'The game is open but new addon files were added: quit WoW completely and open it again.',
  reload: 'The game is open and the addon was updated: type /reload in game.',
  ready: 'The game is open and up to date: type /ai in game.',
};

// --- Windows helpers -------------------------------------------------------

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function bridgeRunning(bridgeDir = BRIDGE) {
  const r = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bridgeDir, 'stop-bridge.ps1'), '-ListOnly']);
  return r.ok && /\d/.test(r.out);
}

function stopBridge(bridgeDir = BRIDGE) {
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bridgeDir, 'stop-bridge.ps1')]);
}

function startBridge(bridgeDir = BRIDGE) {
  // --on: a launch means "AI on", even if it was switched off with runback-kill.
  spawn('cmd.exe', ['/c', 'start', '"Runback bridge"', '/min', 'cmd', '/k', 'node', `"${path.join(bridgeDir, 'supervisor.js')}"`, '--on'],
    { cwd: bridgeDir, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

function gameRunning(processName) {
  const r = run('tasklist', ['/FI', `IMAGENAME eq ${processName}.exe`, '/NH']);
  return r.ok && r.out.toLowerCase().includes(`${processName.toLowerCase()}.exe`);
}

// Opens the Battle.net app (it only brings the window forward if it is already
// open). The player presses Play there; nothing here starts the game.
function openBattleNet() {
  const exe = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean).map(p => path.join(p, 'Battle.net', 'Battle.net Launcher.exe')).find(p => fs.existsSync(p));
  if (!exe) return false;
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

const OLD_SHORTCUTS = ['WoW AI.lnk', 'WoW AI.cmd'];

function shortcutIconPath(root = ROOT) {
  const icon = path.join(root, 'docs', 'assets', 'runback.ico');
  return fs.existsSync(icon) ? icon : null;
}

function shouldCreateShortcut(marked, hadOld, hasRunback) {
  return !marked || (hadOld && !hasRunback);
}

function launcherNeedles(root = ROOT) {
  const rels = ['Runback.cmd', 'WoW AI.cmd', path.join('tools', 'launch.js')];
  const needles = [];
  for (const rel of rels) {
    const abs = path.resolve(root, rel);
    needles.push(abs, abs.replaceAll('/', '\\'));
  }
  return needles;
}

function refersToLauncher(file, root = ROOT) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  const utf8 = buf.toString('utf8');
  const utf16 = buf.toString('utf16le');
  return launcherNeedles(root).some(needle => utf8.includes(needle) || utf16.includes(needle));
}

function ourOldShortcuts(desktop, root = ROOT) {
  return OLD_SHORTCUTS
    .map(name => path.join(desktop, name))
    .filter(file => fs.existsSync(file) && refersToLauncher(file, root));
}

function clientBackup(now = new Date()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (!cfg.addonDir) return null;
    return path.join(path.resolve(cfg.addonDir, '..', '..'), backupName(now));
  } catch {
    return null;
  }
}

function moveIntoBackup(src, backup) {
  try {
    fs.mkdirSync(backup, { recursive: true });
    const base = path.basename(src);
    let dest = path.join(backup, base);
    if (fs.existsSync(dest)) {
      let n = 2;
      while (fs.existsSync(`${dest}-${n}`)) n++;
      dest = `${dest}-${n}`;
    }
    fs.renameSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}

function parkOldShortcuts(desktop, backup, root = ROOT) {
  if (!backup) return [];
  const moved = [];
  for (const file of ourOldShortcuts(desktop, root)) {
    const dest = moveIntoBackup(file, backup);
    if (dest) moved.push(dest);
  }
  return moved;
}

function shortcutScript(desk, icon) {
  const target = path.join(ROOT, 'Runback.cmd');
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const lines = [
    `$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(path.join(desk, 'Runback.lnk'))})`,
    `$l.TargetPath = ${q(target)}`,
    `$l.WorkingDirectory = ${q(ROOT)}`,
    `$l.WindowStyle = 7`,
    `$l.Description = 'Update and start Runback'`,
  ];
  if (icon) lines.push(`$l.IconLocation = ${q(icon)}`);
  lines.push('$l.Save()', `Write-Output ${q(desk)}`);
  return lines.join('; ');
}

// A "Runback" icon on the desktop pointing at Runback.cmd. Made once: if the
// player deletes it, it stays deleted (bridge/.shortcut-made remembers).
// desktop and mark are for the tests.
function makeShortcut({ desktop = '', mark = SHORTCUT_MARK, backup } = {}) {
  let desk = desktop;
  if (!desk) {
    if (!WIN) return null;
    const found = powershell(`[Environment]::GetFolderPath('Desktop')`);
    if (!found.ok || !found.out) return null;
    desk = found.out.trim();
  }
  const dest = backup === undefined ? clientBackup() : (backup || null);
  const hadOld = ourOldShortcuts(desk).length > 0;
  const hasRunback = fs.existsSync(path.join(desk, 'Runback.lnk'));
  if (shouldCreateShortcut(fs.existsSync(mark), hadOld, hasRunback)) {
    const icon = shortcutIconPath();
    const r = powershell(shortcutScript(desk, icon));
    if (!r.ok) return null;
    if (!fs.existsSync(mark)) fs.writeFileSync(mark, new Date().toISOString() + '\n');
    parkOldShortcuts(desk, dest);
    return r.out;
  }
  parkOldShortcuts(desk, dest);
  return null;
}

// --- main ------------------------------------------------------------------

// Success: the window closes by itself. Failure: it waits for Enter so the
// message can be read (exit 0 then, so Runback.cmd doesn't pause a second time).
function closeSoon(code) {
  if (!process.stdin.isTTY) process.exit(code);
  if (code !== 0) {
    console.log('\nPress Enter to close this window.');
    process.stdin.once('data', () => process.exit(0));
    return;
  }
  console.log('\nThis window closes in 10 seconds.');
  setTimeout(() => process.exit(0), 10000);
}

function main(argv) {
  console.log('Runback\n');
  const firstInstall = !fs.existsSync(CONFIG);

  const up = argv.includes('--no-update') ? { changed: false, files: [], note: 'skipped (--no-update)' } : update(ROOT);
  console.log(`update : ${up.note}`);

  let addonChanged = true;
  if (!firstInstall) {
    try { addonChanged = addonDiffers(ADDON_SRC, path.join(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).addonDir, 'Runback')); } catch {}
  }

  console.log('install: checking the addon in the game folder...');
  const setup = run(process.execPath, [path.join(ROOT, 'setup.js')], { cwd: ROOT, timeout: 600000 });
  if (!setup.ok) {
    console.log((setup.err || setup.out).replace(/^/gm, '  '));
    console.log('\nInstall failed; the message above says why. Nothing was started.');
    return closeSoon(1);
  }
  const newFiles = slotsCreated(setup.out) > 0;
  console.log(`install: ${firstInstall ? 'installed' : addonChanged ? 'addon updated' : 'addon already up to date'}${newFiles ? ', new slot files added' : ''}`);

  if (!WIN) {
    console.log('\nStart the bridge with: npm start');
    return closeSoon(0);
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const bridgeChanged = up.files.some(f => f.startsWith('bridge/') || f.startsWith('mentor/') || f === 'package.json');
  const p = plan({
    bridgeRunning: bridgeRunning(),
    bridgeChanged,
    gameRunning: gameRunning((cfg.capture && cfg.capture.processName) || 'WowB'),
    addonChanged,
    newFiles,
  });

  if (p.bridge === 'restart') { stopBridge(); startBridge(); console.log('bridge : restarted with the new version (minimized window "Runback bridge")'); }
  else if (p.bridge === 'start') { startBridge(); console.log('bridge : started (minimized window "Runback bridge"; close it to stop the AI)'); }
  else console.log('bridge : already running');

  if (!argv.includes('--no-shortcut')) {
    const desk = makeShortcut();
    if (desk) console.log(`shortcut: added "Runback" to your desktop; next time just double-click it`);
  }

  if (p.game === 'open' && openBattleNet()) console.log('game   : opened the Battle.net app; press Play there.');
  console.log(`\n${GAME_TEXT[p.game]}`);
  return closeSoon(0);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  update,
  addonDiffers,
  slotsCreated,
  plan,
  GAME_TEXT,
  bridgeRunning,
  startBridge,
  stopBridge,
  gameRunning,
  makeShortcut,
  shortcutIconPath,
  shortcutScript,
  shouldCreateShortcut,
  refersToLauncher,
  parkOldShortcuts,
};
