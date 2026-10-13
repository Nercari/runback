"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const launch = require("../../tools/launch");
const { update, addonDiffers, slotsCreated, plan, GAME_TEXT } = launch;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  return dir;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", file);
  git(dir, "push", "-q");
}

// A remote, the player's checkout, and a second clone that publishes changes.
function repos(t) {
  const dir = tmp(t);
  const remote = path.join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "forever", remote);
  const dev = path.join(dir, "dev");
  git(dir, "clone", "-q", remote, dev);
  git(dev, "checkout", "-q", "-b", "forever");
  fs.writeFileSync(path.join(dev, "README.md"), "v1\n");
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "v1");
  git(dev, "push", "-q", "-u", "origin", "forever");
  const player = path.join(dir, "player");
  git(dir, "clone", "-q", "-b", "forever", remote, player);
  return { dev, player };
}

test("update: nothing new upstream", (t) => {
  const { player } = repos(t);
  const r = update(player);
  assert.equal(r.changed, false);
  assert.equal(r.note, "already up to date");
});

test("update: fast-forwards and lists the changed files", (t) => {
  const { dev, player } = repos(t);
  commit(dev, "bridge/bridge.js", "x\n");
  commit(dev, "addon/Runback/Runback.lua", "y\n");
  const r = update(player);
  assert.equal(r.changed, true);
  assert.deepEqual(r.files.sort(), ["addon/Runback/Runback.lua", "bridge/bridge.js"]);
  assert.equal(r.note, "updated to the latest release (2 files changed)");
  // Windows runners check out with core.autocrlf=true.
  assert.equal(fs.readFileSync(path.join(player, "bridge/bridge.js"), "utf8").replace(/\r\n/g, "\n"), "x\n");
});

test("update: a checkout with local edits is left exactly as it is", (t) => {
  const { dev, player } = repos(t);
  commit(dev, "bridge/bridge.js", "x\n");
  fs.writeFileSync(path.join(player, "README.md"), "my edit\n");
  const before = git(player, "rev-parse", "HEAD");
  const r = update(player);
  assert.equal(r.changed, false);
  assert.match(r.note, /local edits/);
  assert.equal(git(player, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(player, "README.md"), "utf8"), "my edit\n");
});

test("update: a diverged checkout is not merged", (t) => {
  const { dev, player } = repos(t);
  commit(dev, "a.txt", "upstream\n");
  fs.writeFileSync(path.join(player, "b.txt"), "local\n");
  git(player, "add", "-A");
  git(player, "commit", "-q", "-m", "local");
  const before = git(player, "rev-parse", "HEAD");
  const r = update(player);
  assert.equal(r.changed, false);
  assert.match(r.note, /changes of its own/);
  assert.equal(git(player, "rev-parse", "HEAD"), before);
});

test("update: a clean checkout left on another branch goes back to forever and updates", (t) => {
  const { dev, player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  fs.writeFileSync(path.join(player, "notes.md"), "agent\n");
  git(player, "add", "-A");
  git(player, "commit", "-q", "-m", "agent work");
  commit(dev, "bridge/bridge.js", "x\n");
  const r = update(player);
  assert.equal(git(player, "branch", "--show-current"), "forever");
  assert.equal(r.changed, true);
  assert.ok(r.files.includes("bridge/bridge.js"));
  assert.match(r.note, /switched from "agent-work" to forever/);
  assert.equal(git(player, "rev-parse", "HEAD"), git(dev, "rev-parse", "HEAD"), "on the release commit");
  assert.equal(fs.existsSync(path.join(player, "notes.md")), false);
  // The other branch and its commit are kept.
  assert.equal(git(player, "log", "-1", "--format=%s", "agent-work"), "agent work");
});

// Cases from the Cursor review of #34.
function onAgentBranch(player) {
  git(player, "switch", "-q", "-c", "agent-work");
  fs.writeFileSync(path.join(player, "bridge.js"), "agent\n");
  git(player, "add", "-A");
  git(player, "commit", "-q", "-m", "agent work");
}

test("update: a failed fetch switches nothing", (t) => {
  const { player } = repos(t);
  onAgentBranch(player);
  git(player, "remote", "set-url", "origin", path.join(path.dirname(player), "missing.git"));
  const r = update(player);
  assert.deepEqual([r.changed, r.files], [false, []]);
  assert.match(r.note, /could not update/);
  assert.equal(git(player, "branch", "--show-current"), "agent-work");
  assert.equal(fs.readFileSync(path.join(player, "bridge.js"), "utf8").replace(/\r\n/g, "\n"), "agent\n");
});

test("update: a local forever with unpushed commits is not switched to or reported as an update", (t) => {
  const { player } = repos(t);
  fs.writeFileSync(path.join(player, "local.txt"), "unpushed\n");
  git(player, "add", "-A");
  git(player, "commit", "-q", "-m", "unpushed");
  git(player, "switch", "-q", "-c", "agent-work", "origin/forever");
  const r = update(player);
  assert.deepEqual([r.changed, r.files], [false, []]);
  assert.match(r.note, /changes of its own/);
  assert.equal(git(player, "branch", "--show-current"), "agent-work");
});

test("update: leaving a branch that is ahead of the release lists the files that went back", (t) => {
  const { player } = repos(t);
  onAgentBranch(player);
  const r = update(player);
  assert.equal(r.changed, true);
  assert.deepEqual(r.files, ["bridge.js"]);
  assert.equal(r.note, 'updated to the latest release (1 file changed) (switched from "agent-work" to forever; that branch is kept)');
  assert.equal(git(player, "branch", "--show-current"), "forever");
});

test("update: an untracked file that blocks the switch is named, and nothing moves", (t) => {
  const { player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  git(player, "rm", "-q", "README.md");
  git(player, "commit", "-q", "-m", "drop readme");
  fs.writeFileSync(path.join(player, "README.md"), "my notes\n");
  const r = update(player);
  assert.equal(r.changed, false);
  assert.match(r.note, /could not update \(.*README\.md/s);
  assert.equal(git(player, "branch", "--show-current"), "agent-work");
  assert.equal(fs.readFileSync(path.join(player, "README.md"), "utf8"), "my notes\n");
});

test("update: commits on no branch are not left behind", (t) => {
  const { player } = repos(t);
  git(player, "switch", "-q", "--detach");
  fs.writeFileSync(path.join(player, "x.txt"), "detached\n");
  git(player, "add", "-A");
  git(player, "commit", "-q", "-m", "detached work");
  const head = git(player, "rev-parse", "HEAD");
  const r = update(player);
  assert.equal(r.changed, false);
  assert.match(r.note, /which no branch holds/);
  assert.equal(git(player, "rev-parse", "HEAD"), head);
});

test("update: a file in the way of the new release leaves the folder exactly where it was", (t) => {
  // Cursor re-review of #34: switching first and fast-forwarding second left
  // the folder on the old forever when the second step was refused.
  const { dev, player } = repos(t);
  onAgentBranch(player);
  commit(dev, "new.txt", "release\n");
  fs.writeFileSync(path.join(player, "new.txt"), "mine\n");
  const forever = git(player, "rev-parse", "forever");
  const r = update(player);
  assert.deepEqual([r.changed, r.files], [false, []]);
  assert.match(r.note, /could not update \(.*new\.txt/s);
  assert.equal(git(player, "branch", "--show-current"), "agent-work");
  assert.equal(git(player, "rev-parse", "forever"), forever);
  assert.equal(fs.readFileSync(path.join(player, "bridge.js"), "utf8").replace(/\r\n/g, "\n"), "agent\n");
  assert.equal(fs.readFileSync(path.join(player, "new.txt"), "utf8"), "mine\n");
});

test("update: a detached commit that a branch holds is switched to the release", (t) => {
  const { player } = repos(t);
  onAgentBranch(player);
  git(player, "switch", "-q", "--detach", "agent-work");
  const r = update(player);
  assert.equal(git(player, "branch", "--show-current"), "forever");
  assert.deepEqual(r.files, ["bridge.js"]);
  assert.match(r.note, /switched from "a detached commit" to forever/);
});

test("update: forever open in another worktree is not moved under it", (t) => {
  const { dev, player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  const other = path.join(path.dirname(player), "other");
  git(player, "worktree", "add", "-q", other, "forever");
  const forever = git(player, "rev-parse", "forever");
  commit(dev, "bridge/bridge.js", "x\n");
  const r = update(player);
  assert.equal(r.changed, false);
  assert.match(r.note, /another folder/);
  assert.equal(git(player, "rev-parse", "forever"), forever);
  assert.equal(git(other, "status", "--porcelain"), "");
});

test("update: a failing post-checkout hook does not hide a checkout that happened", (t) => {
  const { dev, player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  commit(dev, "bridge/bridge.js", "x\n");
  const hook = path.join(player, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = update(player);
  assert.equal(git(player, "branch", "--show-current"), "forever");
  assert.deepEqual([r.changed, r.files], [true, ["bridge/bridge.js"]]);
  assert.equal(git(player, "rev-parse", "--abbrev-ref", "forever@{upstream}"), "origin/forever");
});

test("update: a deleted worktree on forever does not block the update", (t) => {
  const { dev, player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  const gone = path.join(path.dirname(player), "gone");
  git(player, "worktree", "add", "-q", gone, "forever");
  fs.rmSync(gone, { recursive: true, force: true });
  commit(dev, "bridge/bridge.js", "x\n");
  const r = update(player);
  assert.equal(r.changed, true);
  assert.equal(git(player, "branch", "--show-current"), "forever");
});

test("update: a hook failing after a switch to the same commit is not called a network failure", (t) => {
  const { player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  fs.writeFileSync(path.join(player, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = update(player);
  assert.equal(git(player, "branch", "--show-current"), "forever");
  assert.doesNotMatch(r.note, /could not update/);
  assert.match(r.note, /already up to date \(switched from "agent-work"/);
});

test("update: a file left old by the checkout is named and not listed as updated", (t) => {
  // Stands in for a file git could not replace (in use, read-only): after the
  // checkout it still differs from the release.
  const { dev, player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  commit(dev, "bridge/bridge.js", "new\n");
  commit(dev, "addon/a.lua", "new\n");
  fs.writeFileSync(path.join(player, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho old > bridge/bridge.js\n", { mode: 0o755 });
  const r = update(player);
  assert.deepEqual([r.changed, r.files], [true, ["addon/a.lua"]]);
  assert.match(r.note, /1 file could not be replaced \(bridge\/bridge\.js\)/);
});

// The hooks below put back the previous checkout's bytes, as git does with a
// file it cannot replace or delete (in use, read-only).
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

test("update: a file left old by a switch is replaced on the next run", (t) => {
  const { dev, player } = repos(t);
  commit(dev, "bridge/bridge.js", "old\n");
  update(player);
  git(player, "switch", "-q", "-c", "agent-work");
  commit(dev, "bridge/bridge.js", "new\n");
  commit(dev, "addon/a.lua", "new\n");
  const hook = path.join(player, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf 'old\\n' > bridge/bridge.js\n", { mode: 0o755 });
  const first = update(player);
  assert.deepEqual(first.files, ["addon/a.lua"]);
  assert.match(first.note, /^partly updated: 1 file could not be replaced \(bridge\/bridge\.js\)/);
  fs.rmSync(hook);
  const second = update(player);
  assert.deepEqual([second.changed, second.files, second.note], [true, ["bridge/bridge.js"], "updated to the latest release (1 file changed)"]);
  assert.equal(read(player, "bridge/bridge.js"), "new\n");
  assert.equal(git(player, "status", "--porcelain"), "");
});

test("update: a file the release deletes but the checkout left is removed on the next run", (t) => {
  const { dev, player } = repos(t);
  commit(dev, "bridge/bridge.js", "old\n");
  update(player);
  git(dev, "rm", "-q", "bridge/bridge.js");
  git(dev, "commit", "-q", "-m", "rm");
  git(dev, "push", "-q");
  const hook = path.join(player, ".git", "hooks", "post-merge");
  fs.writeFileSync(hook, "#!/bin/sh\nmkdir -p bridge && printf 'old\\n' > bridge/bridge.js\n", { mode: 0o755 });
  const first = update(player);
  assert.deepEqual([first.changed, first.files], [false, []]);
  assert.match(first.note, /^partly updated: 1 file could not be replaced \(bridge\/bridge\.js\)/);
  fs.rmSync(hook);
  const second = update(player);
  assert.deepEqual([second.changed, second.files], [true, ["bridge/bridge.js"]]);
  assert.equal(fs.existsSync(path.join(player, "bridge", "bridge.js")), false);
});

test("update: a left-over file the player then edited is not replaced", (t) => {
  const { dev, player } = repos(t);
  commit(dev, "bridge/bridge.js", "old\n");
  update(player);
  git(player, "switch", "-q", "-c", "agent-work");
  commit(dev, "bridge/bridge.js", "new\n");
  const hook = path.join(player, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf 'old\\n' > bridge/bridge.js\n", { mode: 0o755 });
  update(player);
  fs.rmSync(hook);
  fs.writeFileSync(path.join(player, "bridge", "bridge.js"), "mine\n");
  const r = update(player);
  assert.match(r.note, /local edits/);
  assert.equal(read(player, "bridge/bridge.js"), "mine\n");
});

test("update: no local forever and two remotes that have one: forever is made from origin", (t) => {
  const { dev, player } = repos(t);
  git(player, "remote", "add", "upstream", git(player, "remote", "get-url", "origin"));
  git(player, "fetch", "-q", "upstream");
  git(player, "switch", "-q", "-c", "docs/no-console");
  git(player, "branch", "-q", "-D", "forever");
  commit(dev, "bridge/bridge.js", "x\n");
  const r = update(player);
  assert.equal(r.changed, true);
  assert.equal(git(player, "branch", "--show-current"), "forever");
  assert.equal(git(player, "rev-parse", "HEAD"), git(dev, "rev-parse", "HEAD"));
  assert.equal(git(player, "rev-parse", "--abbrev-ref", "forever@{upstream}"), "origin/forever");
});

test("update: another branch with local edits is not switched", (t) => {
  const { player } = repos(t);
  git(player, "switch", "-q", "-c", "agent-work");
  fs.writeFileSync(path.join(player, "README.md"), "edit\n");
  const r = update(player);
  assert.equal(git(player, "branch", "--show-current"), "agent-work");
  assert.match(r.note, /local edits/);
});

test("update: a folder that is not a git checkout is skipped", (t) => {
  const r = update(tmp(t));
  assert.equal(r.changed, false);
  assert.match(r.note, /not a git checkout/);
});

test("addonDiffers: missing or changed files count, the bridge-owned Inbox.lua does not", (t) => {
  const dir = tmp(t);
  const src = path.join(dir, "src");
  const dest = path.join(dir, "dest");
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(src, "Runback.lua"), "a");
  fs.writeFileSync(path.join(src, "Inbox.lua"), "repo");
  assert.equal(addonDiffers(src, dest), true, "missing file");
  fs.writeFileSync(path.join(dest, "Runback.lua"), "a");
  fs.writeFileSync(path.join(dest, "Inbox.lua"), "written by the bridge");
  assert.equal(addonDiffers(src, dest), false);
  fs.writeFileSync(path.join(src, "Runback.lua"), "b");
  assert.equal(addonDiffers(src, dest), true, "changed file");
});

test("slotsCreated reads install-slots output", () => {
  assert.equal(slotsCreated("addon : 21 file(s)\nslots: 200  files created: 15000  already present: 0\n"), 15000);
  assert.equal(slotsCreated("slots: 200  files created: 0  already present: 15003"), 0);
  assert.equal(slotsCreated(""), 0);
});

test("plan: the bridge starts, restarts on a bridge update, or is left alone", () => {
  const base = { gameRunning: false, addonChanged: false, newFiles: false };
  assert.equal(plan({ ...base, bridgeRunning: false, bridgeChanged: true }).bridge, "start");
  assert.equal(plan({ ...base, bridgeRunning: true, bridgeChanged: true }).bridge, "restart");
  assert.equal(plan({ ...base, bridgeRunning: true, bridgeChanged: false }).bridge, "keep");
});

test("plan: the game advice matches what changed", () => {
  const base = { bridgeRunning: true, bridgeChanged: false };
  assert.equal(plan({ ...base, gameRunning: false, addonChanged: true, newFiles: true }).game, "open");
  assert.equal(plan({ ...base, gameRunning: true, addonChanged: true, newFiles: true }).game, "relaunch");
  assert.equal(plan({ ...base, gameRunning: true, addonChanged: true, newFiles: false }).game, "reload");
  assert.equal(plan({ ...base, gameRunning: true, addonChanged: false, newFiles: false }).game, "ready");
  for (const k of ["open", "relaunch", "reload", "ready"]) assert.ok(GAME_TEXT[k]);
});

test("Runback.cmd is one line that exits before git pull can rewrite it", () => {
  // cmd.exe reads a batch file as it runs; if the update changed the rest of
  // the file, it would run whatever now sits at that offset. One line that ends
  // in exit /b is fully parsed before node starts.
  const s = fs.readFileSync(path.resolve(__dirname, "../../Runback.cmd"), "utf8");
  assert.equal(s.trim().split("\n").length, 1);
  assert.match(s, /^@node "%~dp0tools\\launch\.js" %\* \|\| pause & exit \/b\s*$/);
});

test("the bridge window starts supervisor.js by full path, so stop-bridge.ps1 can find it", () => {
  const s = fs.readFileSync(path.resolve(__dirname, "../../bridge/start-window.cmd"), "utf8");
  assert.match(s, /node "%~dp0supervisor\.js"/);
  const launch = fs.readFileSync(path.resolve(__dirname, "../../tools/launch.js"), "utf8");
  assert.match(launch, /path\.join\(bridgeDir, 'supervisor\.js'\)/);
});

test("stop-bridge.ps1 hands command lines to CommandLineToArgvW as Unicode", () => {
  const s = fs.readFileSync(path.resolve(__dirname, "../../bridge/stop-bridge.ps1"), "utf8");
  assert.match(s, /DllImport\("shell32\.dll"[^)]*CharSet = CharSet\.Unicode\)\]\s*public static extern IntPtr CommandLineToArgvW/);
});

test("the launcher never starts the game executable itself", () => {
  const launch = fs.readFileSync(path.resolve(__dirname, "../../tools/launch.js"), "utf8");
  // Only two things are started: the bridge window and the Battle.net app.
  const spawned = [...launch.matchAll(/\bspawn\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(spawned, ["'cmd.exe'", "exe"]);
  assert.match(launch, /const exe = [^;]*'Battle\.net Launcher\.exe'/s);
});

// The Windows-only parts, run for real on the Windows CI runner.
const WIN = { skip: process.platform !== "win32" && "Windows only" };

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return check();
}

test("Windows: the bridge window starts, is found by stop-bridge.ps1 -ListOnly, and stops", WIN, async (t) => {
  // A folder with spaces, like "AI Projects", and a stand-in supervisor.js.
  // realpath: the runner's TEMP is an 8.3 short path (RUNNER~1); a real
  // checkout path is a long one, as stop-bridge.ps1 compares them.
  const bridge = path.join(fs.realpathSync.native(tmp(t)), "wow ai copy", "bridge");
  fs.mkdirSync(bridge, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "../../bridge/stop-bridge.ps1"), path.join(bridge, "stop-bridge.ps1"));
  fs.writeFileSync(path.join(bridge, "supervisor.js"), "setInterval(() => {}, 1000);\n");
  t.after(() => launch.stopBridge(bridge));
  assert.equal(launch.bridgeRunning(bridge), false);
  launch.startBridge(bridge);
  const started = await waitFor(() => launch.bridgeRunning(bridge));
  const cmds = () => spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name = 'cmd.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" }).stdout;
  const nodes = () => spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" }).stdout;
  assert.equal(started, true, `started; bridge=${bridge}\nnode processes:\n${started ? "" : nodes()}`);
  launch.stopBridge(bridge);
  assert.equal(await waitFor(() => !launch.bridgeRunning(bridge)), true, "stopped");
  assert.ok(fs.existsSync(path.join(bridge, "KILLED")));
  // The "cmd /k" window went with it: nothing still runs with this folder in its command line.
  assert.doesNotMatch(nodes() + cmds(), new RegExp(bridge.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "i"));
});

test("Windows: gameRunning sees a running process by name", WIN, () => {
  assert.equal(launch.gameRunning("node"), true);
  assert.equal(launch.gameRunning("NoSuchGameHere"), false);
});

test("old WoW AI desktop shortcuts are removed when Runback.lnk is already there", (t) => {
  const desktop = path.join(tmp(t), "Desk");
  fs.mkdirSync(desktop);
  const mark = path.join(desktop, "mark");
  fs.writeFileSync(mark, "done\n");
  fs.writeFileSync(path.join(desktop, "Runback.lnk"), "runback");
  fs.writeFileSync(path.join(desktop, "WoW AI.lnk"), "old");
  fs.writeFileSync(path.join(desktop, "WoW AI.cmd"), "old");
  assert.equal(launch.makeShortcut({ desktop, mark }), null);
  assert.equal(fs.existsSync(path.join(desktop, "WoW AI.lnk")), false);
  assert.equal(fs.existsSync(path.join(desktop, "WoW AI.cmd")), false);
  assert.equal(fs.readFileSync(path.join(desktop, "Runback.lnk"), "utf8"), "runback");
});

test("shortcut icon is docs/assets/runback.ico when that file exists", (t) => {
  const root = tmp(t);
  assert.equal(launch.shortcutIconPath(root), null);
  const icon = path.join(root, "docs", "assets", "runback.ico");
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.writeFileSync(icon, "ico");
  assert.equal(launch.shortcutIconPath(root), icon);
  assert.equal(launch.shortcutIconPath(path.resolve(__dirname, "../..")), fs.existsSync(path.resolve(__dirname, "../../docs/assets/runback.ico")) ? path.resolve(__dirname, "../../docs/assets/runback.ico") : null);
});

test("a previous WoW AI shortcut is replaced by Runback when Runback.lnk is missing", () => {
  assert.equal(launch.shouldCreateShortcut(false, false, false), true);
  assert.equal(launch.shouldCreateShortcut(true, false, false), false);
  assert.equal(launch.shouldCreateShortcut(true, true, true), false);
  assert.equal(launch.shouldCreateShortcut(true, true, false), true);
});

test("Windows: the desktop shortcut points at Runback.cmd and is made only once", WIN, (t) => {
  const desktop = path.join(tmp(t), "Desk top");
  fs.mkdirSync(desktop);
  const mark = path.join(desktop, "mark");
  assert.equal(launch.makeShortcut({ desktop, mark }), desktop);
  const lnk = path.join(desktop, "Runback.lnk");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`], { encoding: "utf8" });
  assert.equal(r.stdout.trim().toLowerCase(), path.resolve(__dirname, "../../Runback.cmd").toLowerCase());
  fs.rmSync(lnk);
  assert.equal(launch.makeShortcut({ desktop, mark }), null, "a deleted shortcut stays deleted");
  assert.equal(fs.existsSync(lnk), false);
});
