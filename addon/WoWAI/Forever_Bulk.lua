local ahFrame = nil
local MAX_AH_ITEMS = 500

local function EnsureBulk()
	WoWAI_Bulk = WoWAI_Bulk or {}
	WoWAI_Bulk.ah = WoWAI_Bulk.ah or { version = 0, at = 0, items = {} }
	WoWAI_Bulk.quests = WoWAI_Bulk.quests or { version = 0, at = 0, list = {} }
	WoWAI_Bulk.journal = WoWAI_Bulk.journal or { version = 0, at = 0, logout = false, events = {} }
	WoWAI_Bulk.gear = WoWAI_Bulk.gear or { version = 0, at = 0, slots = {} }
	return WoWAI_Bulk
end

local function UpdateBulk(section, data)
	local bulk = EnsureBulk()
	local cur = bulk[section] or {}
	local nextVer = (cur.version or 0) + 1
	data.version = nextVer
	data.at = time()
	bulk[section] = data
	return data
end

local function AppendJournal(kind, text, shot)
	local bulk = EnsureBulk()
	local j = bulk.journal
	local events = j.events or {}
	j.events = events
	table.insert(events, {
		t = time(),
		kind = kind,
		text = text or "",
		shot = shot,
	})
	while #events > 300 do
		table.remove(events, 1)
	end
	j.at = time()
end

local function CollectQuests()
	local list = {}
	if type(C_QuestLog) == "table" and type(C_QuestLog.GetNumQuestLogEntries) == "function" then
		local ok, n = pcall(C_QuestLog.GetNumQuestLogEntries)
		if ok and type(n) == "number" then
			for i = 1, n do
				local ok2, info = pcall(C_QuestLog.GetInfo, i)
				if ok2 and type(info) == "table" and not info.isHeader then
					table.insert(list, {
						id = info.questID,
						title = info.title or "",
						level = info.level or 0,
						zone = info.zone or (type(GetZoneText) == "function" and GetZoneText() or ""),
						done = info.isComplete == true or info.isComplete == 1,
					})
				end
			end
		end
	elseif type(GetNumQuestLogEntries) == "function" and type(GetQuestLogTitle) == "function" then
		local ok, n = pcall(GetNumQuestLogEntries)
		if ok and type(n) == "number" then
			for i = 1, n do
				local title, level, _, isHeader, _, isComplete, _, questID = GetQuestLogTitle(i)
				if title and not isHeader then
					table.insert(list, {
						id = questID,
						title = title,
						level = level or 0,
						zone = type(GetZoneText) == "function" and GetZoneText() or "",
						done = isComplete == 1 or isComplete == true,
					})
				end
			end
		end
	end
	return list
end

local function CollectGear()
	local slots = {}
	for slot = 1, 19 do
		local link = type(GetInventoryItemLink) == "function" and GetInventoryItemLink("player", slot)
		local id = link and link:match("item:(%d+)")
		local ilvl = nil
		if link and type(C_Item) == "table" and type(C_Item.GetDetailedItemLevelInfo) == "function" then
			local ok, lvl = pcall(C_Item.GetDetailedItemLevelInfo, link)
			if ok and type(lvl) == "number" then
				ilvl = lvl
			end
		end
		slots[#slots + 1] = {
			slot = slot,
			id = id and tonumber(id) or nil,
			link = link or nil,
			ilvl = ilvl,
		}
	end
	return slots
end

local function AuctionItemName(itemKey)
	local ok, info = pcall(C_AuctionHouse.GetItemKeyInfo, itemKey)
	if ok and type(info) == "table" and info.itemName then return info.itemName end
	local ok2, name = pcall((C_Item and C_Item.GetItemInfo) or GetItemInfo, itemKey.itemID)
	return ok2 and name or ""
end

local function SaveBrowseResults()
	if type(C_AuctionHouse) ~= "table" or type(C_AuctionHouse.GetBrowseResults) ~= "function" then
		print("AH API not available; shift-click items into the chat instead.")
		return
	end
	local items = {}
	local ok, results = pcall(C_AuctionHouse.GetBrowseResults)
	if ok and type(results) == "table" then
		for _, r in ipairs(results) do
			if #items >= MAX_AH_ITEMS then break end
			if type(r) == "table" and type(r.itemKey) == "table" then
				items[#items + 1] = {
					id = r.itemKey.itemID,
					name = AuctionItemName(r.itemKey),
					price = r.minPrice or 0,
					qty = r.totalQuantity or 0,
					seen = time(),
				}
			end
		end
	end
	if #items == 0 then
		print("Nothing to save yet: search for an item at the auction house, then press Scan for AI again.")
		return
	end
	UpdateBulk("ah", { items = items })
	print("Saved " .. #items .. " auctions for the AI: /reload to send them.")
end

local function EnsureAHFrame()
	if ahFrame then return ahFrame end
	local parent = AuctionHouseFrame or AuctionFrame or UIParent
	ahFrame = CreateFrame("Frame", "WoWAIAHScanFrame", parent)
	ahFrame:SetSize(120, 30)
	-- Below the frame, level with the Buy/Sell/Auctions tabs: inside it, the button covered the auction house's own Search button.
	ahFrame:SetPoint("TOPRIGHT", parent, "BOTTOMRIGHT", -4, 2)
	local btn = CreateFrame("Button", nil, ahFrame, "UIPanelButtonTemplate")
	btn:SetSize(110, 24)
	btn:SetPoint("CENTER", ahFrame, "CENTER", 0, 0)
	btn:SetText("Scan for AI")
	btn:SetScript("OnClick", SaveBrowseResults)
	btn:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Scan for AI", 1, 0.82, 0)
		GameTooltip:AddLine("Saves the auctions in the list for the AI. Search for an item first, then click. /reload sends them.", 1, 1, 1, true)
		GameTooltip:Show()
	end)
	btn:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ahFrame.btn = btn
	ahFrame:Hide()
	return ahFrame
end

local function HandleAH()
	print("Search at the auction house, then click Scan for AI: it saves the auctions on screen for the AI.")
end

local function HandleQuests()
	local list = CollectQuests()
	UpdateBulk("quests", { list = list })
	print("Quests saved: /reload to send it to the AI.")
end

local function HandleGear()
	local slots = CollectGear()
	UpdateBulk("gear", { slots = slots })
	print("Gear saved: /reload to send it to the AI.")
end

local function OnEvent(event, ...)
	if event == "ZONE_CHANGED_NEW_AREA" then
		local zone = type(GetZoneText) == "function" and GetZoneText() or ""
		AppendJournal("zone", zone)
	elseif event == "PLAYER_LEVEL_UP" then
		local lvl = ...
		local s = tostring(lvl or (type(UnitLevel) == "function" and UnitLevel("player")) or "")
		AppendJournal("level", s)
	elseif event == "PLAYER_DEAD" then
		local zone = type(GetZoneText) == "function" and GetZoneText() or ""
		AppendJournal("death", zone)
	elseif event == "QUEST_TURNED_IN" then
		local qid = ...
		AppendJournal("quest", tostring(qid or ""))
	elseif event == "SCREENSHOT_SUCCEEDED" then
		AppendJournal("shot", tostring(time()))
	elseif event == "ENCOUNTER_END" then
		local _, name, _, _, success = ...
		if success == 1 or success == true then
			AppendJournal("kill", tostring(name or ""))
		end
	elseif event == "AUCTION_HOUSE_SHOW" then
		local f = EnsureAHFrame()
		f:Show()
	elseif event == "AUCTION_HOUSE_CLOSED" then
		if ahFrame then ahFrame:Hide() end
	elseif event == "PLAYER_LOGOUT" then
		local bulk = EnsureBulk()
		bulk.journal.logout = true
		bulk.journal.version = (bulk.journal.version or 0) + 1
		bulk.journal.at = time()
	end
end

local function Init()
	local bulk = EnsureBulk()
	if bulk.journal.logout then
		bulk.journal.logout = false
		bulk.journal.events = {}
		bulk.journal.at = time()
	end
end

WoWAIForever.Register({
	name = "bulk",
	init = Init,
	events = {
		ZONE_CHANGED_NEW_AREA = true,
		PLAYER_LEVEL_UP = true,
		PLAYER_DEAD = true,
		QUEST_TURNED_IN = true,
		SCREENSHOT_SUCCEEDED = true,
		ENCOUNTER_END = true,
		AUCTION_HOUSE_SHOW = true,
		AUCTION_HOUSE_CLOSED = true,
		PLAYER_LOGOUT = true,
	},
	onEvent = OnEvent,
	commands = {
		ah = HandleAH,
		quests = HandleQuests,
		gearsnap = HandleGear,
	},
})
