-- What the player already has, read from the game's own UI API (backlog 60, 61):
-- the quests they watch, with objectives, on every message; and their spellbook
-- with ranks on build, rotation and review requests. Read only. A missing API
-- leaves its line out.

local QUESTS_MAX, OBJECTIVES_MAX, OBJECTIVE_CHARS = 5, 4, 48
local WATCH_CHARS, SPELLBOOK_CHARS = 290, 680
local SPELLBOOK_KINDS = { build = true, review = true, rotation = true }

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

-- Each source returns the watched quests as { id, title, objectives = { { text, done } } },
-- or nil when this client lacks its API. The modern one is tried first.
local function ModernWatched()
	local count = Call(Api(C_QuestLog, "GetNumQuestWatches"))
	local idAt = Api(C_QuestLog, "GetQuestIDForQuestWatchIndex")
	if type(count) ~= "number" or not idAt then return nil end
	local out = {}
	for i = 1, math.min(count, QUESTS_MAX) do
		local id = Call(idAt, i)
		if type(id) == "number" and id > 0 then
			local q = { id = id, title = Call(Api(C_QuestLog, "GetTitleForQuestID"), id), objectives = {} }
			local list = Call(Api(C_QuestLog, "GetQuestObjectives"), id)
			for _, o in ipairs(type(list) == "table" and list or {}) do
				if type(o) == "table" and type(o.text) == "string" then
					q.objectives[#q.objectives + 1] = { text = o.text, done = o.finished == true }
				end
			end
			out[#out + 1] = q
		end
	end
	return out
end

local function ClassicWatched()
	local count = Call(GetNumQuestWatches)
	if type(count) ~= "number" or type(GetQuestIndexForWatch) ~= "function" then return nil end
	local out = {}
	for i = 1, math.min(count, QUESTS_MAX) do
		local index = Call(GetQuestIndexForWatch, i)
		if type(index) == "number" then
			local title, _, _, _, _, _, _, id = Call(GetQuestLogTitle, index)
			local q = { id = id, title = title, objectives = {} }
			local n = Call(GetNumQuestLeaderBoards, index)
			for j = 1, type(n) == "number" and n or 0 do
				local text, _, finished = Call(GetQuestLogLeaderBoard, j, index)
				if type(text) == "string" then
					q.objectives[#q.objectives + 1] = { text = text, done = finished == 1 or finished == true }
				end
			end
			out[#out + 1] = q
		end
	end
	return out
end

local function WatchedLine()
	local quests = ModernWatched() or ClassicWatched()
	if not quests or #quests == 0 then return nil end
	local parts = {}
	for _, q in ipairs(quests) do
		local s = (type(q.id) == "number" and ("[" .. q.id .. "] ") or "") .. tostring(q.title or "?")
		local objectives = {}
		for k = 1, math.min(#q.objectives, OBJECTIVES_MAX) do
			local o = q.objectives[k]
			objectives[#objectives + 1] = o.text:sub(1, OBJECTIVE_CHARS) .. (o.done and " (done)" or "")
		end
		if #objectives > 0 then s = s .. " - " .. table.concat(objectives, ", ") end
		parts[#parts + 1] = s
	end
	return ("Watched quests: " .. table.concat(parts, "; ")):sub(1, WATCH_CHARS)
end

-- The spellbook as tabs of { name, rank }: one entry per spell, its highest rank.
local PLAYER_BOOK = "spell"
local function SpellAt(index)
	local bank = Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Player
	local name, sub
	if bank and Api(C_SpellBook, "GetSpellBookItemName") then
		local info = Call(C_SpellBook.GetSpellBookItemInfo, index, bank)
		local future = Enum.SpellBookItemType and Enum.SpellBookItemType.FutureSpell
		if type(info) == "table" and future and info.itemType == future then return nil end
		name, sub = Call(C_SpellBook.GetSpellBookItemName, index, bank)
	else
		if Call(GetSpellBookItemInfo, index, PLAYER_BOOK) == "FUTURESPELL" then return nil end
		name, sub = Call(GetSpellBookItemName, index, PLAYER_BOOK)
		if not name then name, sub = Call(GetSpellName, index, PLAYER_BOOK) end
	end
	if type(name) ~= "string" or name == "" then return nil end
	return name, tonumber(type(sub) == "string" and sub:match("(%d+)") or nil)
end

local function Tabs()
	local tabs = {}
	local lines = Call(Api(C_SpellBook, "GetNumSpellBookSkillLines"))
	if type(lines) == "number" then
		for i = 1, lines do
			local info = Call(C_SpellBook.GetSpellBookSkillLineInfo, i)
			if type(info) == "table" then
				tabs[#tabs + 1] = { name = info.name, offset = info.itemIndexOffset, count = info.numSpellBookItems }
			end
		end
	else
		for i = 1, Call(GetNumSpellTabs) or 0 do
			local name, _, offset, count = Call(GetSpellTabInfo, i)
			tabs[#tabs + 1] = { name = name, offset = offset, count = count }
		end
	end
	return tabs
end

local function SpellbookLine()
	local parts, total, shown = {}, 0, 0
	for _, tab in ipairs(Tabs()) do
		if type(tab.offset) == "number" and type(tab.count) == "number" then
			local order, best = {}, {}
			for index = tab.offset + 1, tab.offset + tab.count do
				local name, rank = SpellAt(index)
				if name then
					if best[name] == nil then order[#order + 1] = name; best[name] = false end
					if rank and (best[name] == false or rank > best[name]) then best[name] = rank end
				end
			end
			local spells = {}
			for _, name in ipairs(order) do spells[#spells + 1] = best[name] and (name .. " " .. best[name]) or name end
			total = total + #spells
			if #spells > 0 then parts[#parts + 1] = { tab = tostring(tab.name or "?"), spells = spells } end
		end
	end
	if total == 0 then return nil end
	local s, sep = "Spellbook (highest rank known):", " "
	for _, p in ipairs(parts) do
		for k, spell in ipairs(p.spells) do
			local piece = (k == 1 and (sep .. p.tab .. ": ") or ", ") .. spell
			if #s + #piece > SPELLBOOK_CHARS - 12 then return s .. " +" .. (total - shown) .. " more" end
			s, shown = s .. piece, shown + 1
		end
		sep = "; "
	end
	return s
end

WoWAIForever.Register({
	name = "watched",
	context = function() return WatchedLine() end,
})

WoWAIForever.Register({
	name = "spellbook",
	context = function(kind) return SPELLBOOK_KINDS[kind] and SpellbookLine() or nil end,
})
