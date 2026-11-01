#!/usr/bin/env node
'use strict';
// Runback bridge: the half of Runback that lives outside the game.
//
//   OUT  capture.ps1 screen-captures the addon's pixel strip -> one or more
//        {session, chat, id, cwd, flags, text} records per frame
//        (fallback: the game's SavedVariables file, written on /reload)
//   RUN  the chat's agent (Claude Code, Codex or Grok; see agents.js) headless
//        in the chat's folder, streaming progress. Each chat is its own agent
//        session; up to maxParallel run at once.
//   IN   we write the latest reply/status of every chat into every
//        Runback_S### slot addon (the game loads a fresh one from a timer),
//        flip a signal .wav per message, and also write Inbox.lua for the
//        reload path.
//
// Zero npm dependencies. Run with npm start or `node bridge.js`.
//   --once            handle one pending SavedVariables prompt and exit
//   --inject "text"   pretend the strip said this and exit when done
//   --agent <id>      agent for --inject (default: "agent" in config.json)
//   --project <dir>   default folder for chats that haven't picked one
//
// Like the agent CLIs themselves, the bridge works in the folder it was started
// from: `cd my-project && runback` makes my-project the default for every chat
// that hasn't chosen its own with /runback cd. Started from inside this repo (npm
// start), it falls back to defaultCwd in config.json.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const P = require('./protocol'); // the pure protocol code, unit-tested in tests/bridge_test.js
const G = require('./guide');    // leveling guides: validation and the channel, unit-tested in tests/guide_test.js and tests/guide_channel_test.js
const A = require('./agents');   // how each agent is launched and read, unit-tested in tests/agents_test.js
const Forever = require('./forever');
const { runAgentOnce: runAgent } = require('./forever/run-agent-once');

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, 'config.json');
const STATE_FILE = path.join(HERE, 'state.json');
const LOG_FILE = path.join(HERE, 'bridge.log');
const TMP_DIR = path.join(HERE, 'tmp'); // prompt files for agents that read the prompt from disk

const argv = process.argv.slice(2);
if (argv.includes('--on')) { try { fs.unlinkSync(path.join(HERE, 'KILLED')); } catch {} }
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('runback [--project <dir>] [--once] [--inject "text" [--cmd <name>] [--agent <id>] [--model <name>] [--effort <level>]]\n\n' +
    'Runs the Runback bridge. Chats without a folder of their own work in <dir>,\n' +
    'or in the folder you started it from, or in defaultCwd from bridge/config.json.\n' +
    `Agents: ${A.agentIds().join(', ')} (the default is "agent" in config.json; chats pick with /runback agent).`);
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) {
  console.error(`Cannot read ${CONFIG_FILE} (${e.message}).\nRun "node setup.js" in the runback folder first.`);
  process.exit(2); // the supervisor doesn't restart on 2
}
const once = argv.includes('--once');
const injectIdx = argv.indexOf('--inject');
const inject = injectIdx >= 0 ? argv[injectIdx + 1] : null;
const cmdIdx = argv.indexOf('--cmd');
const injectCmd = cmdIdx >= 0 ? argv[cmdIdx + 1] : '';
const agentIdx = argv.indexOf('--agent');
const injectAgent = agentIdx >= 0 ? argv[agentIdx + 1] : '';
const modelIdx = argv.indexOf('--model');
const injectModel = modelIdx >= 0 ? argv[modelIdx + 1] : '';
const effortIdx = argv.indexOf('--effort');
const injectEffort = effortIdx >= 0 ? argv[effortIdx + 1] : '';
const exitWhenIdle = once || inject !== null;

// The agent chats use unless they pick their own (/runback agent, "agent=" flag).
const DEFAULT_AGENT = A.normalizeAgent(cfg.agent || A.DEFAULT_AGENT);
if (!DEFAULT_AGENT) {
  console.error(`"agent": "${cfg.agent}" in ${CONFIG_FILE} is not one of ${A.agentIds().join(', ')}.`);
  process.exit(2);
}

// Default folder: --project, else WOW_AI_PROJECT, else the folder we were started
// from (unless that is this repo, i.e. npm start), else the configured one, else
// the mentor workspace. A broad start or configured folder (Documents, home, a
// drive root) is skipped: the agent would read unrelated files there.
const REPO = path.dirname(HERE);
function insideRepo(dir) {
  const rel = path.relative(REPO, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
cfg.forever = cfg.forever || {};
cfg.forever.mentorDir = path.resolve(cfg.forever.mentorDir || path.join(REPO, '..', 'wow-mentor'));
const projectIdx = argv.indexOf('--project');
const { dir: DEFAULT_CWD, source: DEFAULT_CWD_SOURCE } = P.pickDefaultCwd({
  project: projectIdx >= 0 ? argv[projectIdx + 1] : '',
  env: process.env.WOW_AI_PROJECT,
  started: insideRepo(process.cwd()) ? '' : process.cwd(),
  config: cfg.defaultCwd,
  mentorDir: cfg.forever.mentorDir,
});
// First run: the mentor workspace starts as a copy of the template in mentor/.
if (DEFAULT_CWD_SOURCE === 'mentor workspace' && !fs.existsSync(DEFAULT_CWD)) {
  try { fs.cpSync(path.join(REPO, 'mentor'), DEFAULT_CWD, { recursive: true }); }
  catch { fs.mkdirSync(DEFAULT_CWD, { recursive: true }); }
}
// Later runs: the coach's instructions follow the template (see syncPrompt).
const MentorGuard = require('./forever/modules/05-mentor-guard.js');
const MENTOR_PROMPT_UPDATED = MentorGuard.syncPrompt(path.join(REPO, 'mentor'), cfg.forever.mentorDir);
const BROAD_NOTE = dir => `${dir} is a broad folder, so chats are refused there. Start the bridge in a narrower folder or set defaultCwd in bridge/config.json.`;

const resolveCwd = raw => P.resolveCwd(raw, DEFAULT_CWD);
// Folders a chat may run in: the default folder (chosen at the terminal) and
// the player's allowedFolders list. Game text never adds to this.
const ALLOWED_FOLDERS = [DEFAULT_CWD, ...(Array.isArray(cfg.allowedFolders) ? cfg.allowedFolders.map(f => resolveCwd(f)) : [])];
const folderRefusal = (cwd, why) => why === 'broad'
  ? `${cwd} is a broad folder, so an agent there could read unrelated files. Pick a narrower one with /runback cd.`
  : `${cwd} is outside the folders this bridge allows. Folders: ${ALLOWED_FOLDERS.join(', ')}.\n` +
    `Add it to allowedFolders in bridge/config.json on the PC (then restart the bridge), or use /runback cd for a folder inside one of them.`;
const { sameFolder } = P;
// Subfolders of the default folder, for the "folder not found" hint.
function siblingFolders() {
  try {
    return fs.readdirSync(DEFAULT_CWD, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name).sort().slice(0, 30);
  } catch { return []; }
}

const SLOTS = cfg.slots || 200;
// #144: one publish writes the inbox and only the slots the addon can still
// read (it loads them in order and reports the last one on the strip), not all
// 200. 16 was measured to cover a reply's polls; tests/bridge_test.js holds
// the evidence.
const SLOT_WINDOW = Math.max(1, Math.min(cfg.slotWindow || 16, SLOTS));
let addonSlot = 0;     // last slot the addon reported loading; 0 = unknown, write all
let addonSlotAt = 0;   // when that report was read: the addon's poll clock starts there
let addonPollTail = 60; // its poll cadence after the first 5 minutes (60 s with the sound channel)
const MAX_PARALLEL = cfg.maxParallel || 3;
const cap = Object.assign({ enabled: true, processName: 'WowB', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 250 }, cfg.capture || {});
cfg.forever.clientDir = path.resolve(cfg.forever.clientDir || path.resolve(cfg.addonDir || '', '..', '..'));
cfg.forever.journal = Object.assign({ dir: path.join(cfg.forever.mentorDir, 'journal'), enabled: true }, cfg.forever.journal || {});
if (!cfg.forever.journal.dir) cfg.forever.journal.dir = path.join(cfg.forever.mentorDir, 'journal');
cfg.forever.screenshotsDir = cfg.forever.screenshotsDir || path.join(cfg.forever.clientDir, 'Screenshots');
cfg.forever.bulk = cfg.forever.bulk || {};
// The game-side files. A config.json written for the addon's old name
// (WoWClaude or WoWAI) still works: the paths are derived from addonDir instead.
const INBOX_FILE = cfg.inboxFile && !/WoWClaude|[\\/]WoWAI[\\/]/.test(cfg.inboxFile) ? cfg.inboxFile : path.join(cfg.addonDir || '', 'Runback', 'Inbox.lua');
const SAVED_VARS = String(cfg.savedVariablesFile || '').replace(/(WoWClaude|WoWAI)\.lua$/, 'Runback.lua');

let state = readJson(STATE_FILE, { lastId: 0, sessions: {}, handled: {} });
state.forever = state.forever || { bulk: {} };
state.forever.bulk = state.forever.bulk || {};
state.chatAgents = state.chatAgents || {};
if (!state.handled) state.handled = {};
if (!state.sessions) state.sessions = {};
// Older versions stored handled[session] as "highest id so far"; expand to a map.
for (const [k, v] of Object.entries(state.handled)) {
  if (typeof v === 'number') {
    const m = {};
    for (let i = 1; i <= v; i++) m[i] = 1;
    state.handled[k] = m;
  }
}

// Bridge-side transcripts. The beta client sometimes wipes addon saved data; since
// every prompt and reply passes through here, this copy lets the addon recover.
const TRANSCRIPT_FILE = path.join(HERE, 'transcripts.json');
let transcripts = readJson(TRANSCRIPT_FILE, { chats: {}, tokens: {} });
if (!transcripts.chats) transcripts.chats = {};
if (!transcripts.tokens) transcripts.tokens = {};
if (P.pruneStale(state, transcripts)) { saveState(); saveTranscripts(); }
let pendingRestore = null;
let stripSeenAt = 0;

function saveTranscripts() {
  try { atomicWrite(TRANSCRIPT_FILE, JSON.stringify(transcripts)); } catch (e) { log('could not save transcripts:', e.message); }
}

// Chats the player deleted in game while a run for them was still going: the
// run's late progress and reply must not recreate the transcript.
const forgotten = new Set();

function noteMessage(job, role, text) {
  if (!job.chat) return;
  if (role === 'user') forgotten.delete(job.chat);
  else if (forgotten.has(job.chat)) return;
  const c = transcripts.chats[job.chat] = transcripts.chats[job.chat] || { id: job.chat, name: '', cwd: job.cwd, messages: [] };
  if (job.name) c.name = job.name;
  if (job.cwd) c.cwd = job.cwd;
  const m = { role, text: String(text ?? '').slice(0, 4000), id: job.id, t: Math.floor(Date.now() / 1000) };
  if (role === 'assistant' && job.agent) m.agent = job.agent;
  c.messages.push(m);
  while (c.messages.length > 200) c.messages.shift();
  c.updated = Date.now();
  saveTranscripts();
}

// First message from an addon session token we haven't seen: its saved data is
// fresh (or reset), so offer everything we know once, in the next publish.
function maybeOfferRestore(job) {
  if (!job.session || transcripts.tokens[job.session]) return;
  transcripts.tokens[job.session] = Date.now();
  const chats = Object.values(transcripts.chats)
    .filter(c => c.id !== job.chat && c.messages.length)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 16)
    .map(c => ({ id: c.id, name: c.name, cwd: c.cwd, messages: c.messages.slice(-40).map(m => ({ ...m, text: m.text.slice(0, 2000) })) }));
  saveTranscripts();
  if (chats.length) {
    pendingRestore = { token: job.session, chats };
    log(`new addon session ${job.session}: offering ${chats.length} chat(s) to restore`);
  }
}

// The player deleted a chat in game. Drop everything we keep for it, so the next
// restore doesn't bring it back and its id can't resume the old agent session.
function forgetChat(job) {
  if (!job.chat) return;
  const had = !!transcripts.chats[job.chat];
  delete transcripts.chats[job.chat];
  forgotten.add(job.chat);
  delete state.sessions[sessKey(job)];
  delete state.sessions[chatKey(job)];
  if (state.sessionCwd) delete state.sessionCwd[sessKey(job)];
  if (state.sessionAgent) delete state.sessionAgent[sessKey(job)];
  if (pendingRestore) pendingRestore.chats = pendingRestore.chats.filter(c => c.id !== job.chat);
  saveTranscripts();
  log(`#${job.id}${job.session ? '@' + job.session : ''} forgot chat ${job.chat}${had ? '' : ' (nothing stored)'}`);
}

let lastMtime = 0;
const running = new Map(); // chatKey -> { job, child }
const owned = new Set(); // session#id of jobs a Forever module is handling
const queued = new Map();  // chatKey -> job waiting for that chat (or for a free parallel slot)
const live = new Map();    // chatKey -> latest record shown to the game
let lastPublish = 0;
let publishTimer = null;
let captureProcess = null;
let captureStopped = false;
let captureRestart = null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveState() {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const { pad3, chatKey, sessKey, SILENT_WAV, jobsFromStrip } = P;
const slotNumber = id => P.slotNumber(id, SLOTS);
const alreadyHandled = job => P.alreadyHandled(state, job);
const markHandled = job => P.markHandled(state, job);

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Stop a run and whatever it spawned (an npm launcher runs the real binary as a
// child of its own; on Windows a plain kill would leave that one going).
function killTree(child) {
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch {} });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

// ---------------------------------------------------------------------------
// What the game reads
// ---------------------------------------------------------------------------

// Map layers the agent drew (see protocol.js, "Map layers"). The bridge is the source of
// truth; slot files carry the whole set while the game may not have it yet: for a
// while after it changes, and after every hello (a fresh or wiped client).
if (!state.map) state.map = P.newMap();
const MAP_DIR = path.join(HERE, 'mapjobs');
// Every publish rewrites all slot files, so the map rides along only for a short
// while, and on progress publishes only while it is small.
const MAP_SHARE_MS = 3 * 60 * 1000;
const MAP_PROGRESS_MAX = 20000;
let mapShareUntil = Object.keys(state.map.layers).length ? Date.now() + MAP_SHARE_MS : 0;
let mapLuaCache = { version: -1, epoch: '', text: '' };
function mapLuaSize() {
  if (mapLuaCache.version !== state.map.version || mapLuaCache.epoch !== state.map.epoch) {
    mapLuaCache = { version: state.map.version, epoch: state.map.epoch, text: P.luaMap(state.map) };
  }
  return mapLuaCache.text.length;
}

function mapFileFor(job) {
  return path.join(MAP_DIR, `${String(job.chat || 'default').replace(/[^\w-]/g, '_')}-${job.id}.jsonl`);
}

// Collect what the run asked for (its map file, then ```wowmap blocks in its
// reply), apply it, and return the reply text without the blocks plus a note
// for the reply, if anything was asked.
function takeMapCommands(job, text) {
  const file = mapFileFor(job);
  let cmds = [], errors = [];
  try {
    const r = P.parseMapFile(fs.readFileSync(file, 'utf8'));
    cmds = r.cmds; errors = r.errors;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  const blocks = P.extractMapBlocks(text);
  cmds.push(...blocks.cmds);
  errors.push(...blocks.errors);
  if (!cmds.length && !errors.length) return { text: blocks.text, note: '' };
  const { changed, notes, marked, cleared } = P.applyMapCommands(state.map, cmds);
  if (changed) { saveState(); mapShareUntil = Date.now() + MAP_SHARE_MS; }
  const all = [...notes, ...errors];
  log(`#${job.id} map: ${all.join('; ') || 'no change'} (version ${state.map.version})`);
  // The details stay in the log; the player reads one plain line.
  return { text: blocks.text, note: P.mapNote({ marked, cleared, errors: errors.length }) };
}

// Leveling guides the agent wrote (see guide.js, "Guide channel"): kept in state.json
// and shipped like the map layers, in the slot files with a version.
if (!state.guides) state.guides = G.newGuides();
const GUIDE_DIR = path.join(HERE, 'guidejobs');
let guideShareUntil = state.guides.guides.length ? Date.now() + MAP_SHARE_MS : 0;
let guideLuaCache = { version: -1, epoch: '', text: '' };
function guideLuaSize() {
  if (guideLuaCache.version !== state.guides.version || guideLuaCache.epoch !== state.guides.epoch) {
    guideLuaCache = { version: state.guides.version, epoch: state.guides.epoch, text: P.luaGuides(state.guides) };
  }
  return guideLuaCache.text.length;
}

function guideFileFor(job) {
  return path.join(GUIDE_DIR, `${String(job.chat || 'default').replace(/[^\w-]/g, '_')}-${job.id}.json`);
}

// Collect what the run wrote (its guide file, then ```wowguide blocks in its
// reply), validate and keep it, and return the reply text without the blocks plus
// one plain note, if a guide was offered.
function takeGuides(job, text) {
  const file = guideFileFor(job);
  let raw = [], errors = [];
  try {
    const r = G.readGuideFile(fs.readFileSync(file, 'utf8'));
    raw = r.raw; errors = r.errors;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  const blocks = G.extractGuideBlocks(text);
  raw.push(...blocks.raw);
  errors.push(...blocks.errors);
  if (!raw.length && !errors.length) return { text: blocks.text, note: '' };
  const { changed, notes, titles, stored } = G.applyGuides(state.guides, raw);
  if (changed) { saveState(); guideShareUntil = Date.now() + MAP_SHARE_MS; }
  log(`#${job.id} guide: ${[...notes, ...errors].join('; ') || 'no change'} (version ${state.guides.version})`);
  // A guide already held and sent again is still stored, so it is not a failure.
  return { text: blocks.text, note: G.guideNote({ titles, failed: !stored }) };
}

// Slot file / Inbox.lua body: see protocol.luaTable.
function slotFile(globalName, records, urgent = true) {
  const map = Date.now() < mapShareUntil && (urgent || mapLuaSize() <= MAP_PROGRESS_MAX) ? state.map : null;
  const guides = Date.now() < guideShareUntil && (urgent || guideLuaSize() <= MAP_PROGRESS_MAX) ? state.guides : null;
  const { agents, models, efforts, defaults } = pools();
  return P.luaTable(globalName, records, { cwd: DEFAULT_CWD, restore: pendingRestore, agent: DEFAULT_AGENT, agents, models, efforts, defaults, map, guides, card: state.forever.card });
}

// What the in-game picker offers: the agents installed on this PC (all of them
// when none is, so a chat still gets the "not installed" hint) and the models
// each can switch to, with the effort levels each model takes. Looked up again at most once a minute, so an agent
// installed while the bridge runs shows up without a restart.
let poolsCache = null;
function pools() {
  if (poolsCache && Date.now() - poolsCache.at < 60000) return poolsCache;
  const found = A.agentIds().filter(id => A.resolveCommand(id, A.agentConfig(cfg, id)).found);
  const agents = found.length ? found : A.agentIds();
  const models = {};
  const efforts = {};
  const defaults = {};
  for (const id of agents) {
    const acfg = A.agentConfig(cfg, id);
    models[id] = A.modelChoices(acfg, id);
    const levels = A.modelLevels(acfg, id);
    if (Object.keys(levels.efforts).length) efforts[id] = levels.efforts;
    if (Object.keys(levels.defaults).length) defaults[id] = levels.defaults;
  }
  poolsCache = { at: Date.now(), agents, models, efforts, defaults };
  return poolsCache;
}

function addonInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'Runback', 'Runback.toc'));
}

function slotsInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'Runback_S001', 'Inbox.lua'));
}

// The game will load *some* unused slot next, so the slots it can still reach
// carry the full picture, and every slot when the bridge does not know which
// one is next. A missing addon folder (not installed yet, or the game folder
// moved) must not take the bridge down: capture and agent runs keep working,
// and the game just won't see replies until `node setup.js` has run and WoW was
// restarted.
let warnedNoAddon = false;

// The addon reports the last slot it loaded on the strip. A lower number than
// before is a new slot pool (/reload, or a client restart the bridge did not
// see), so every slot is written again before the next poll.
function noteAddonSlot(n, tail) {
  if (!Number.isInteger(n) || n < 0) return;
  if (tail === 60 || tail === 120) addonPollTail = tail;
  const reset = n === 0 || (addonSlot > 0 && n < addonSlot);
  addonSlot = reset ? 0 : n;
  addonSlotAt = Date.now();
  if (reset && n > 0) publishNow();
}

// The last slot the addon has loaded by now. The strip only carries its slot
// number while a message is unacknowledged; after that it keeps loading one slot
// per poll while a reply is pending, so the window has to follow that clock or it
// stops at the number from send time (a run longer than the window then loses its
// reply). No run, no polls: the addon spends no slot while it waits for nothing.
function addonSlotNow(now = Date.now()) {
  if (!addonSlot) return 0;
  if (!running.size) return addonSlot;
  return addonSlot + P.slotPolls(now - addonSlotAt, addonPollTail);
}

// Slot files are the largest thing a publish writes: write only the ones the
// addon can still load (#144).
function writeSlots(body) {
  for (const i of P.slotTargets(addonSlotNow(), SLOTS, SLOT_WINDOW)) {
    try { atomicWrite(path.join(cfg.addonDir, 'Runback_S' + pad3(i), 'Inbox.lua'), body); } catch {}
  }
}

function publishNow(urgent = true) {
  lastPublish = Date.now();
  const records = [...live.values()].slice(-30);
  try {
    atomicWrite(INBOX_FILE, slotFile('Runback_Inbox', records, urgent));
  } catch (e) {
    if (!warnedNoAddon) {
      warnedNoAddon = true;
      log(`publish: cannot write ${INBOX_FILE} (${e.code || e.message}); addon not installed? run: node setup.js, then restart WoW`);
    }
    return;
  }
  if (!slotsInstalled()) return;
  writeSlots(slotFile('Runback_SlotData', records, urgent));
  // The restore bundle is large; it rides along once and is then dropped.
  // (The game keeps loading fresh slots until it has read one carrying it.)
  if (pendingRestore) { pendingRestore.published = (pendingRestore.published || 0) + 1; if (pendingRestore.published >= 3) pendingRestore = null; }
}

// Final results publish immediately; progress is throttled. `key` is the chat
// (record.session is the agent's session id, a different thing).
function publish(key, record, urgent) {
  live.set(key, record);
  if (urgent) { if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; } publishNow(); return; }
  const wait = (cfg.progressWriteMs || 3000) - (Date.now() - lastPublish);
  if (wait <= 0) publishNow(false);
  else if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publishNow(false); }, wait);
}

function signal(kind, id, on) {
  const slot = slotNumber(id);
  if (slot == null) return;
  const file = path.join(cfg.addonDir, 'Runback', kind, pad3(slot) + '.wav');
  try { atomicWrite(file, on ? SILENT_WAV : Buffer.alloc(0)); } catch {}
}

// Heartbeat: act/NNN/kk.wav flips valid for the k-th action of message NNN. The
// game polls the next one for free, so it can show "12 actions, last one 5 s ago"
// without spending a reply slot.
const ACT_MAX = cfg.actMax || 60;
function actFile(id, k) {
  const slot = slotNumber(id);
  if (slot == null) return null;
  return path.join(cfg.addonDir, 'Runback', 'act', pad3(slot), String(k).padStart(2, '0') + '.wav');
}
function resetBeats(id) {
  for (let k = 1; k <= ACT_MAX; k++) {
    const file = actFile(id, k);
    if (file == null) return;
    try { atomicWrite(file, Buffer.alloc(0)); } catch {}
  }
}
function beat(job) {
  job.beats = (job.beats || 0) + 1;
  if (job.beats > ACT_MAX) return;
  const file = actFile(job.id, job.beats);
  if (file == null) return;
  try { atomicWrite(file, SILENT_WAV); } catch {}
}

// Presence: every 30 s flip the next presence/NNNN.wav valid so the game can tell
// the bridge is alive without spending a slot. The counter persists across
// restarts so a filename is never reused while the game is still running; the
// files just ahead of the counter are kept empty so the game can't run ahead.
const PRESENCE_MAX = cfg.presenceMax || 2000;
function presenceFile(k) {
  return path.join(cfg.addonDir, 'Runback', 'presence', String(k).padStart(4, '0') + '.wav');
}
function presenceBeat() {
  if (!fs.existsSync(path.join(cfg.addonDir, 'Runback', 'presence'))) return;
  state.presence = ((state.presence || 0) % PRESENCE_MAX) + 1;
  const k = state.presence;
  try { atomicWrite(presenceFile(k), SILENT_WAV); } catch {}
  for (let j = 1; j <= 50; j++) {
    const n = ((k - 1 + j) % PRESENCE_MAX) + 1;
    try { atomicWrite(presenceFile(n), Buffer.alloc(0)); } catch {}
  }
  saveState();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// The reload path: the addon writes its outbox into SavedVariables on /reload.
function readOutbox() {
  let src;
  try { src = fs.readFileSync(SAVED_VARS, 'utf8'); } catch { return null; }
  return P.parseOutbox(src);
}

// The addon sends the player's in-game context (character, location, ...) with
// its hello and again whenever it changes; an empty one means "context off".
// It is kept in state.json so a restarted bridge still has it, and goes into
// the agent's system prompt on every run (see protocol.systemPrompt).
function setContext(job) {
  const text = String(job.ctx || '').replace(/\r/g, '').trim().slice(0, 2000);
  const prev = (state.context && state.context.text) || '';
  if (text === prev) return;
  state.context = text ? { text, at: Date.now(), session: job.session || '' } : null;
  saveState();
  const who = (text.split('\n').find(l => /^Character:/i.test(l)) || text.split('\n')[0] || '').slice(0, 100);
  log(`#${job.id}${job.session ? '@' + job.session : ''} game context ${text ? 'updated: ' + who : 'cleared'}`);
}

function gameContext() {
  if (cfg.gameContext === false) return '';
  return (state.context && state.context.text) || '';
}

// The addon/macro primer that goes into the system prompt with the context.
// Read on every run so edits count without a restart; "" in the config turns
// it off. Relative paths are taken from the repo (docs/WOW-ADDON-PRIMER.md).
const PRIMER_FILE = cfg.primerFile === undefined ? 'docs/WOW-ADDON-PRIMER.md' : cfg.primerFile;
let warnedNoPrimer = false;
function primer() {
  if (!PRIMER_FILE) return '';
  const file = path.resolve(REPO, PRIMER_FILE);
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!warnedNoPrimer) { warnedNoPrimer = true; log(`primer: cannot read ${file} (${e.code || e.message}); running without it`); }
    return '';
  }
}

// Run an agent without this bridge's chat/session/transcript bookkeeping.
const onceChildren = new Set(); // agents started by runAgentOnce (council, journal)

// Stop every agent this bridge started (the kill switch).
function stopRunning() {
  for (const { child } of running.values()) if (child) killTree(child);
  for (const child of onceChildren) killTree(child);
}

function runAgentOnce(options) {
  // The kill switch covers one-off runs too (the journal starts them without a job).
  if (fs.existsSync(path.join(HERE, 'KILLED'))) return Promise.resolve({ status: 'error', text: 'AI is off.', elapsedMs: 0 });
  const started = Date.now();
  Forever.onRun({ job: { chat: options.chat || 'council', cwd: options.cwd, text: options.prompt }, agentId: options.agentId,
    cwd: options.cwd, prompt: String(options.prompt || ''), promptBytes: Buffer.byteLength(String(options.prompt || '')) });
  const onSpawn = child => { onceChildren.add(child); child.on('close', () => onceChildren.delete(child)); };
  return runAgent(options, { A, P, cfg, killTree, onSpawn, augment: (job, info) => Forever.augment(job, info),
    allowedFolders: ALLOWED_FOLDERS, mentorDir: cfg.forever.mentorDir }).then(result => { result.elapsedMs = Date.now() - started; return result; });
}

// ---------------------------------------------------------------------------
// Running an agent
// ---------------------------------------------------------------------------

function submit(job) {
  if (job.slot >= 0) noteAddonSlot(job.slot, job.pollTail);
  job.cwd = resolveCwd(job.cwd);
  if (job.agent) state.chatAgents[job.chat] = job.agent;
  job.agent = job.agent || state.chatAgents[job.chat] || DEFAULT_AGENT;
  if (alreadyHandled(job)) return;
  if (job.ctx !== undefined) setContext(job);
  if (job.forget) {
    // A deleted chat: forget it and ack. No agent run.
    markHandled(job);
    forgetChat(job);
    saveState();
    signal('ack', job.id, true);
    return;
  }
  if (job.stop) {
    // The Stop button (or Ask Claude instead): end this chat's run, drop a queued one.
    markHandled(job);
    stopChat(chatKey(job));
    saveState();
    signal('ack', job.id, true);
    return;
  }
  if (job.hello) {
    // The addon announcing itself: ack, offer a restore if its data is fresh,
    // and refresh the slots so it can read our clock. No agent run.
    markHandled(job);
    saveState();
    signal('ack', job.id, true);
    maybeOfferRestore(job);
    // Even an empty set: a client holding layers from a reset bridge must drop them.
    mapShareUntil = Date.now() + MAP_SHARE_MS;
    guideShareUntil = Date.now() + MAP_SHARE_MS;
    publishNow();
    log(`hello from session ${job.session}${pendingRestore ? ' (restore offered)' : ''}`);
    return;
  }
  // No module may claim a job in a folder the PC did not allow: council, review
  // and the rest start their own agents outside runJob.
  const folderWhy = P.folderProblem(job.cwd, ALLOWED_FOLDERS);
  if (folderWhy) {
    log(`#${job.id}${job.session ? '@' + job.session : ''} refused folder (${folderWhy}): ${job.cwd}`);
    finish(job, 'error', folderRefusal(job.cwd, folderWhy));
    return;
  }
  // A module owns this job until finish() marks it handled: the strip and the
  // reload outbox keep showing it meanwhile, and it must not start twice.
  const owner = `${job.session || ''}#${job.id}`;
  if (owned.has(owner)) return;
  // Ack even a job the module already finished, so the addon stops re-sending it.
  const claim = () => { if (!job.finished) owned.add(owner); signal('ack', job.id, true); };
  let ownership;
  try { ownership = Forever.intercept(job); } catch (e) { log('forever intercept failed:', e.message); }
  if (ownership && typeof ownership.then === 'function') {
    owned.add(owner);
    ownership.then(yes => { if (yes) claim(); else { owned.delete(owner); queueJob(job); } },
      e => { log('forever intercept failed:', e.message); owned.delete(owner); queueJob(job); });
    return;
  }
  if (ownership) { claim(); return; }
  queueJob(job);
}

// End one chat's run (the child dies, close handler reports it) and forget a queued one.
function stopChat(key) {
  queued.delete(key);
  const cur = running.get(key);
  if (!cur || !cur.child) return;
  cur.job.stopped = true;
  log(`#${cur.job.id} stopped from the game`);
  killTree(cur.child);
}

function queueJob(job) {
  // Defence in depth for backlog 55: the addon keeps "/" lines local; one that
  // still arrives gets a plain line back and no agent run.
  if (!job.cmd && P.isSlashLine(job.text)) {
    signal('ack', job.id, true);
    finish(job, 'done', P.SLASH_REFUSAL, job.session || '', []);
    return;
  }
  const key = chatKey(job);
  const cur = running.get(key);
  if (cur && cur.job.id === job.id) return;
  const q = queued.get(key);
  if (q && q.id === job.id) return;
  if (cur || running.size >= MAX_PARALLEL) {
    queued.set(key, job);
    log(`#${job.id}${job.session ? '@' + job.session : ''} queued (${cur ? 'chat busy' : running.size + ' running'})`);
    return;
  }
  runJob(job);
}

function drainQueue() {
  for (const [key, job] of queued) {
    if (running.size >= MAX_PARALLEL) break;
    if (running.has(key)) continue;
    queued.delete(key);
    runJob(job);
  }
}

function runJob(job) {
  const key = chatKey(job);
  const cwd = resolveCwd(job.cwd);
  job.cwd = cwd;
  job.startedAt = Date.now();
  const tag = `#${job.id}${job.session ? '@' + job.session : ''}`;
  signal('sig', job.id, false);
  resetBeats(job.id);
  signal('ack', job.id, true);
  if (!fs.existsSync(cwd)) {
    log(`${tag} cwd does not exist: ${cwd}`);
    const sibs = siblingFolders();
    finish(job, 'error', `Folder does not exist: ${cwd}\n` +
      `Paths are relative to ${DEFAULT_CWD}.` +
      (sibs.length ? `\nFolders there: ${sibs.join(', ')}` : '') +
      `\nUse /runback cd <folder> to pick one, or /runback cd alone for the default.`);
    return;
  }
  const folderWhy = P.folderProblem(cwd, ALLOWED_FOLDERS);
  if (folderWhy) {
    log(`${tag} refused folder (${folderWhy}): ${cwd}`);
    finish(job, 'error', folderRefusal(cwd, folderWhy));
    return;
  }
  // Which agent: the chat's own (an "agent=" flag), else the bridge's default.
  const agentId = job.agent ? A.normalizeAgent(job.agent) : DEFAULT_AGENT;
  if (!agentId) {
    log(`${tag} unknown agent "${job.agent}"`);
    finish(job, 'error', `Unknown agent "${job.agent}". This bridge knows: ${A.agentIds().join(', ')}.\n` +
      `Use /runback agent <name> to pick one, or /runback agent alone for the default (${DEFAULT_AGENT}).`);
    return;
  }
  job.agent = agentId;
  const agent = A.AGENTS[agentId];
  // Hermes can't run in the mentor folder: the guard has no tool limit for it
  // (05-mentor-guard.js sets only --in), so game text could reach its tools.
  const mentorRefusal = MentorGuard.refusal(agentId, cwd, cfg.forever.mentorDir);
  if (mentorRefusal) {
    log(`${tag} mentor job refused on ${agentId}`);
    finish(job, 'error', mentorRefusal);
    return;
  }
  // A translate job runs with every tool off (other players' text must never
  // reach a tool), so an agent without that switch is refused.
  const noTools = job.cmd === 'translate';
  if (noTools && !agent.toolFree) {
    log(`${tag} translate job refused on ${agentId}: no tool limit`);
    finish(job, 'error', `${agent.name} cannot run the translator: it has no way to turn its tools off, and other players' text must never reach a tool. Switch this chat to ${A.toolFreeAgentNames()} with /runback agent.`);
    return;
  }
  let acfg = A.agentConfig(cfg, agentId);
  // The chat's model (a "model=" flag), if it is one this agent offers. A model
  // change keeps the session: the conversation carries on with the new model.
  if (job.model) {
    const choices = A.modelChoices(acfg, agentId);
    if (!choices.includes(job.model)) {
      log(`${tag} model "${job.model}" is not offered for ${agentId}`);
      finish(job, 'error', `${agent.name} has no model "${job.model}" here. Models: ${choices.join(', ') || 'only its default'}.\n` +
        `Pick one from the AI button under the chat, or add it to agents.${agentId}.models in config.json.`);
      return;
    }
    acfg = { ...acfg, model: job.model };
  }
  // The chat's reasoning level (an "effort=" flag): only a level the catalog lists for
  // this model, and only for an agent whose CLI takes one from here. No level, no flag.
  if (job.effort) {
    const why = A.effortProblem(agentId, acfg, job.effort);
    if (why) {
      log(`${tag} effort "${job.effort}" refused for ${agentId}: ${why}`);
      finish(job, 'error', `${why}\nPick one from the AI button under the chat, or list the levels in agents.${agentId}.models in config.json.`);
      return;
    }
    acfg = { ...acfg, effort: job.effort };
  }
  // Outside the mentor workspace a chat reads files and nothing more: no command,
  // edit or write tool. The mentor guard restores the coach's working set inside
  // the workspace (forever/modules/05-mentor-guard.js). An agent with no way to
  // limit its tools does not run there at all.
  if (!P.folderInside(cwd, cfg.forever.mentorDir)) {
    if (agent.readOnly === false) {
      finish(job, 'error', `${agent.name} cannot be limited to read-only tools outside the mentor workspace. ` +
        `Use /runback agent to switch, or stay in the mentor workspace.`);
      return;
    }
    acfg = A.readOnlyConfig(acfg);
  }
  // A coach note (a fight review) runs on the agent's cheap model by default, so one
  // note per pull costs about nothing; agents.<id>.coachModel changes it. It outranks
  // the chat's pick, since a review is not the chat's own turn, and its level goes
  // with the model: the cheap model's own default applies. A chat that is not a
  // coach note keeps its model, and an agent with no cheap model keeps its own.
  const coach = job.cmd === 'review' ? A.coachModel(acfg, agentId) : '';
  if (coach && coach !== acfg.model) {
    acfg = { ...acfg, model: coach, effort: '' };
    log(`${tag} coach note on ${agentId} model ${coach}`);
  }
  const cmd = A.resolveCommand(agentId, acfg);
  if (!cmd.found) {
    log(`${tag} ${agentId} not found: ${cmd.note}`);
    finish(job, 'error', `${agent.name} is not installed on the bridge PC: ${cmd.note}.`);
    return;
  }
  const skey = sessKey(job);
  if (job.newSession) { delete state.sessions[skey]; delete state.sessions[key]; }
  // Agents keep sessions per project folder, and a session belongs to the agent
  // that made it, so a chat that changes either starts fresh.
  const prevCwd = state.sessionCwd && state.sessionCwd[skey];
  if (prevCwd && !sameFolder(prevCwd, cwd) && state.sessions[skey]) {
    log(`${tag} folder changed (${prevCwd} -> ${cwd}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  const prevAgent = (state.sessionAgent && state.sessionAgent[skey]) || 'claude';
  if (prevAgent !== agentId && state.sessions[skey]) {
    log(`${tag} agent changed (${prevAgent} -> ${agentId}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  maybeOfferRestore(job);
  noteMessage(job, 'user', job.text);
  const resume = state.sessions[skey] || state.sessions[key];

  const ctx = gameContext();
  const look = A.lookFor(agentId);
  const system = P.systemPrompt(ctx, primer(), look);
  const systemShort = P.systemPrompt(ctx, '', look);
  const promptFile = path.join(TMP_DIR, `prompt-${job.id}-${Date.now().toString(36)}.txt`);
  const input = agent.input({ prompt: job.text, system, systemShort, resume, images: job.images, cfg: acfg });
  if (input.promptFile !== undefined) {
    try { fs.mkdirSync(TMP_DIR, { recursive: true }); fs.writeFileSync(promptFile, input.promptFile); }
    catch (e) { finish(job, 'error', `Could not write the prompt file ${promptFile}: ${e.message}`); return; }
  }
  let args = [...cmd.args, ...agent.args({
    cfg: acfg, resume, cwd, system, systemShort, promptFile, images: job.images,
    prompt: job.text, timeoutMs: cfg.timeoutMs, noTools,
  })];
  const env = agent.env({ ...process.env });
  // Where this run's tools append map commands (docs/MAP.md); any agent can use it.
  try {
    fs.mkdirSync(MAP_DIR, { recursive: true });
    fs.rmSync(mapFileFor(job), { force: true });
    env.WOW_AI_MAP_FILE = mapFileFor(job);
  } catch (e) { log(`${tag} map file unavailable: ${e.message}`); }
  // Where this run writes a leveling guide (docs/GUIDE.md); any agent can use it.
  try {
    fs.mkdirSync(GUIDE_DIR, { recursive: true });
    fs.rmSync(guideFileFor(job), { force: true });
    env.WOW_AI_GUIDE_FILE = guideFileFor(job);
  } catch (e) { log(`${tag} guide file unavailable: ${e.message}`); }

  log(`${tag} (${job.via}) ${agent.name} starting in ${cwd}${resume ? ' (resume ' + resume.slice(0, 8) + ')' : ' (new session)'}${ctx ? ' [game context]' : ''}${running.size ? ' [' + (running.size + 1) + ' running]' : ''}`);
  const runInfo = { agentId, cwd, args, input, env };
  Forever.augment(job, runInfo);
  args = runInfo.args;
  const child = spawn(cmd.file, args, { cwd, env, windowsHide: true, stdio: [input.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  Forever.onRun({ job, agentId, cwd, args, prompt: String(input.stdin || job.text || ''), promptBytes: Buffer.byteLength(String(input.stdin || '')) });
  running.set(key, { job, child });
  publish(key, { chat: job.chat, id: job.id, status: 'working', text: resume ? 'thinking...' : 'starting a new session...', cwd, session: resume, agent: agentId }, true);
  if (input.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input.stdin); }

  const parser = agent.parser();
  const progress = [];
  let sessionId = resume || '';
  let result = null;       // { text, error } once the agent has produced its reply
  const denied = new Set(); // allowlist rules the run was refused (Claude syntax)
  const notes = [];        // bridge remarks appended to the reply
  let stderr = '';
  let buffer = '';
  let stdoutText = '';
  let parserError = false;

  let actionCount = 0;
  let lastActionAt = Date.now();
  let stallShown = '';
  // The working record, marked stalled once the run has been quiet or long enough.
  const publishWorking = () => {
    stallShown = P.stallReason(job.startedAt, lastActionAt, Date.now());
    publish(key, { chat: job.chat, id: job.id, status: 'working', text: progress.join('\n'), cwd, session: sessionId, agent: agentId, stall: stallShown }, false);
  };
  // The window lists at most three plain phrases; the heartbeat still counts every action.
  const pushProgress = (line, plain = false) => {
    P.addProgress(progress, line, plain);
    actionCount++;
    lastActionAt = Date.now();
    beat(job);
    publishWorking();
  };
  if (agent.stream === 'text') { pushProgress(`${agent.name} is working (no live progress)`, true); actionCount = 0; }
  if (input.note) notes.push(input.note);
  // Long thinking stretches produce no tool events; keep the heartbeat alive anyway.
  const keepalive = setInterval(() => beat(job), 45000);
  // Checked often enough that the offer lands within seconds of the threshold.
  const stallCheck = setInterval(() => {
    if (P.stallReason(job.startedAt, lastActionAt, Date.now()) !== stallShown) publishWorking();
  }, 10000);

  const handleLine = (line) => {
    if (parserError) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    let r;
    try {
      r = parser.feed(ev);
      if (!r || !Array.isArray(r.progress) || !Array.isArray(r.denied) || !Array.isArray(r.notes)) {
        throw new Error('agent parser returned an invalid event result');
      }
    } catch (err) {
      parserError = true;
      const detail = err instanceof Error ? err.message : String(err);
      result = { text: `${agent.name} returned an unreadable event.`, error: true };
      notes.push(`${agent.name} event parser failed: ${detail}`);
      log(`${tag} parser error: ${err && err.stack ? err.stack : detail}`);
      return;
    }
    if (r.session) sessionId = r.session;
    for (const p of r.progress) pushProgress(p);
    for (const d of r.denied) denied.add(d);
    notes.push(...r.notes);
    if (r.done) result = r.done;
  };

  child.stdout.on('data', (chunk) => {
    if (agent.stream === 'text') {
      stdoutText += chunk.toString('utf8');
      return;
    }
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const timer = setTimeout(() => {
    log(`${tag} timed out after ${cfg.timeoutMs} ms, killing`);
    killTree(child);
  }, cfg.timeoutMs || 1800000);

  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(keepalive);
    clearInterval(stallCheck);
    if (input.promptFile !== undefined) { try { fs.unlinkSync(promptFile); } catch {} }
  };

  child.on('error', (err) => {
    cleanup();
    finish(job, 'error', `Could not start ${agent.name} (${cmd.file}): ${err.message}\nSet agents.${agentId}.path in config.json.`);
  });

  child.on('close', (code) => {
    cleanup();
    if (agent.stream === 'text') {
      try {
        const r = parser.finish({ stdout: stdoutText, stderr, code });
        if (r && r.session) sessionId = r.session;
        if (r && r.done) result = r.done;
        if (r && Array.isArray(r.notes)) notes.push(...r.notes);
      } catch (err) {
        result = { text: `${agent.name} output parser failed: ${err.message}`, error: true };
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
    if (sessionId) {
      state.sessions[skey] = sessionId;
      (state.sessionCwd = state.sessionCwd || {})[skey] = cwd;
      (state.sessionAgent = state.sessionAgent || {})[skey] = agentId;
    }
    // Map marks count whatever the outcome: the tools already reported them.
    const mapped = takeMapCommands(job, result ? result.text : '');
    if (result) result.text = mapped.text;
    if (mapped.note) notes.push(mapped.note);
    const guided = takeGuides(job, result ? result.text : '');
    if (result) result.text = guided.text;
    if (guided.note) notes.push(guided.note);
    const shownNotes = P.replyNotes(notes);
    for (const n of notes) if (!shownNotes.includes(String(n).trim())) log(`${tag} note not shown to the player: ${n}`);
    const extra = shownNotes.length ? `\n\n${shownNotes.join('\n\n')}` : '';
    if (job.stopped) {
      finish(job, 'error', `${agent.name} was stopped.`, sessionId);
    } else if (result && !result.error) {
      // Raw combat-log quotes stay in the saved review; the player reads one plain evidence line each.
      const text = P.plainEvidence(String(result.text || '').trim());
      // No text and no map marks: say what the run did instead of leaving a blank.
      const silent = !text && !mapped.note && !guided.note;
      const body = silent ? P.noReplyText(agent.name, agent.stream === 'text' ? [] : progress, actionCount) : text;
      finish(job, 'done', (body + extra).trim(), sessionId, [...denied], silent ? 'noreply' : '');
    } else if (result) {
      finish(job, 'error', (String(result.text || '') + extra).trim(), sessionId, [...denied]);
    } else {
      finish(job, 'error', `${agent.name} exited with code ${code} and no result.\n${stderr.trim().slice(-1500)}`, sessionId);
    }
  });
}

function finish(job, status, text, session, denied, stall) {
  if (job.finished) return; // spawn failures fire both 'error' and 'close'
  Forever.onFinish(job, status, text);
  job.finished = true;
  owned.delete(`${job.session || ''}#${job.id}`);
  markHandled(job);
  saveState();
  // A finished reply ends with the "TL;DR:" block the system prompt asks for:
  // that part is what the game chat prints; the window gets the whole reply.
  let summary = '', followUps = [];
  if (status === 'done') {
    ({ text, followUps } = P.splitFollowUps(text));
    ({ text, summary } = P.splitSummary(text));
  }
  // A blocked run prints one short line in the game chat, whatever the agent wrote.
  if (denied && denied.length) summary = 'Needs your permission. Open the window and click How to allow.';
  noteMessage(job, status === 'done' ? 'assistant' : 'system', status === 'done' ? text : 'Bridge error: ' + text);
  publish(chatKey(job), { chat: job.chat, id: job.id, status, text, summary, followUps, cwd: job.cwd, session, denied, agent: job.agent || '', stall: stall || '' }, true);
  // After the final publish: the window of that publish follows the polls made
  // during the run (addonSlotNow reads `running`).
  running.delete(chatKey(job));
  // A module may finish a job the addon must not read a slot for (a card with
  // nothing to say): no sig flip, so no reply slot is spent.
  if (!job.noSignal) signal('sig', job.id, true);
  log(`#${job.id}${job.session ? '@' + job.session : ''} ${status} (${text.length} chars${summary ? ', summary ' + summary.length : ', no summary'})`);
  drainQueue();
  if (exitWhenIdle && running.size === 0) process.exit(status === 'done' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Input loops
// ---------------------------------------------------------------------------

function pollSavedVariables() {
  let st;
  try { st = fs.statSync(SAVED_VARS); } catch { return; }
  if (st.mtimeMs === lastMtime) return;
  const reloaded = lastMtime !== 0;
  lastMtime = st.mtimeMs;
  if (reloaded) {
    // The game wrote SavedVariables: /reload frees every reply slot, so the next
    // ones it loads are the first of the pool again (#144). Say everything again
    // in full, in case a finished reply is waiting there.
    addonSlot = 0;
    publishNow();
  }
  try { Forever.onSavedVariables(fs.readFileSync(SAVED_VARS, 'utf8')); } catch {}
  const job = readOutbox();
  if (job) submit(job);
}

// Windows: capture.ps1 (GDI). Elsewhere: capture_x11.py (the game runs under Wine on X11).
function captureCommand() {
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'capture.ps1'),
      '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
      '-IntervalMs', String(cap.intervalMs), '-ProcessName', cap.processName]];
  }
  const args = [path.join(HERE, 'capture_x11.py'),
    '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
    '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
  if (cap.windowName) args.push('--window-name', cap.windowName);
  if (cap.keepComposited) args.push('--keep-composited');
  return [cap.python || 'python3', args];
}

function startCapture() {
  if (!cap.enabled) return;
  captureStopped = false;
  if (captureProcess) return;
  const [cmd, args] = captureCommand();
  const ps = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  captureProcess = ps;
  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.info) { log('capture:', ev.info); return; }
    if (ev.warn) { log('capture:', ev.warn); return; }
    if (ev.error) { log('capture error:', ev.error); return; }
    if (typeof ev.id === 'number') {
      stripSeenAt = Date.now();
      const jobs = jobsFromStrip(ev.id, ev.text);
      log(`strip #${ev.id}: ${jobs.length} message(s)`);
      for (const job of jobs) submit(job);
    }
  });
  ps.stderr.on('data', (d) => log('capture stderr:', String(d).trim().slice(0, 300)));
  ps.on('error', (err) => log(`capture could not start (${cmd}): ${err.message}`));
  ps.on('close', (code) => {
    if (captureProcess === ps) captureProcess = null;
    if (captureStopped) return;
    log(`capture exited (${code}); restarting in 5 s`);
    captureRestart = setTimeout(startCapture, 5000);
  });
}

function stopCapture() {
  captureStopped = true;
  if (captureRestart) { clearTimeout(captureRestart); captureRestart = null; }
  if (captureProcess) { const child = captureProcess; captureProcess = null; child.kill(); }
}

function captureRunning() { return !!captureProcess && !captureStopped; }

function agentLine(id) {
  const acfg = A.agentConfig(cfg, id);
  const cmd = A.resolveCommand(id, acfg);
  if (!cmd.found) return `not found - ${cmd.note}`;
  const where = cmd.args.length ? `${cmd.file} ${cmd.args.join(' ')}` : cmd.file;
  const rules = Array.isArray(acfg.allowedTools) ? acfg.allowedTools.length : 0;
  return `${where}  [${acfg.permissionMode || 'acceptEdits'}${id === 'codex' ? '' : ', ' + rules + ' allowed tool rules'}${acfg.model ? ', model ' + acfg.model : ''}]`;
}

function banner() {
  console.log('Runback bridge');
  console.log(`  folder   : ${DEFAULT_CWD}  (${DEFAULT_CWD_SOURCE}; chats can override with /runback cd)`);
  if (MENTOR_PROMPT_UPDATED) console.log('  mentor   : the workspace AGENTS.md was updated from the template (old copy: AGENTS.md.bak)');
  if (P.isBroadFolder(DEFAULT_CWD)) console.log(`  WARNING  : ${BROAD_NOTE(DEFAULT_CWD)}`);
  console.log(`  addons   : ${cfg.addonDir}`);
  console.log(`  addon    : ${addonInstalled() ? 'installed' : 'NOT INSTALLED - run: node setup.js, then restart WoW'}`);
  console.log(`  slots    : ${slotsInstalled() ? SLOTS + ' installed' : 'NOT INSTALLED - run: node setup.js (or node bridge/install-slots.js), then restart WoW'}`);
  console.log(`  capture  : ${cap.enabled ? 'on (' + cap.processName + ', ' + cap.cellsPerRow + 'x' + cap.maxRows + ' cells of ' + cap.cellPx + 'px)' : 'off'}`);
  console.log(`  parallel : up to ${MAX_PARALLEL} chats at once`);
  console.log(`  fallback : ${SAVED_VARS}`);
  console.log(`  agent    : ${DEFAULT_AGENT} (default; chats pick their own with /runback agent)`);
  for (const id of A.agentIds()) console.log(`  ${id.padEnd(9)}: ${agentLine(id)}`);
  console.log(`  sessions : ${Object.keys(state.sessions).length} saved`);
  const ctx = gameContext();
  console.log(`  context  : ${cfg.gameContext === false ? 'off (gameContext in config.json)' : ctx ? (ctx.split('\n').find(l => /^Character:/i.test(l)) || ctx.split('\n')[0]).slice(0, 100) : 'none yet (the addon sends it with its hello; /runback context in game)'}`);
  console.log(`  primer   : ${!PRIMER_FILE ? 'off (primerFile in config.json)' : primer() ? path.resolve(REPO, PRIMER_FILE) + ' (' + primer().length + ' chars, with the context)' : 'NOT FOUND: ' + path.resolve(REPO, PRIMER_FILE)}`);
  console.log('Leave this window open while you play. Ctrl+C to stop.\n');
}

banner();
Forever.load(path.join(HERE, 'forever', 'modules'), cfg.forever && cfg.forever.disabled || []);
Forever.init({ cfg, log, HERE, REPO, SAVED_VARS, state, saveState, atomicWrite, submit, finish, publish, chatKey, runAgentOnce,
  lastStripSeenAt: () => stripSeenAt,
  capture: { stop: stopCapture, start: startCapture, running: captureRunning }, stopRunning,
  transcript: chat => {
    const messages = transcripts.chats[chat] && transcripts.chats[chat].messages || [];
    const last = [...messages].reverse().find(m => m.role === 'assistant');
    return last ? (P.splitSummary(last.text).summary || last.text || '') : '';
  } });
process.on('exit', () => Forever.stop());
if (inject !== null) {
  submit({ id: state.lastId + 1, session: '', chat: '', text: inject, cwd: '', newSession: false, via: 'inject', cmd: injectCmd || '', agent: injectAgent || '', model: injectModel || '', effort: injectEffort || '' });
} else {
  pollSavedVariables();
  if (once) {
    if (running.size === 0) { console.log('nothing pending'); process.exit(0); }
  } else {
    setInterval(pollSavedVariables, cfg.pollMs || 750);
    presenceBeat();
    setInterval(presenceBeat, cfg.presenceIntervalMs || 30000);
    if (cap.enabled && !fs.existsSync(path.join(HERE, 'KILLED'))) startCapture();
  }
}
