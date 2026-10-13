'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm() {
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
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  run('Runback.IsConnected = function() return true end');
  run(`function CLICK(label)
    for _, f in ipairs(STUB.frames) do
      if f.kind == "Button" and f.text == label then f.scripts.OnClick(f); return true end
    end
    error("no button labelled " .. label)
  end`);
  return { run, get };
}
const outbox = v => ({
  cmd: v.get('RunbackDB.outbox and RunbackDB.outbox.cmd'),
  text: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.text or ""'), 'hex').toString(),
  ctx: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.ctx or ""'), 'hex').toString(),
});
const fight = v => v.run('STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.now = STUB.now + 30; STUB.FireEvent("PLAYER_REGEN_ENABLED")');

test('the Review last fight button sends the review command with the fight times', () => {
  const v = vm();
  fight(v);
  v.run('CLICK("Review last fight")');
  const sent = outbox(v);
  assert.equal(sent.cmd, 'review');
  assert.equal(sent.text, 'Review my last fight.');
  assert.match(sent.ctx, /lastFight=start=.*,end=/);
});

test('a lone "review" typed in the window is the review command; other text stays a plain message', () => {
  let v = vm();
  fight(v);
  v.run('RunbackInput:SetText("Review."); Runback.SendFromInput()');
  assert.equal(outbox(v).cmd, 'review');
  assert.match(outbox(v).ctx, /lastFight=start=/);

  v = vm();
  fight(v);
  v.run('RunbackInput:SetText("review my gear"); Runback.SendFromInput()');
  assert.equal(outbox(v).cmd, 'nil');
  assert.equal(outbox(v).text, 'review my gear');
});

test('in combat the Review button sends nothing', () => {
  const v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); CLICK("Review last fight")');
  assert.equal(v.get('RunbackDB.outbox'), 'nil');
  assert.match(v.get('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text'), /AI paused in combat/);
});

test('the Combat log button shows the game state and toggles it only out of combat', () => {
  const v = vm();
  v.run('STUB.logging = false; function LoggingCombat(on) if on ~= nil then STUB.logging = on end return STUB.logging end');
  v.run('Runback.UpdateLogButton()');
  v.run('CLICK("Combat log: off")');
  assert.equal(v.get('STUB.logging'), 'true');
  v.run('CLICK("Combat log: on")');
  assert.equal(v.get('STUB.logging'), 'false');
  v.run('STUB.combat = true; Runback.UpdateLogButton(); CLICK("Combat log: off")');
  assert.equal(v.get('STUB.logging'), 'false');
});

test('the Why did I die? button sends the death command; in combat it sends nothing', () => {
  let v = vm();
  v.run('CLICK("Why did I die?")');
  assert.equal(outbox(v).cmd, 'death');
  assert.equal(outbox(v).text, 'Why did I die?');

  v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); CLICK("Why did I die?")');
  assert.equal(v.get('RunbackDB.outbox'), 'nil');
});

// Backlog 51: fight questions in the player's words.
const chat = (v, text) => { v.run(`RunbackDB.outbox = nil; RunbackInput:SetText(${JSON.stringify(text)}); Runback.SendFromInput()`); return outbox(v); };

test('a plain chat message within 10 minutes of a fight carries lastFight and deaths', () => {
  const v = vm();
  fight(v);
  v.run('STUB.FireEvent("PLAYER_DEAD")');
  v.run('STUB.now = STUB.now + 599');
  const sent = chat(v, 'what did i do wrong in my last fight?');
  assert.equal(sent.cmd, 'nil');
  assert.match(sent.ctx, /lastFight=start=.*,end=/);
  assert.match(sent.ctx, /deaths=/);
});

test('a plain chat message after the 10 minute window carries neither line', () => {
  const v = vm();
  fight(v);
  v.run('STUB.FireEvent("PLAYER_DEAD"); STUB.now = STUB.now + 601');
  const sent = chat(v, 'what did i do wrong?');
  assert.doesNotMatch(sent.ctx, /lastFight=|deaths=/);
});

test('a death alone opens the window, and nothing is added during a fight', () => {
  let v = vm();
  v.run('STUB.FireEvent("PLAYER_DEAD")');
  assert.match(chat(v, 'why?').ctx, /deaths=/);

  v = vm();
  fight(v);
  v.run('STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.doesNotMatch(v.get('Runback.GameContext()'), /lastFight=|deaths=/);
});

test('the mentor prompt answers fight questions from the lines', () => {
  const mentor = fs.readFileSync(path.join(__dirname, '..', '..', 'mentor', 'AGENTS.md'), 'utf8');
  assert.ok(mentor.includes('**Answer from the lines.**'));
});
