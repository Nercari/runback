'use strict';
// Backlog 63: health at the start of each fight, and today's count of fights started
// below 50% health, sent only with a recap or a review.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM, onlyFiles } = require('../toc_load');

function vm(saved) {
  return createAddonVM({
    strictLoad: true,
    only: onlyFiles(['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua']),
    beforeLoad: `unpack = table.unpack
DAY = "2026-10-12"; local plain = date; date = function(fmt, t) if fmt == "%Y-%m-%d" then return DAY end return plain(fmt, t) end
HP, HPMAX = 1000, 1000; UnitHealth = function() return HP end; UnitHealthMax = function() return HPMAX end`,
    saved,
    afterLoad: 'STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers(); Runback.IsConnected = function() return true end',
  });
}
const ctx = v => Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.ctx or ""'), 'hex').toString();
const fightAt = (v, hp) => v.run(`HP = ${hp}; STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); HP = 1000; STUB.now = STUB.now + 30; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")`);
const send = (v, text, cmd) => { v.run(`RunbackDB.outbox = nil; for _, c in ipairs(RunbackDB.chats) do c.pendingId = nil end; Runback.Send(${JSON.stringify(text)}, nil, ${cmd ? `{ cmd = "${cmd}" }` : 'nil'})`); return ctx(v); };

test('fights started at or above half health add no count; the fight line still carries its start health', () => {
  const v = vm();
  fightAt(v, 1000);
  fightAt(v, 500);
  const review = send(v, 'Review my last fight.', 'review');
  assert.match(review, /lastFight=start=[^\n]*,hp=50(\n|$)/);
  assert.doesNotMatch(review, /lowStart=/);
  const recap = send(v, 'Give me a short recap of this session.', 'recap');
  assert.match(recap, /^Game: /);
  assert.doesNotMatch(recap, /lowStart=/);
});

test('fights started below half health are counted for the recap and the review', () => {
  const v = vm();
  fightAt(v, 499);
  fightAt(v, 1000);
  fightAt(v, 120);
  assert.match(send(v, 'Give me a short recap of this session.', 'recap'), /(^|\n)lowStart=2(\n|$)/);
  const review = send(v, 'Review my last fight.', 'review');
  assert.match(review, /(^|\n)lowStart=2(\n|$)/);
  assert.match(review, /lastFight=start=[^\n]*,hp=12(\n|$)/);
});

test('the recap offer link text is a recap question and carries the count; other plain messages do not', () => {
  const v = vm();
  fightAt(v, 300);
  assert.match(send(v, 'Give me a short recap of this session.'), /(^|\n)lowStart=1(\n|$)/);
  const plain = send(v, 'what did i do wrong in my last fight?');
  assert.match(plain, /lastFight=start=[^\n]*,hp=30/);
  assert.doesNotMatch(plain, /lowStart=/);
  assert.equal(v.get('RunbackDB.outbox.cmd'), 'nil');
});

test('the count survives a reload the same day and starts over the next day', () => {
  const first = vm();
  fightAt(first, 200);
  fightAt(first, 200);
  const saved = `RunbackForeverDB = { lowStart = { day = "${first.get('RunbackForeverDB.lowStart.day')}", n = ${first.get('RunbackForeverDB.lowStart.n')} } }`;
  const reloaded = vm(saved);
  fightAt(reloaded, 100);
  assert.match(send(reloaded, 'recap', 'recap'), /(^|\n)lowStart=3(\n|$)/);
  reloaded.run('DAY = "2026-10-13"');
  const nextDay = send(reloaded, 'recap', 'recap');
  assert.match(nextDay, /^Game: /);
  assert.doesNotMatch(nextDay, /lowStart=/);
});

test('a secret-like or failing health read at pull start gives no error and no start health', () => {
  const v = vm();
  v.run('UnitHealth = function() return STUB.health end; UnitHealthMax = function() return STUB.healthMax end');
  v.run('STUB.health = STUB.Secret(); STUB.healthMax = STUB.Secret()');
  // The addon wraps event handlers in pcall, so call the context module directly to
  // see an error; a pull start in game must never raise.
  v.run('CONTEXT = nil; for _, m in ipairs(RunbackForever.modules) do if m.name == "context" then CONTEXT = m end end');
  v.run('OK = tostring(pcall(CONTEXT.onEvent, "PLAYER_REGEN_DISABLED"))');
  assert.equal(v.get('OK'), 'true', 'StartHealth raised on a secret value');
  v.run('CONTEXT.onEvent("PLAYER_REGEN_ENABLED")');
  v.run('UnitHealth = function() error("this value is secret") end');
  v.run('OK = tostring(pcall(CONTEXT.onEvent, "PLAYER_REGEN_DISABLED"))');
  assert.equal(v.get('OK'), 'true', 'StartHealth raised on a blocked health read');
  v.run('CONTEXT.onEvent("PLAYER_REGEN_ENABLED")');
  const review = send(v, 'Review my last fight.', 'review');
  assert.match(review, /lastFight=start=[^\n]*(\n|$)/);
  assert.doesNotMatch(review, /hp=/);
  assert.doesNotMatch(review, /lowStart=/);
  assert.equal(v.get('RunbackForeverDB.lowStart and RunbackForeverDB.lowStart.n or 0'), '0');
});

test('nothing is sent while the fight is on', () => {
  const v = vm();
  v.run('HP = 100; STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  v.run('RunbackDB.outbox = nil; Runback.Send("recap", nil, { cmd = "recap" })');
  assert.equal(v.get('RunbackDB.outbox'), 'nil');
});
