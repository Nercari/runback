'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', '..', 'addon', 'Runback');
const STUB_PATH = path.join(__dirname, '..', 'wow_stub.lua');

const BULK_STUB = `
C_QuestLog = {
  quests = {
    { questID = 101, title = "A Threat In Mor'rogal", level = 12, zone = "Duskwood", isComplete = true, isHeader = false },
    { questID = 102, title = "Wolves at Our Heels", level = 10, zone = "Duskwood", isComplete = false, isHeader = false },
  },
  GetNumQuestLogEntries = function() return #C_QuestLog.quests end,
  GetInfo = function(i) return C_QuestLog.quests[i] end,
}

C_Item = C_Item or {}
C_Item.GetDetailedItemLevelInfo = function(link)
  if link and link:find("item:2140") then return 19 end
  return 10
end

GetInventoryItemLink = function(unit, slot)
  if slot == 16 then return "|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r" end
  return nil
end
`;

function newVM(extra) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
    let nargs = 0;
    if (arg !== undefined) {
      lua.lua_pushstring(L, to_luastring(arg));
      nargs = 1;
    }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) {
      throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));

  run(fs.readFileSync(STUB_PATH, 'utf8'));
  run(BULK_STUB);
  if (extra) run(extra);
  for (const f of [
    'Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua',
    'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Switch.lua', 'Forever_Commands.lua',
    'Forever_Speech.lua', 'Forever_Macro.lua', 'Forever_Bulk.lua', 'Forever_DeathShot.lua',
    'Forever_Translate.lua', 'Forever_Jobs.lua', 'Forever_Banner.lua',
  ]) {
    run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'Runback');
  }
  return { run, evaluate, num };
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "Runback")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
}

test('bulk tables shape, version bump, and reload hint for quests and gear', () => {
  const vm = newVM();
  login(vm);

  // Quests
  vm.run('SlashCmdList.RUNBACK("quests")');
  assert.equal(vm.num('Runback_Bulk.quests.version'), 1);
  assert.ok(vm.num('Runback_Bulk.quests.at') > 0);
  assert.equal(vm.num('#Runback_Bulk.quests.list'), 2);
  assert.equal(vm.evaluate('Runback_Bulk.quests.list[1].title'), "A Threat In Mor'rogal");
  assert.equal(vm.evaluate('Runback_Bulk.quests.list[1].done'), 'true');
  assert.equal(vm.evaluate('Runback_Bulk.quests.list[2].done'), 'false');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Quests saved: /reload to send it to the AI.'));

  // Second quests call bumps version
  vm.run('SlashCmdList.RUNBACK("quests")');
  assert.equal(vm.num('Runback_Bulk.quests.version'), 2);

  // Gear
  vm.run('SlashCmdList.RUNBACK("gearsnap")');
  assert.equal(vm.num('Runback_Bulk.gear.version'), 1);
  assert.ok(vm.num('Runback_Bulk.gear.at') > 0);
  assert.equal(vm.num('#Runback_Bulk.gear.slots'), 19);
  assert.equal(vm.evaluate('Runback_Bulk.gear.slots[16].id'), '2140');
  assert.equal(vm.evaluate('Runback_Bulk.gear.slots[16].ilvl'), '19');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Gear saved: /reload to send it to the AI.'));
});

test('journal records events, caps at 300, bumps version and sets the logout flag at logout, clears on fresh login', () => {
  const vm = newVM();
  login(vm);

  vm.run('STUB.FireEvent("ZONE_CHANGED_NEW_AREA")');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  vm.run('STUB.FireEvent("QUEST_TURNED_IN", 101)');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.FireEvent("ENCOUNTER_END", 1, "Hogger", 0, 0, 1)');

  assert.equal(vm.num('#Runback_Bulk.journal.events'), 6);
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[1].kind'), 'zone');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[2].kind'), 'level');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[2].text'), '24');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[3].kind'), 'death');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[4].kind'), 'quest');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[4].text'), '101');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[5].kind'), 'shot');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[6].kind'), 'kill');
  assert.equal(vm.evaluate('Runback_Bulk.journal.events[6].text'), 'Hogger');

  // Cap at 300
  vm.run(`
    for i = 1, 350 do
      STUB.FireEvent("ZONE_CHANGED_NEW_AREA")
    end
  `);
  assert.equal(vm.num('#Runback_Bulk.journal.events'), 300);

  // Logout
  const vBefore = vm.num('Runback_Bulk.journal.version');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('Runback_Bulk.journal.logout'), 'true');
  assert.equal(vm.num('Runback_Bulk.journal.version'), vBefore + 1);

  // Fresh login after logout: keeps version, logout=false, events cleared
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  assert.equal(vm.evaluate('Runback_Bulk.journal.logout'), 'false');
  assert.equal(vm.num('#Runback_Bulk.journal.events'), 0);
  assert.equal(vm.num('Runback_Bulk.journal.version'), vBefore + 1);
});

test('Scan for AI saves the auctions the player searched for, and explains itself when there are none', () => {
  const vmNoAH = newVM('C_AuctionHouse = nil');
  login(vmNoAH);
  vmNoAH.run('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  vmNoAH.run('RunbackAHScanFrame.btn.scripts.OnClick()');
  assert.ok(vmNoAH.evaluate('table.concat(STUB.prints, "\\n")').includes('AH API not available; shift-click items into the chat instead.'));
  assert.equal(vmNoAH.num('#Runback_Bulk.ah.items'), 0);

  const vm = newVM(`
    C_AuctionHouse = {
      results = {},
      GetBrowseResults = function() return C_AuctionHouse.results end,
      GetItemKeyInfo = function(key) if key.itemID == 2589 then return { itemName = "Linen Cloth" } end end,
    }
    C_Item.GetItemInfo = function(id) if id == 2592 then return "Wool Cloth" end end
  `);
  login(vm);
  vm.run('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  assert.equal(vm.evaluate('RunbackAHScanFrame.shown'), 'true');

  vm.run('RunbackAHScanFrame.btn.scripts.OnClick()');
  assert.equal(vm.evaluate('STUB.prints[#STUB.prints]'), 'Nothing to save yet: search for an item at the auction house, then press Scan for AI again.');
  assert.equal(vm.num('Runback_Bulk.ah.version'), 0);

  vm.run(`C_AuctionHouse.results = {
    { itemKey = { itemID = 2589 }, minPrice = 150, totalQuantity = 20 },
    { itemKey = { itemID = 2592 }, minPrice = 900, totalQuantity = 4 },
  }`);
  vm.run('RunbackAHScanFrame.btn.scripts.OnClick()');
  assert.equal(vm.evaluate('STUB.prints[#STUB.prints]'), 'Saved 2 auctions for the AI: /reload to send them.');
  assert.equal(vm.num('Runback_Bulk.ah.version'), 1);
  assert.equal(vm.num('#Runback_Bulk.ah.items'), 2);
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[1].id'), '2589');
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[1].name'), 'Linen Cloth');
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[1].price'), '150');
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[1].qty'), '20');
  assert.ok(vm.num('Runback_Bulk.ah.items[1].seen') > 0);
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[2].name'), 'Wool Cloth');
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[2].price'), '900');
  assert.equal(vm.evaluate('Runback_Bulk.ah.items[2].qty'), '4');

  vm.run('RunbackAHScanFrame.btn.scripts.OnEnter(RunbackAHScanFrame.btn)');
  assert.equal(vm.evaluate('GameTooltip.text'), 'Scan for AI');
  assert.equal(vm.evaluate('GameTooltip.shown'), 'true');
  vm.run('RunbackAHScanFrame.btn.scripts.OnLeave(RunbackAHScanFrame.btn)');
  assert.equal(vm.evaluate('GameTooltip.shown'), 'false');

  vm.run('SlashCmdList.RUNBACK("ah add Linen Cloth")');
  assert.equal(vm.evaluate('STUB.prints[#STUB.prints]'), 'Search at the auction house, then click Scan for AI: it saves the auctions on screen for the AI.');
});

test('Scan for AI button sits below the auction house frame, not over its Search button', () => {
  const vm = newVM('AuctionHouseFrame = CreateFrame("Frame", "AuctionHouseFrame")');
  login(vm);
  vm.run('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  assert.equal(vm.evaluate('RunbackAHScanFrame.shown'), 'true');
  assert.equal(vm.evaluate('RunbackAHScanFrame.anchor.point'), 'TOPRIGHT');
  assert.equal(vm.evaluate('RunbackAHScanFrame.anchor.rel:GetName()'), 'AuctionHouseFrame');
  assert.equal(vm.evaluate('RunbackAHScanFrame.anchor.relPoint'), 'BOTTOMRIGHT');
  assert.equal(vm.evaluate('RunbackAHScanFrame.x'), '-4');
  assert.equal(vm.evaluate('RunbackAHScanFrame.y'), '2');
});
