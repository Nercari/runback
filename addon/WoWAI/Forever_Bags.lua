-- "What can I sell or drop?" (backlog 62). The bags question carries what the
-- player carries, read from the game's own bag API: each item with its count,
-- quality, vendor price and quest flag. Read only: the addon never picks up,
-- sells, drops, moves or equips an item; the player does every action. When the
-- bags fill up, one chat line offers the question once the fight is over.

local ITEMS_MAX, BAGS_CHARS, OFFER_GAP = 60, 1200, 1800
local QUALITY = { [0] = "poor", [1] = "common", [2] = "uncommon", [3] = "rare", [4] = "epic", [5] = "legendary" }
local QUEST_ITEM_CLASS = 12
local QUESTION = "My bags are full. What can I sell or drop?"

local function Results(ok, ...)
	if ok then return ... end
end

local function Call(fn, ...)
	if type(fn) ~= "function" then return nil end
	return Results(pcall(fn, ...))
end

local function Api(namespace, name)
	return type(namespace) == "table" and namespace[name] or nil
end

local function Bags()
	return 0, tonumber(NUM_BAG_SLOTS) or 4
end

local function NumSlots(bag)
	return tonumber(Call(Api(C_Container, "GetContainerNumSlots") or GetContainerNumSlots, bag)) or 0
end

-- One bag slot as { id, name, count, quality, noValue, bound }, or nil when empty.
-- C_Container returns a table; older clients return the fields in order.
local function SlotItem(bag, slot)
	local modern = Api(C_Container, "GetContainerItemInfo")
	if modern then
		local info = Call(modern, bag, slot)
		if type(info) ~= "table" or not info.itemID then return nil end
		local name = info.itemName or (type(info.hyperlink) == "string" and info.hyperlink:match("%[(.-)%]"))
		return { id = info.itemID, name = name, count = info.stackCount or 1, quality = info.quality, noValue = info.hasNoValue, bound = info.isBound }
	end
	local _, count, _, quality, _, _, link, _, noValue, id = Call(GetContainerItemInfo, bag, slot)
	if not id then return nil end
	return { id = id, name = type(link) == "string" and link:match("%[(.-)%]") or nil, count = count or 1, quality = quality, noValue = noValue }
end

local function IsQuestItem(bag, slot, classID)
	if classID == QUEST_ITEM_CLASS then return true end
	local modern = Api(C_Container, "GetContainerItemQuestInfo")
	if modern then
		local info = Call(modern, bag, slot)
		return type(info) == "table" and (info.isQuestItem == true or info.questID ~= nil)
	end
	local isQuest, questID = Call(GetContainerItemQuestInfo, bag, slot)
	return isQuest == true or isQuest == 1 or questID ~= nil
end

-- Every item in the bags, one entry per item id, stacks added up:
-- { id, name, count, quality, price (copper each, nil = unknown), quest, reagent, bound, noValue }.
-- Also the free and total slot counts.
local function BagContents()
	local byId, items, free, total = {}, {}, 0, 0
	local first, last = Bags()
	for bag = first, last do
		local slots = NumSlots(bag)
		total = total + slots
		for slot = 1, slots do
			local item = SlotItem(bag, slot)
			if not item then
				free = free + 1
			elseif byId[item.id] then
				byId[item.id].count = byId[item.id].count + item.count
			else
				local name, _, quality, _, _, _, _, _, _, _, price, classID, _, _, _, _, reagent =
					Call(Api(C_Item, "GetItemInfo") or GetItemInfo, item.id)
				item.name = item.name or name or ("item " .. item.id)
				item.quality = item.quality or quality
				item.price = (not item.noValue) and tonumber(price) or nil
				item.quest = IsQuestItem(bag, slot, classID)
				item.reagent = reagent == true
				byId[item.id] = item
				items[#items + 1] = item
			end
		end
	end
	return items, free, total
end

local function Coins(copper)
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	return (g > 0 and (g .. "g") or "") .. (s > 0 and (s .. "s") or "") .. (c > 0 and (c .. "c") or "")
end

local function Describe(item)
	local parts = { tostring(item.name):gsub("[%c;]", " ") .. " x" .. item.count, QUALITY[item.quality] or "?" }
	if item.noValue or item.price == 0 then
		parts[#parts + 1] = "no sale"
	elseif item.price then
		parts[#parts + 1] = Coins(item.price)
	end
	if item.quest then parts[#parts + 1] = "quest" end
	if item.reagent then parts[#parts + 1] = "reagent" end
	if item.bound then parts[#parts + 1] = "bound" end
	return table.concat(parts, " ")
end

-- Quest items first (so "keep" is never cut off), then the cheapest quality first.
local function Before(a, b)
	if a.quest ~= b.quest then return a.quest end
	local qa, qb = a.quality or 1, b.quality or 1
	if qa ~= qb then return qa < qb end
	return tostring(a.name) < tostring(b.name)
end

local function BagsLine()
	local items, free, total = BagContents()
	if total == 0 then return nil end
	table.sort(items, Before)
	local s = "Bags (" .. free .. " of " .. total .. " slots free; item xcount, quality, vendor price each):"
	local sep = " "
	for i, item in ipairs(items) do
		local piece = sep .. Describe(item)
		local left = #items - i + 1
		if i > ITEMS_MAX or #s + #piece > BAGS_CHARS - 12 then return s .. "; +" .. left .. " more" end
		s, sep = s .. piece, "; "
	end
	return s
end

local function FreeSlots()
	local free, total = 0, 0
	local first, last = Bags()
	for bag = first, last do
		local slots = NumSlots(bag)
		total = total + slots
		for slot = 1, slots do
			if not SlotItem(bag, slot) then free = free + 1 end
		end
	end
	return free, total
end

local full, pending, lastOffer = false, false, nil

local function Offer()
	if not pending then return end
	if WoWAIForever.Locked and WoWAIForever.Locked() then return end
	pending = false
	if WoWAIForeverDB and WoWAIForeverDB.off then return end
	local now = type(GetTime) == "function" and GetTime() or 0
	if lastOffer and now - lastOffer < OFFER_GAP then return end
	local c = WoWAI and WoWAI.internal and WoWAI.internal.ActiveChat()
	if not c then return end
	lastOffer = now
	WoWAI.askText = QUESTION
	print("|cff7ec8ff[WoW AI]|r Bags full. |Hwowai:ask:" .. c.id .. "|h|cff55ff55[what can I sell or drop?]|r|h")
end

WoWAIForever.On("LOCKOUT_CHANGED", function(locked) if not locked then Offer() end end)

WoWAIForever.Register({
	name = "bags",
	events = { BAG_UPDATE_DELAYED = true },
	contextMax = BAGS_CHARS,
	context = function(kind) return kind == "bags" and BagsLine() or nil end,
	onEvent = function()
		local free, total = FreeSlots()
		local now = total > 0 and free == 0
		if now and not full then pending = true; Offer() end
		full = now
	end,
})
