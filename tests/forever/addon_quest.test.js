'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM, onlyFiles } = require('../toc_load');

function vm() {
  return createAddonVM({
    strictLoad: true,
    only: onlyFiles(['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Quest.lua']),
    beforeLoad: `unpack = table.unpack
QUEST = { "Executor Staff", "Forsaken Dagger" }
function GetNumQuestChoices() return #QUEST end
function GetQuestItemLink(kind, i) return "|cff1eff00|Hitem:" .. i .. "|h[" .. QUEST[i] .. "]|h|r" end
QuestFrame = CreateFrame("Frame", "QuestFrame", UIParent)`,
    afterLoad: 'STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()',
  });
}

test('quest reward button: shows with a choice, fills the box with the item names and sends nothing', () => {
  const v = vm();
  v.run('STUB.FireEvent("QUEST_COMPLETE")');
  assert.equal(v.get('RunbackQuestAsk.shown'), 'true');
  v.run('RunbackQuestAsk.scripts.OnClick()');
  assert.equal(v.get('RunbackFrame.shown'), 'true');
  const texts = v.get('table.concat(STUB.texts, "|")');
  assert.ok(texts.includes('Executor Staff, Forsaken Dagger'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
  v.run('STUB.FireEvent("QUEST_FINISHED")');
  assert.equal(v.get('RunbackQuestAsk.shown'), 'false');
});

test('quest reward button: hidden with one reward, in combat, and while the AI is off', () => {
  let v = vm();
  v.run('QUEST = { "Only Item" }; STUB.FireEvent("QUEST_COMPLETE")');
  assert.equal(v.get('RunbackQuestAsk'), 'nil');

  v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.FireEvent("QUEST_COMPLETE")');
  assert.equal(v.get('RunbackQuestAsk'), 'nil');

  v = vm();
  v.run('RunbackForeverDB = RunbackForeverDB or {}; RunbackForeverDB.off = true; STUB.FireEvent("QUEST_COMPLETE")');
  assert.equal(v.get('RunbackQuestAsk'), 'nil');
});

test('quest reward button: a click does nothing once a fight has started', () => {
  const v = vm();
  v.run('STUB.FireEvent("QUEST_COMPLETE")');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); RunbackQuestAsk.scripts.OnClick()');
  assert.ok(!v.get('table.concat(STUB.texts, "|")').includes('Executor Staff, Forsaken Dagger'));
});
