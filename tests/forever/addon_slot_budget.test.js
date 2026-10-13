'use strict';
// Backlog 78: slots spent per reply when the sound-file channel is unusable.
// WoW: Forever reports an empty .wav as playable, so the self-test turns the
// channel off and every reply check costs one of the 200 slot addons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
function vm({ soundWorks }) {
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
  // Forever: every file, even an empty one, reports as playable. A working
  // client: only the control file and nothing the bridge has not raised.
  run(soundWorks
    ? 'STUB.sounds["Interface\\\\AddOns\\\\Runback\\\\ctl\\\\valid.wav"] = true'
    : 'function PlaySoundFile() return true, 1 end');
  for (const file of ['Codec.lua', 'Inbox.lua', 'Forever.lua', 'Runback.lua']) run(fs.readFileSync(path.join(addon, file), 'utf8'));
  // A fake bridge. Its slot data carries the time it last published (what the
  // real bridge writes as `now`): at the hello, when it picks up a message, every
  // 30 s of progress, and when the reply is done.
  run(`BR = { pub = STUB.now, loads = 0 }
  STUB.onLoadAddOn = function()
    BR.loads = BR.loads + 1
    local c = RunbackDB.chats[1]
    local replies = {}
    if c.pendingId and BR.sent then
      local done = STUB.now >= BR.sent + BR.ready
      if done then BR.pub = BR.sent + BR.ready
      elseif STUB.now >= BR.sent + 3 then BR.pub = BR.sent + 3 + math.floor((STUB.now - BR.sent - 3) / 30) * 30 end
      replies = { { chat = c.id, id = c.pendingId, status = done and "done" or "working", text = done and "answer" or "reading" } }
    end
    Runback_SlotData = { now = STUB.epoch + math.floor(BR.pub), cwd = "", agent = "claude", agents = { "claude" }, replies = replies }
  end`);
  const advance = seconds => run(`for _ = 1, ${Math.round(seconds / 2)} do STUB.now = STUB.now + 2; STUB.Tick(); STUB.RunTimers() end`);
  // Send a message the bridge answers `ready` seconds later; wait for the answer.
  const ask = (text, ready) => {
    run(`Runback.Send(${JSON.stringify(text)})`);
    if (get('RunbackDB.chats[1].pendingId') === 'nil') {
      // The light said the bridge was not seen lately: the box waits for the
      // reconnect hello, which the bridge answers.
      run('BR.pub = STUB.now + 2');
      for (let i = 0; i < 30 && get('RunbackDB.chats[1].pendingId') === 'nil'; i++) advance(2);
    }
    assert.notEqual(get('RunbackDB.chats[1].pendingId'), 'nil', 'message went out');
    run(`BR.sent = STUB.now; BR.ready = ${ready}`);
    for (let i = 0; i < 2000 && get('RunbackDB.chats[1].pendingId') !== 'nil'; i++) advance(2);
    assert.equal(get('RunbackDB.chats[1].pendingId'), 'nil', 'reply arrived');
    run('BR.sent = nil');
  };
  const loads = () => Number(get('BR.loads'));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); BR.pub = STUB.now');
  advance(10);
  return { run, get, advance, ask, loads };
}

// An evening in miniature: log in, ask, read for 20 minutes, ask a longer one,
// read for 20 more. The replies take 115 s and 710 s on the bridge.
function evening(soundWorks) {
  const v = vm({ soundWorks });
  const counts = { login: v.loads() };
  v.advance(60);
  let before = v.loads(); v.ask('how do I get to Undercity?', 115); counts.short = v.loads() - before;
  before = v.loads(); v.advance(1200); counts.idle1 = v.loads() - before;
  before = v.loads(); v.ask('plan my next three levels', 710); counts.long = v.loads() - before;
  before = v.loads(); v.advance(1200); counts.idle2 = v.loads() - before;
  counts.total = v.loads();
  counts.perReply = counts.total / 2;
  return { v, counts };
}

// Measured on forever 557664a (before this change), slot-only mode:
// login 2 (hello, idle check), 2-minute reply 10, each 20 idle minutes 2,
// 12-minute reply 22 (21 polls and a reconnect hello) -> 38 slots, 19 per reply.
const BASELINE = { total: 38, perReply: 19 };

test('slot-only mode spends at most half the baseline slots per reply', () => {
  const { counts } = evening(false);
  console.log('# slot budget (sound channel unusable):', JSON.stringify(counts), 'baseline', JSON.stringify(BASELINE));
  assert.ok(counts.perReply <= BASELINE.perReply / 2, `slots per reply ${counts.perReply} > half of ${BASELINE.perReply}`);
  assert.deepEqual(counts, { login: 1, short: 5, idle1: 0, long: 11, idle2: 0, total: 17, perReply: 8.5 });
});

test('with the sound channel working, the fast schedule stays', () => {
  const { counts } = evening(true);
  // No sig file is raised by this fake bridge, so every read is a scheduled poll,
  // plus one reconnect hello before the second message (it raises no presence beats).
  assert.equal(counts.short, 10);
  assert.equal(counts.long, 22);
  assert.equal(counts.idle1 + counts.idle2, 0, 'presence beats cover idle time, no slots');
});

test('/runback diag reports slots per reply and per hour', () => {
  const { v } = evening(false);
  v.run('SlashCmdList["RUNBACK"]("diag")');
  const diag = v.get('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text');
  const line = diag.split('\n').find(l => l.startsWith('slots used'));
  // 17 slots over about 56 minutes of session (10 + 60 + 120 + 1200 + 780 + 1200 s).
  assert.equal(line, 'slots used this session: 17 (hello 1, schedule 16), replies 2, 8.5 per reply, 18.2 per hour, free slots: 183/200');
});
