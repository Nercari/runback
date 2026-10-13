'use strict';
// Backlog 63: health at the start of each fight, and today's count of fights started
// below 50% health, sent only with a recap or a review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm(saved) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  run('DAY = "2026-10-12"; local plain = date; date = function(fmt, t) if fmt == "%Y-%m-%d" then return DAY end return plain(fmt, t) end');
  run('HP, HPMAX = 1000, 1000; UnitHealth = function() return HP end; UnitHealthMax = function() return HPMAX end');
  if (saved) run(saved);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  run('Runback.IsConnected = function() return true end');
  return { run, get };
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

test('nothing is sent while the fight is on', () => {
  const v = vm();
  v.run('HP = 100; STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  v.run('RunbackDB.outbox = nil; Runback.Send("recap", nil, { cmd = "recap" })');
  assert.equal(v.get('RunbackDB.outbox'), 'nil');
});
