'use strict';
// The between-pull coach card (#140): the checks are counted from the game's own
// log file. These tests use the synthetic fixture tests/fixtures/dryrun (no real
// Forever log exists yet), and no log at all for the "no card" path.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require('../../tools/coach-card');

const LOGS = path.join(__dirname, '..', 'fixtures', 'dryrun', 'Logs');
const PLAYER = 'Brakka-Testrealm';
const START = Date.parse('2026-09-25T20:00:10');
const END = Date.parse('2026-09-25T20:00:43');
const CTX = [
  'Game: World of Warcraft: Forever (client 1.60.1, interface 16001)',
  'Character: Brakka on Testrealm, level 12 Warrior (Alliance)',
  'Location: Westfall',
  'lastFight=start=2026-09-25T20:00:10,end=2026-09-25T20:00:43,hp=88',
  'logging=true',
].join('\n');

test('the player and the fight window come from the addon context', () => {
  assert.equal(C.playerName(CTX), PLAYER);
  assert.equal(C.playerName('Character: Brakka, level 12'), 'Brakka', 'no realm, no dash');
  assert.equal(C.playerName('Game: World of Warcraft'), '');
  const w = C.fightWindow(CTX);
  assert.equal(w.start, START);
  assert.equal(w.end, END);
  assert.equal(C.fightWindow('lastFight=start=2026-09-25T20:00:10'), null, 'no end time');
  assert.equal(C.fightWindow('lastFight=start=2026-09-25T20:00:43,end=2026-09-25T20:00:10'), null, 'end before start');
});

test('every count matches the synthetic fixture', async () => {
  const lines = await C.readWindow(LOGS, START - 3000, END + 3000);
  assert.ok(lines.length > 0);
  const c = C.count(lines, { player: PLAYER, start: START, end: END });
  assert.deepEqual(c, {
    duration_s: 33,
    deaths: 1,
    enemyCasts: 6,
    interrupts: 1,
    hits: 7,
    idle_s: 6,
    burst_hits: 2,
    burst_s: 1,
  });
});

test('the fixture fight picks the idle check, and its lines carry only counted numbers', async () => {
  const lines = await C.readWindow(LOGS, START - 3000, END + 3000);
  const c = C.count(lines, { player: PLAYER, start: START, end: END });
  const check = C.pick(c);
  assert.deepEqual(check, { rule: 'idle', n: 6 });
  assert.equal(C.change(check), 'keep attacking; the gaps cost you damage.');
  assert.equal(C.reason(check, c), 'you did nothing for 6 s of the 33 s pull.');
  assert.equal(C.countsLine(c), '33 s pull, 7 hits taken, 6 enemy casts, 1 interrupted, 1 deaths, 6 s longest gap.');
});

test('a sentence may use only the counted numbers', async () => {
  const lines = await C.readWindow(LOGS, START - 3000, END + 3000);
  const c = C.count(lines, { player: PLAYER, start: START, end: END });
  assert.equal(C.numbersOk('Keep attacking: you lost 6 s.', c), true);
  assert.equal(C.numbersOk('You lost 9 s in the pull.', c), false, 'an invented number');
  assert.equal(C.numbersOk('You took 7 hits.', c), true);
  assert.equal(C.numbersOk('', c), false);
  assert.equal(C.numbersOk('one line\ntwo lines', c), false);
  assert.equal(C.numbersOk('x'.repeat(200), c), false);
});

test('a check fires only when the file shows it', () => {
  const quiet = { duration_s: 20, deaths: 0, enemyCasts: 0, interrupts: 0, hits: 1, idle_s: 1, burst_hits: 1, burst_s: 0 };
  assert.equal(C.pick(quiet), null, 'a clean fight gets no card');
  assert.deepEqual(C.pick({ ...quiet, enemyCasts: 2 }), { rule: 'interrupt', n: 2 });
  assert.deepEqual(C.pick({ ...quiet, enemyCasts: 2, interrupts: 1 }), null, 'interrupted casts are not a note');
  assert.deepEqual(C.pick({ ...quiet, burst_hits: 4, burst_s: 2 }), { rule: 'burst', n: 4, s: 2 });
  assert.deepEqual(C.pick({ ...quiet, deaths: 1 }), { rule: 'death', n: 1 });
});

test('no usable log: no lines, and no card', async () => {
  assert.equal(await C.readWindow(path.join(__dirname, '..', 'no-such-logs'), START, END), null);
  const none = await C.readWindow(LOGS, Date.parse('2020-01-01T00:00:00'), Date.parse('2020-01-01T00:10:00'));
  assert.deepEqual(none, [], 'a window the log does not cover');
  const c = C.count([], { player: PLAYER, start: START, end: END });
  assert.equal(C.pick(c), null);
});
