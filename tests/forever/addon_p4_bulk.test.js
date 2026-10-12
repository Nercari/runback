'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
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
    'Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Forever.lua',
    'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Switch.lua', 'Forever_Commands.lua',
    'Forever_Speech.lua', 'Forever_Macro.lua', 'Forever_Bulk.lua', 'Forever_DeathShot.lua',
    'Forever_Translate.lua', 'Forever_Jobs.lua', 'Forever_Banner.lua',
  ]) {
    run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  }
  return { run, evaluate, num };
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
}

test('bulk tables shape, version bump, and reload hint for quests and gear', () => {
  const vm = newVM();
  login(vm);

  // Quests
  vm.run('SlashCmdList.WOWAI("quests")');
  assert.equal(vm.num('WoWAI_Bulk.quests.version'), 1);
  assert.ok(vm.num('WoWAI_Bulk.quests.at') > 0);
  assert.equal(vm.num('#WoWAI_Bulk.quests.list'), 2);
  assert.equal(vm.evaluate('WoWAI_Bulk.quests.list[1].title'), "A Threat In Mor'rogal");
  assert.equal(vm.evaluate('WoWAI_Bulk.quests.list[1].done'), 'true');
  assert.equal(vm.evaluate('WoWAI_Bulk.quests.list[2].done'), 'false');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Quests saved: /reload to send it to the AI.'));

  // Second quests call bumps version
  vm.run('SlashCmdList.WOWAI("quests")');
  assert.equal(vm.num('WoWAI_Bulk.quests.version'), 2);

  // Gear
  vm.run('SlashCmdList.WOWAI("gearsnap")');
  assert.equal(vm.num('WoWAI_Bulk.gear.version'), 1);
  assert.ok(vm.num('WoWAI_Bulk.gear.at') > 0);
  assert.equal(vm.num('#WoWAI_Bulk.gear.slots'), 19);
  assert.equal(vm.evaluate('WoWAI_Bulk.gear.slots[16].id'), '2140');
  assert.equal(vm.evaluate('WoWAI_Bulk.gear.slots[16].ilvl'), '19');
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

  assert.equal(vm.num('#WoWAI_Bulk.journal.events'), 6);
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[1].kind'), 'zone');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[2].kind'), 'level');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[2].text'), '24');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[3].kind'), 'death');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[4].kind'), 'quest');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[4].text'), '101');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[5].kind'), 'shot');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[6].kind'), 'kill');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.events[6].text'), 'Hogger');

  // Cap at 300
  vm.run(`
    for i = 1, 350 do
      STUB.FireEvent("ZONE_CHANGED_NEW_AREA")
    end
  `);
  assert.equal(vm.num('#WoWAI_Bulk.journal.events'), 300);

  // Logout
  const vBefore = vm.num('WoWAI_Bulk.journal.version');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.logout'), 'true');
  assert.equal(vm.num('WoWAI_Bulk.journal.version'), vBefore + 1);

  // Fresh login after logout: keeps version, logout=false, events cleared
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  assert.equal(vm.evaluate('WoWAI_Bulk.journal.logout'), 'false');
  assert.equal(vm.num('#WoWAI_Bulk.journal.events'), 0);
  assert.equal(vm.num('WoWAI_Bulk.journal.version'), vBefore + 1);
});

test('AH scan does nothing without C_AuctionHouse and scans shopping list when present', () => {
  // Without C_AuctionHouse
  const vmNoAH = newVM('C_AuctionHouse = nil');
  login(vmNoAH);
  vmNoAH.run('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  vmNoAH.run('WoWAIAHScanFrame.btn.scripts.OnClick()');
  assert.ok(vmNoAH.evaluate('table.concat(STUB.prints, "\\n")').includes('AH API not available; shift-click items into the chat instead.'));
  assert.equal(vmNoAH.num('#WoWAI_Bulk.ah.items'), 0);

  // With C_AuctionHouse
  const vm = newVM(`
    C_AuctionHouse = {
      searches = {},
      SendSearchQuery = function(item) table.insert(C_AuctionHouse.searches, item) end,
      GetNumCommoditySearchResults = function() return 1 end,
      GetCommoditySearchResultInfo = function(i) return { itemID = 2589, name = "Linen Cloth", unitPrice = 150, quantity = 20 } end,
      GetNumItemSearchResults = function() return 0 end,
    }
  `);
  login(vm);

  vm.run('SlashCmdList.WOWAI("ah add Linen Cloth")');
  assert.equal(vm.evaluate('WoWAIForeverDB.ahList[1]'), 'Linen Cloth');

  vm.run('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.shown'), 'true');

  vm.run('WoWAIAHScanFrame.btn.scripts.OnClick()');
  assert.equal(vm.num('#C_AuctionHouse.searches'), 1);

  // Result event arrives
  vm.run('STUB.FireEvent("COMMODITY_SEARCH_RESULTS_UPDATED")');
  // Both result events re-read the same results: still one row.
  vm.run('STUB.FireEvent("COMMODITY_SEARCH_RESULTS_RECEIVED")');
  // Trigger ticker completion (scanIndex moves past shopping list)
  vm.run('STUB.Tick()'); // ticker fires StepAHScan -> scan done
  assert.equal(vm.num('WoWAI_Bulk.ah.version'), 1);
  assert.equal(vm.num('#WoWAI_Bulk.ah.items'), 1);
  assert.equal(vm.evaluate('WoWAI_Bulk.ah.items[1].name'), 'Linen Cloth');
  assert.equal(vm.evaluate('WoWAI_Bulk.ah.items[1].price'), '150');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Scan saved: /reload to send it to the AI.'));
});

test('Scan for AI button sits below the auction house frame, not over its Search button', () => {
  const vm = newVM('AuctionHouseFrame = CreateFrame("Frame", "AuctionHouseFrame")');
  login(vm);
  vm.run('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.anchor.point'), 'TOPRIGHT');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.anchor.rel:GetName()'), 'AuctionHouseFrame');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.anchor.relPoint'), 'BOTTOMRIGHT');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.x'), '-4');
  assert.equal(vm.evaluate('WoWAIAHScanFrame.y'), '2');
});
