'use strict';
// The between-pull coach card (#140), addon side: it is asked for once a fight and
// shown out of combat only, its three buttons count locally, /ai card prints them,
// the setting turns it off, and nothing shows with the combat log off or no card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');

function vm(logging = true) {
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
  // The log is only ever read here: a write with an argument would be the player's click.
  run(`STUB.logging = ${logging}
    LOG_SETS = {}
    function LoggingCombat(on) if on ~= nil then table.insert(LOG_SETS, tostring(on)); STUB.logging = on end return STUB.logging end`);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Card.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  run('Runback.IsConnected = function() return true end');
  return { run, get };
}

const prints = v => v.get('table.concat(STUB.prints, "\\n")');
// The request is made one frame after the fight, once the context has the end time.
const fight = v => v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.now = STUB.now + 30; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED"); STUB.RunTimers()');
const slot = card => `STUB.onLoadAddOn = function() Runback_SlotData = { now = time(), cwd = "", card = ${card} } end`;
const CARD = '{ key = "2026-09-25T20:00:10/2026-09-25T20:00:43", text = "One change: keep attacking; the gaps cost you damage.", why = "Why: you did nothing for 6 s of the 33 s pull.", counts = "33 s pull, 7 hits taken, 6 enemy casts." }';
const click = (v, label) => v.run(`(function()
  for _, f in ipairs(RunbackCardFrame.children) do
    if f.kind == "Button" and f.text == ${JSON.stringify(label)} then f.scripts.OnClick(f); return true end
  end
  error("no button " .. ${JSON.stringify(label)})
end)()`);
const shown = v => v.get(`(RunbackCardFrame ~= nil and RunbackCardFrame.shown == true) and "true" or "false"`);
const cardText = v => v.get(`(function()
  local out = {}
  for _, c in ipairs(RunbackCardFrame.children) do
    if c.kind == "FontString" and c.shown ~= false and c.text and c.text ~= "" then out[#out + 1] = c.text end
  end
  return table.concat(out, " | ")
end)()`);

test('a fight asks for one card; the slot answer shows it out of combat, never in the chat', () => {
  const v = vm();
  const before = v.get('#RunbackDB.chats[1].history');
  fight(v);
  assert.equal(v.get('RunbackForeverDB.card.requested'), '12:00/12:00', 'asked for once per fight');
  assert.equal(v.get('RunbackStrip.shown'), 'true', 'the request went out on the strip');
  assert.equal(v.get('STUB.logging'), 'true', 'nothing here switches the log');
  assert.equal(v.get('table.concat(LOG_SETS, ",")'), '');

  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'true');
  assert.match(cardText(v), /One change: keep attacking/);
  assert.match(cardText(v), /Why: you did nothing for 6 s of the 33 s pull/);
  assert.equal(v.get('#RunbackDB.chats[1].history'), before, 'no chat message');
  assert.doesNotMatch(prints(v), /One change/, 'no chat line');
  assert.equal(v.get('RunbackForeverDB.card.counts.got'), '0');
});

test('the card is held in combat and shows when the lockout ends', () => {
  const v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'false', 'nothing shows in a fight');
  assert.equal(v.get('RunbackForeverDB.card.seen'), '2026-09-25T20:00:10/2026-09-25T20:00:43', 'the card is kept');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(v), 'true', 'shown once the fight ends');
});

test('a card that arrives during a fight is hidden again if the fight restarts', () => {
  const v = vm();
  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'true');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(shown(v), 'false', 'hidden when the next pull starts');
});

test('Got it, Why? and Not useful each add to the local count that /ai card prints', () => {
  const v = vm();
  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');

  click(v, 'Got it');
  assert.equal(v.get('RunbackForeverDB.card.counts.got'), '1');
  assert.equal(shown(v), 'false', 'the card closes');

  v.run('RunbackCard.Sync({ key = "next/2", text = "One change: second note.", why = "Why: 2 hits in 3 s.", counts = "33 s pull, 7 hits taken, 6 enemy casts." })');
  assert.equal(shown(v), 'true', 'a new card replaces the answered one');
  click(v, 'Why?');
  assert.equal(v.get('RunbackForeverDB.card.counts.why'), '1');
  assert.equal(shown(v), 'true', 'Why? opens the numbers and keeps the card');
  assert.match(cardText(v), /33 s pull, 7 hits taken, 6 enemy casts/);

  click(v, 'Not useful');
  assert.equal(v.get('RunbackForeverDB.card.counts.no'), '1');
  assert.equal(shown(v), 'false');

  v.run('SlashCmdList["RUNBACK"]("card")');
  assert.ok(prints(v).includes('Coach card: on. Got it 1, Why? 1, Not useful 1.'), prints(v));
});

test('the setting turns the card off, and /ai card says so', () => {
  const v = vm();
  v.run('SlashCmdList["RUNBACK"]("card off")');
  assert.equal(v.get('RunbackForeverDB.card.enabled'), 'false');
  assert.ok(prints(v).includes('Coach card: off. Got it 0, Why? 0, Not useful 0.'), prints(v));
  fight(v);
  assert.equal(v.get('RunbackForeverDB.card.requested'), 'nil', 'no request while off');
  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'false', 'no card while off');
  v.run('SlashCmdList["RUNBACK"]("card on")');
  assert.equal(v.get('RunbackForeverDB.card.enabled'), 'true');
});

test('with the combat log off there is no request and no card', () => {
  const v = vm(false);
  fight(v);
  assert.equal(v.get('RunbackForeverDB.card.requested'), 'nil');
  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'false', 'a card is not shown with the log off');
  v.run('SlashCmdList["RUNBACK"]("card")');
  assert.ok(prints(v).includes('It stays off while the combat log is off.'), prints(v));
});

test('a slot with no card shows nothing and raises nothing', () => {
  const v = vm();
  v.run('STUB.onLoadAddOn = function() Runback_SlotData = { now = time(), cwd = "" } end');
  fight(v);
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'false');
  assert.equal(v.get('RunbackForeverDB.card.seen'), 'nil');
});

test('the same card is not shown twice', () => {
  const v = vm();
  v.run(slot(CARD));
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  click(v, 'Got it');
  v.run('STUB.now = STUB.now + 9; STUB.Tick()');
  assert.equal(shown(v), 'false', 'a second slot with the same card changes nothing');
});
