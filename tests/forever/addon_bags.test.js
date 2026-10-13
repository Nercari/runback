'use strict';
// Backlog 62: "What can I sell or drop?" carries the bag contents with vendor prices and quest flags.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm(setup = '') {
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
  run(setup);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua', 'Forever_Known.lua', 'Forever_Bags.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  run('Runback.IsConnected = function() return true end');
  return { run, get };
}
const outbox = v => ({
  cmd: v.get('RunbackDB.outbox and RunbackDB.outbox.cmd'),
  text: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.text or ""'), 'hex').toString(),
  ctx: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.ctx or ""'), 'hex').toString(),
});
const type = (v, text) => { v.run(`RunbackInput:SetText(${JSON.stringify(text)}); Runback.SendFromInput()`); return outbox(v); };
const bagsOf = ctx => ctx.split('\n').find(l => l.startsWith('Bags (')) || null;
const prints = v => v.get('table.concat(STUB.prints, "\\n")');

// Item database the stub's GetItemInfo answers from: name, quality, sell price, classID, isCraftingReagent.
const ITEMS = `
  ITEMS = {
    [2589] = { "Linen Cloth", 1, 13, 7, true },
    [4865] = { "Ruined Pelt", 0, 5, 15 },
    [3300] = { "Rabbit's Foot", 0, 120, 15 },
    [2672] = { "Stringy Wolf Meat", 1, 4, 7, true },
    [2140] = { "Fine Longsword", 2, 1234, 2 },
    [6281] = { "Rattlecage Skull", 1, 0, 12 },
    [6948] = { "Hearthstone", 1, 0, 15 },
    [20000] = { "Scarlet Insignia", 1, 0, 15 },
  }
  C_Item.GetItemInfo = function(id)
    local it = ITEMS[id]
    if not it then return nil end
    return it[1], "link", it[2], 5, 1, "Type", "Sub", 20, "", 1, it[3], it[4], 0, 0, 0, nil, it[5] == true
  end`;

// C_Container bags: bag -> { slots, { [slot] = { id, count, bound, noValue, questID } } }.
const MODERN_BAGS = ITEMS + `
  BAGS = {
    [0] = { 16, { [1] = { 6948, 1, true, true }, [2] = { 2589, 14 }, [3] = { 4865, 3 }, [5] = { 2589, 6 },
                  [6] = { 2140, 1 }, [7] = { 3300, 2 }, [8] = { 20000, 1, true, nil, 300 } } },
    [1] = { 6, { [1] = { 2672, 5 }, [2] = { 6281, 1, true } } },
  }
  C_Container = {
    GetContainerNumSlots = function(bag) return BAGS[bag] and BAGS[bag][1] or 0 end,
    GetContainerItemInfo = function(bag, slot)
      local s = BAGS[bag] and BAGS[bag][2][slot]
      if not s then return nil end
      return { itemID = s[1], stackCount = s[2], isBound = s[3] == true, hasNoValue = s[4] == true, quality = ITEMS[s[1]][2], itemName = ITEMS[s[1]][1], hyperlink = "|Hitem:" .. s[1] .. "|h[" .. ITEMS[s[1]][1] .. "]|h" }
    end,
    GetContainerItemQuestInfo = function(bag, slot)
      local s = BAGS[bag] and BAGS[bag][2][slot]
      return { isQuestItem = false, questID = s and s[5] or nil, isActive = false }
    end,
  }`;

const MODERN_LINE = 'Bags (13 of 22 slots free; item xcount, quality, vendor price each): ' +
  'Rattlecage Skull x1 common no sale quest bound; Scarlet Insignia x1 common no sale quest bound; ' +
  'Rabbit\'s Foot x2 poor 1s20c; Ruined Pelt x3 poor 5c; Hearthstone x1 common no sale bound; ' +
  'Linen Cloth x20 common 13c reagent; Stringy Wolf Meat x5 common 4c reagent; Fine Longsword x1 uncommon 12s34c';

test('/ai bags sends the question with every bag item, its count, quality, vendor price and quest flag', () => {
  const v = vm(MODERN_BAGS);
  v.run('SlashCmdList["RUNBACK"]("bags")');
  const sent = outbox(v);
  assert.equal(sent.cmd, 'bags');
  assert.equal(sent.text, 'What can I sell or drop?');
  assert.equal(bagsOf(sent.ctx), MODERN_LINE);
  assert.ok(sent.ctx.includes('Character: Testchar'), 'the base context rides along');
  assert.ok(/^gear=1:/m.test(sent.ctx), 'equipped gear rides along so upgrades can be kept');
});

test('a plain question about selling, junk or full bags carries the bags line; other chat does not', () => {
  for (const question of ['what can I sell or drop?', 'My bags are full', 'is any of this junk?', 'o que posso vender?']) {
    const v = vm(MODERN_BAGS);
    assert.equal(bagsOf(type(v, question).ctx), MODERN_LINE, question);
  }
  const v = vm(MODERN_BAGS);
  assert.equal(bagsOf(type(v, 'where do I turn in this quest?').ctx), null);
  assert.equal(bagsOf(type(v, 'thanks!').ctx), null, 'one plain message after another');
});

test('older clients: GetContainerItemInfo returns fields in order and the quest flag comes from GetContainerItemQuestInfo', () => {
  const v = vm(ITEMS + `
    C_Container = nil
    function GetContainerNumSlots(bag) return bag == 0 and 4 or 0 end
    local SLOTS = { [1] = { 4865, 2, nil }, [2] = { 20000, 1, nil }, [4] = { 2589, 3, "|cffffffff|Hitem:2589|h[Linen Cloth]|h|r" } }
    function GetContainerItemInfo(bag, slot)
      local s = bag == 0 and SLOTS[slot]
      if not s then return nil end
      return "icon", s[2], false, ITEMS[s[1]][2], false, false, s[3], false, false, s[1]
    end
    function GetContainerItemQuestInfo(bag, slot) if slot == 2 then return true, 301, false end return false end`);
  v.run('SlashCmdList["RUNBACK"]("bags")');
  assert.equal(bagsOf(outbox(v).ctx),
    'Bags (1 of 4 slots free; item xcount, quality, vendor price each): ' +
    'Scarlet Insignia x1 common no sale quest; Ruined Pelt x2 poor 5c; Linen Cloth x3 common 13c reagent');
});

test('full bags of distinct items: the line stays under 1200 bytes, quest items first, with a count of what was cut', () => {
  const v = vm(`
    C_Item.GetItemInfo = function(id)
      return "Some Long Item Name " .. id, "link", id == 1000 and 1 or 0, 5, 1, "Type", "Sub", 1, "", 1, 3, id == 1000 and 12 or 15
    end
    C_Container = {
      GetContainerNumSlots = function(bag) return 20 end,
      GetContainerItemInfo = function(bag, slot) return { itemID = 1000 + bag * 20 + slot - 1, stackCount = 1 } end,
    }`);
  v.run('SlashCmdList["RUNBACK"]("bags")');
  const line = bagsOf(outbox(v).ctx);
  assert.ok(line.length <= 1200, String(line.length));
  assert.ok(line.startsWith('Bags (0 of 100 slots free; item xcount, quality, vendor price each): Some Long Item Name 1000 x1 common 3c quest; '), line);
  const shown = line.slice(line.indexOf('): ') + 3).split('; ').length - 1;
  assert.equal(Number(line.match(/; \+(\d+) more$/)[1]), 100 - shown);
});

test('no bag API: the question still goes with the base context and no bags line', () => {
  const v = vm('C_Container = nil; GetContainerNumSlots = nil; GetContainerItemInfo = nil');
  v.run('SlashCmdList["RUNBACK"]("bags")');
  const sent = outbox(v);
  assert.equal(sent.text, 'What can I sell or drop?');
  assert.equal(bagsOf(sent.ctx), null);
  assert.ok(sent.ctx.includes('Character: Testchar'));
});

test('the bags question is refused in combat, like every send', () => {
  const v = vm(MODERN_BAGS);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); SlashCmdList["RUNBACK"]("bags")');
  assert.equal(v.get('RunbackDB.outbox and RunbackDB.outbox.cmd'), 'nil');
});

const FILL = 'BAGS[1][2][3] = { 2589, 1 }; BAGS[1][2][4] = { 2589, 1 }; BAGS[1][2][5] = { 2589, 1 }; BAGS[1][2][6] = { 2589, 1 }; ' +
  'for slot = 1, 16 do BAGS[0][2][slot] = BAGS[0][2][slot] or { 4865, 1 } end';

test('bags filling up out of combat: one chat line offers the question; the link fills the box and sends nothing', () => {
  const v = vm(MODERN_BAGS);
  v.run('STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.ok(!prints(v).includes('Bags full.'), 'free slots left: no offer');
  v.run(FILL + '; STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.ok(prints(v).includes('Bags full. |Hrunback:ask:'), prints(v));
  assert.ok(prints(v).includes('[what can I sell or drop?]'));
  v.run('SetItemRef("runback:ask:" .. RunbackDB.chats[1].id)');
  assert.ok(v.get('table.concat(STUB.texts, "|")').includes('My bags are full. What can I sell or drop?'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
  v.run('STUB.prints = {}; STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.ok(!prints(v).includes('Bags full.'), 'still full: offered once');
});

test('bags filling up in combat: the offer waits for the fight to end, and is quiet while the AI is off', () => {
  let v = vm(MODERN_BAGS);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); ' + FILL + '; STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.ok(!prints(v).includes('Bags full.'), 'nothing in combat');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.ok(prints(v).includes('Bags full.'), 'offered once combat ends');

  v = vm(MODERN_BAGS);
  v.run('RunbackForeverDB = RunbackForeverDB or {}; RunbackForeverDB.off = true; ' + FILL + '; STUB.FireEvent("BAG_UPDATE_DELAYED")');
  assert.ok(!prints(v).includes('Bags full.'));
});
