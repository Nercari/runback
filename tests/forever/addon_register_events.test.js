'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM, onlyFiles } = require('../toc_load');

// The Forever client has no retail auction house search events; its RegisterEvent errors on them.
const MISSING_EVENTS = `
local missing = { ITEM_SEARCH_RESULTS_RECEIVED = true, ITEM_SEARCH_RESULTS_UPDATED = true,
  COMMODITY_SEARCH_RESULTS_RECEIVED = true, COMMODITY_SEARCH_RESULTS_UPDATED = true }
local create = CreateFrame
CreateFrame = function(...)
  local f = create(...)
  local register = f.RegisterEvent
  f.RegisterEvent = function(self, ev)
    if missing[ev] then error('Attempt to register unknown event "' .. ev .. '"') end
    return register(self, ev)
  end
  return f
end
`;

function newVM() {
  return createAddonVM({
    strictLoad: true,
    only: onlyFiles(['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Bulk.lua']),
    chunkName: 'Runback',
    beforeLoad: MISSING_EVENTS,
  });
}

test('a module event the client lacks is skipped instead of breaking the addon load', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('RunbackForever.modules[#RunbackForever.modules].name'), 'bulk');
  vm.run(`RunbackForever.Register({ name = "retail-ah", events = {
    ITEM_SEARCH_RESULTS_RECEIVED = true, COMMODITY_SEARCH_RESULTS_RECEIVED = true, AUCTION_HOUSE_SHOW = true } })`);
  assert.equal(vm.evaluate('RunbackForever.skippedEvents.ITEM_SEARCH_RESULTS_RECEIVED'), 'true');
  assert.equal(vm.evaluate('RunbackForever.skippedEvents.COMMODITY_SEARCH_RESULTS_RECEIVED'), 'true');
  assert.equal(vm.evaluate('RunbackForever.skippedEvents.AUCTION_HOUSE_SHOW'), null);
  // Every event the client does know is still registered for the bulk module.
  vm.run(`
    HAS = {}
    for _, f in ipairs(STUB.frames) do for ev in pairs(f.events) do HAS[ev] = true end end
  `);
  for (const ev of ['AUCTION_HOUSE_SHOW', 'AUCTION_HOUSE_CLOSED', 'PLAYER_LEVEL_UP', 'ZONE_CHANGED_NEW_AREA', 'PLAYER_LOGOUT']) {
    assert.equal(vm.evaluate(`HAS.${ev}`), 'true', ev);
  }
});
