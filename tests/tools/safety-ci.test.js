"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { scan } = require("../../tools/safety-ci");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function untrusted(t, files, folderName) {
  const dir = await fixture(t);
  const toc = Object.keys(files).find((name) => name.toLowerCase().endsWith('.toc'));
  const addonDir = path.join(dir, folderName || (toc ? toc.slice(0, -4) || 'EmptyToc' : 'Addon'));
  await fs.mkdir(addonDir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(addonDir, name), content);
  }
  return scan([addonDir], { mode: "untrusted" });
}

test("repo mode detects forbidden APIs and dynamic Lua code", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "bad.ps1"), "SendInput(1)\n");
  await fs.writeFile(path.join(dir, "bad.lua"), 'local f = loadstring("x")\n');
  const result = scan([dir]);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.rule === "FORBIDDEN-API"));
  assert.ok(result.findings.some((item) => item.rule === "LUA-DYNAMIC-CODE"));
});

test("SendMessage exempts only itself from repo forbidden API checks", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "bad.lua");
  await fs.writeFile(file, 'SendMessage("ok"); OpenProcess(1)\n');
  const result = scan([file]);
  assert.ok(result.findings.some((item) => item.rule === "FORBIDDEN-API"));
});

test("repo mode flags the expanded protected automation API set", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "bad.lua"), "CastSpell(1)\n");
  const result = scan([dir]);
  assert.ok(
    result.findings.some((item) => item.rule === "LUA-PROTECTED-AUTOMATION"),
  );
});

test("a frame, slash command, saved global, and timer pass untrusted mode", async (t) => {
  const result = await untrusted(t, {
    "Clean.toc": "## Interface: 110000\nClean.lua\n",
    "Clean.lua": [
      "CleanDB = CleanDB or {}",
      'local frame = CreateFrame("Frame", "CleanFrame", UIParent)',
      'frame:SetPoint("CENTER")',
      'SLASH_CLEAN1 = "/clean"',
      "SlashCmdList.CLEAN = function() print(tostring(GetTime())) end",
      "C_Timer.After(1, function() frame:Show() end)",
    ].join("\n"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("untrusted mode permits a clean addon with saved data and slash command", async (t) => {
  const result = await untrusted(t, {
    "Adv.toc": "## SavedVariables: AdvDB\n## SavedVariablesPerCharacter: AdvCharDB\nAdv.lua\n",
    "Adv.lua": [
      "AdvDB = AdvDB or {}",
      "AdvDB.name = UnitName(\"player\")",
      'local frame = CreateFrame("Frame", "AdvFrame", UIParent)',
      'frame:SetScript("OnEvent", function(self) self.count = 1 end)',
      'SLASH_ADV1 = "/adv"',
      'SlashCmdList.ADV = function() print(UnitName("player")) end',
    ].join("\n"),
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("untrusted mode rejects WoWAI globals from a WoW addon", async (t) => {
  const result = await untrusted(t, {
    "WoW.toc": "WoW.lua\n",
    "WoW.lua": "WoWAIForever = {}\n",
  });
  assert.ok(result.findings.some((item) => item.rule === "LUA-RESTRICTED" && item.text.includes("global write WoWAIForever")));
});

test("untrusted mode rejects reserved SavedVariables in the toc", async (t) => {
  const result = await untrusted(t, {
    "Demo.toc": "## SavedVariables: WoWAIDB\n## SavedVariablesPerCharacter: print, string, wOwAiDB\nDemo.lua\n",
    "Demo.lua": "local ok = true\n",
  });
  for (const name of ["WoWAIDB", "print", "string", "wOwAiDB"]) {
    assert.ok(result.findings.some((item) => item.rule === "TOC-SV" && item.text.includes(name)));
  }
});

test("untrusted mode rejects allowlisted global writes despite the addon prefix", async (t) => {
  const result = await untrusted(t, {
    "p.toc": "p.lua\n",
    "p.lua": "print = function() end\n",
  });
  assert.ok(result.findings.some((item) => item.rule === "LUA-RESTRICTED" && item.text.includes("global write print")));
});

test("untrusted mode rejects namespace writes despite the addon prefix", async (t) => {
  const result = await untrusted(t, {
    "string.toc": "string.lua\n",
    "string.lua": "string = {}\n",
  });
  assert.ok(result.findings.some((item) => item.rule === "LUA-RESTRICTED" && item.text.includes("global write string")));
});

test("untrusted mode permits addon globals and saved data", async (t) => {
  const result = await untrusted(t, {
    "Demo.toc": "## SavedVariables: DemoDB\nDemo.lua\n",
    "Demo.lua": "DemoDB = {}\nDemo_Frame = {}\n",
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

const bypasses = [
  ['local run = getfenv(1)["load" .. "string"]', "LUA-RESTRICTED"],
  ['_G["CastSpell".."ByName"]("x")', "LUA-RESTRICTED"],
  ["local f = CastSpell; f(1)", "LUA-RESTRICTED"],
  ['rawget(_G, "x")', "LUA-RESTRICTED"],
  ["setmetatable({}, {__index = _G})", "LUA-RESTRICTED"],
  ['SendChatMessage("x", "SAY")', "LUA-PROTECTED-AUTOMATION"],
  ["TurnLeftStart()", "LUA-PROTECTED-AUTOMATION"],
  ['local s = ("x").dump', "LUA-RESTRICTED"],
  ['local s = "x"; local d = s.dump', "LUA-RESTRICTED"],
  ['local s = "x"; s:dump()', "LUA-RESTRICTED"],
  ["x.CastSpellByName()", "LUA-RESTRICTED"],
  ["obj:RunMacroText()", "LUA-RESTRICTED"],
  ['local k = "dump"; local d = string[k]', "LUA-RESTRICTED"],
  ["print = function() end", "LUA-RESTRICTED"],
  ["string.format = function() end", "LUA-RESTRICTED"],
  ["C_Timer.After = function() end", "LUA-RESTRICTED"],
  // Unknown globals are rejected; a checker exception must not pass the file.
  ["foo(1)", "LUA-RESTRICTED"],
  ['securecall("CastSpellByName", "x")', "LUA-RESTRICTED"],
  ['SetBindingClick("F", "Btn")', "LUA-RESTRICTED"],
];

for (const [source, rule] of bypasses) {
  test(`untrusted mode rejects ${source}`, async (t) => {
    const result = await untrusted(t, { "Bad.lua": source });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((item) => item.rule === rule));
  });
}

test("untrusted mode rejects non-Lua files and missing toc references", async (t) => {
  const result = await untrusted(t, {
    "Bad.toc": "Missing.lua\n",
    "bad.xml": "<Ui/>",
  });
  assert.ok(result.findings.some((item) => item.rule === "FILE-TYPE"));
  assert.ok(result.findings.some((item) => item.rule === "TOC-REF"));
});

test("untrusted mode rejects empty and mismatched toc names", async (t) => {
  const empty = await untrusted(t, { ".toc": "Bad.lua\n", "Bad.lua": "local ok = true\n" });
  assert.ok(empty.findings.some((item) => item.rule === "TOC-NAME"));
  const mismatch = await untrusted(t, { "Other.toc": "Bad.lua\n", "Bad.lua": "local ok = true\n" }, "Demo");
  assert.ok(mismatch.findings.some((item) => item.rule === "TOC-NAME"));
});

test("untrusted mode rejects a missing or empty root", async (t) => {
  const dir = await fixture(t);
  const empty = scan([dir], { mode: "untrusted" });
  assert.ok(empty.findings.some((item) => item.rule === "SCAN-ROOT"));
  const missing = scan([path.join(dir, "missing")], { mode: "untrusted" });
  assert.ok(missing.findings.some((item) => item.rule === "SCAN-ROOT"));
});

test("untrusted mode rejects symlinks when the OS permits them", async (t) => {
  const dir = await fixture(t);
  const target = path.join(dir, "target.lua");
  await fs.writeFile(target, 'print("ok")\n');
  const link = path.join(dir, "linked.lua");
  try {
    await fs.symlink(target, link, "file");
  } catch {
    return t.skip("OS refused to create a symlink");
  }
  const result = scan([dir], { mode: "untrusted" });
  assert.ok(result.findings.some((item) => item.rule === "LINK"));
});

test("repo directories pass failure rules", () => {
  const result = scan(["addon", "bridge", "tools", "setup.js"]);
  assert.equal(
    result.ok,
    true,
    JSON.stringify(
      result.findings.filter((item) => item.rule !== "NETWORK"),
      null,
      2,
    ),
  );
});

test("repo mode flags replacing a Blizzard function or a method on a Blizzard frame (taint)", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "taint.lua"), [
    'local eb = _G["ChatFrame1EditBox"]',
    "eb.SendText = function(self) end",
    "function ChatEdit_InsertLink(text) end",
    "ChatFrame1EditBox.ProcessChatType = function() end",
  ].join("\n") + "\n");
  const lines = scan([dir]).findings.filter((item) => item.rule === "LUA-TAINT").map((item) => item.line);
  assert.deepEqual(lines, [2, 3, 4]);
});

test("hooks, slash commands, popups and the addon's own tables are not taint", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "clean.lua"), [
    "WoWAI = WoWAI or {}",
    "function WoWAI.Toggle() end",
    "SlashCmdList.WOWAI = function(msg) end",
    'StaticPopupDialogs["WOWAI_X"] = { OnAccept = function() end }',
    'hooksecurefunc("SetItemRef", function() end)',
    "local t = {}",
    "t.f = function() end",
  ].join("\n") + "\n");
  assert.deepEqual(scan([dir]).findings.filter((item) => item.rule === "LUA-TAINT"), []);
});

test("donation and advertising text in addon files fails (UI add-on policy rules 4 and 5)", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "ad.lua"), 'print("Support me on Patreon")\n');
  await fs.writeFile(path.join(dir, "Ad.toc"), "## Notes: please donate\n");
  const result = scan([dir]);
  assert.equal(result.ok, false);
  assert.equal(result.findings.filter((item) => item.rule === "POLICY-SOLICIT").length, 2);
});

test("auction, trade and targeting actions count as protected automation", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "ah.lua"), "PostAuction(1, 2)\nUseContainerItem(0, 1)\n");
  const result = scan([dir]);
  assert.equal(result.findings.filter((item) => item.rule === "LUA-PROTECTED-AUTOMATION").length, 2);
});

// Backlog 68: quest, gossip, trainer, taxi and talent actions are the player's to click.
const questAutomationPlain = [
  "AcceptQuest", "ConfirmAcceptQuest", "CompleteQuest", "GetQuestReward",
  "AcceptGossipQuest", "SelectGossipOption", "SelectGossipActiveQuest",
  "SelectGossipAvailableQuest", "SelectActiveQuest", "SelectAvailableQuest",
  "QuestFrameAcceptButton_OnClick", "QuestFrameCompleteButton_OnClick",
  "QuestFrameCompleteQuestButton_OnClick", "AbandonQuest", "SetAbandonQuest",
  "ConfirmBinder", "TakeTaxiNode", "BuyTrainerService", "LearnTalent",
  "BuyMerchantItem", "PickupMerchantItem", "DeleteCursorItem",
];
const questAutomationQualified = [
  "C_GossipInfo.SelectOption", "C_GossipInfo.SelectOptionByIndex",
  "C_GossipInfo.SelectAvailableQuest", "C_GossipInfo.SelectActiveQuest",
  "C_QuestLog.AbandonQuest", "C_QuestLog.SetAbandonQuest",
];

for (const name of [...questAutomationPlain, ...questAutomationQualified]) {
  test(`repo mode rejects the call ${name}`, async (t) => {
    const dir = await fixture(t);
    await fs.writeFile(path.join(dir, "bad.lua"), `${name}(1)\n`);
    const result = scan([dir]);
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((item) => item.rule === "LUA-PROTECTED-AUTOMATION"),
      JSON.stringify(result.findings),
    );
  });

  test(`untrusted mode rejects ${name} called, aliased and read`, async (t) => {
    for (const source of [`${name}(1)`, `local f = ${name}; f(1)`, `local f = ${name}`]) {
      const result = await untrusted(t, { "Bad.lua": source });
      assert.equal(result.ok, false, source);
      assert.ok(result.findings.some((item) => item.rule === "LUA-RESTRICTED"), source);
    }
  });
}

for (const name of questAutomationPlain.filter((n) => !n.includes("."))) {
  test(`untrusted mode rejects _G["${name}"] and the method form for ${name}`, async (t) => {
    for (const source of [`_G["${name}"](1)`, `obj:${name}(1)`, `obj.${name}(1)`]) {
      const result = await untrusted(t, { "Bad.lua": source });
      assert.equal(result.ok, false, source);
      assert.ok(result.findings.some((item) => item.rule === "LUA-RESTRICTED"), source);
    }
  });
}

// Backlog 62: the addon reads bags to advise. Selling, dropping, moving and equipping are the player's clicks.
const itemActionPlain = [
  "PickupContainerItem", "SplitContainerItem", "SocketContainerItem", "SortBags", "SortBankBags",
  "SellAllJunkItems", "BuybackItem", "ContainerRefundItemPurchase", "DeleteItem", "ConfirmDeleteItem",
  "PickupItem", "PickupInventoryItem", "PickupBagFromSlot", "PutItemInBag", "PutItemInBackpack",
  "EquipCursorItem", "AutoEquipCursorItem", "EquipItemByName", "DropItemOnUnit",
];
const itemActionQualified = [
  "C_Container.PickupContainerItem", "C_Container.SplitContainerItem", "C_Container.UseContainerItem",
  "C_Container.SortBags", "C_MerchantFrame.SellAllJunkItems", "C_Item.DeleteItem", "C_Item.PickupItem",
  "C_Item.EquipItemByName", "C_Item.DropItemOnUnit",
];

for (const name of [...itemActionPlain, ...itemActionQualified]) {
  test(`repo mode rejects the item action ${name}`, async (t) => {
    const dir = await fixture(t);
    await fs.writeFile(path.join(dir, "bad.lua"), `${name}(0, 1)\n`);
    const result = scan([dir]);
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((item) => item.rule === "LUA-PROTECTED-AUTOMATION"),
      JSON.stringify(result.findings),
    );
  });
}

for (const name of itemActionPlain) {
  test(`untrusted mode rejects the item action ${name} called, aliased and as a method`, async (t) => {
    for (const source of [`${name}(0, 1)`, `local f = ${name}`, `obj:${name}(1)`, `C_Container.${name}(0, 1)`]) {
      const result = await untrusted(t, { "Bad.lua": source });
      assert.equal(result.ok, false, source);
      assert.ok(result.findings.some((item) => item.rule === "LUA-RESTRICTED"), source);
    }
  });
}

test("read-only bag and item APIs stay allowed", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "ok.lua"), [
    "local n = C_Container.GetContainerNumSlots(0)",
    "local info = C_Container.GetContainerItemInfo(0, 1)",
    "local quest = C_Container.GetContainerItemQuestInfo(0, 1)",
    "local free = C_Container.GetContainerNumFreeSlots(0)",
    "local name, _, quality, _, _, _, _, _, _, _, price = C_Item.GetItemInfo(2589)",
    "local legacy = GetContainerItemInfo(0, 1)",
    "local q = GetContainerItemQuestInfo(0, 1)",
    "",
  ].join("\n"));
  const result = scan([dir]);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("repo mode rejects the bracket form of a banned C_GossipInfo member", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "bad.lua"), 'C_GossipInfo["SelectOption"](1)\n');
  const result = scan([dir]);
  assert.ok(result.findings.some((item) => item.rule === "LUA-PROTECTED-AUTOMATION"));
});

test("read-only quest and gossip APIs stay allowed", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "ok.lua"), [
    "local title = GetQuestLogTitle(1)",
    "local objectives = C_QuestLog.GetQuestObjectives(1)",
    "local done = IsQuestFlaggedCompleted(1)",
    "local link = GetQuestLink(1)",
    "local n = GetNumQuestLogEntries()",
    "local info = C_QuestLog.GetInfo(1)",
    "local options = C_GossipInfo.GetOptions()",
    "local choices = GetNumQuestChoices()",
    "local item = GetQuestItemLink('choice', 1)",
    "local reward = GetQuestRewardInfo(1)",
    "",
  ].join("\n"));
  const result = scan([dir]);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("untrusted mode still allows the listed read-only quest APIs", async (t) => {
  const result = await untrusted(t, {
    "Ok.lua": "local a = C_QuestLog.GetInfo(1)\nlocal b = C_QuestLog.GetTitleForQuestID(1)\nlocal c = C_QuestLog.GetNumQuestLogEntries and 1\n",
  });
  assert.ok(!result.findings.some((item) => /GetInfo|GetTitleForQuestID/.test(item.text)), JSON.stringify(result.findings));
});
