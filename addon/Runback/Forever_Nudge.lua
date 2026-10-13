-- Nudges: after the player levels up or accepts a quest, one chat line offers a
-- ready question ("what changes at this level?", "explain this quest"). Clicking
-- it opens the window with the question typed in the box; the player still
-- presses Enter. A nudge waits until the lockout (combat, encounter, challenge
-- run) is over, and says nothing while the AI is off. The newest nudge replaces
-- an older one that has not been shown yet.
local pending
local lastTitle

local function Offer()
	if not pending then return end
	if RunbackForever.Locked and RunbackForever.Locked() then return end
	local nudge = pending
	pending = nil
	if RunbackForeverDB and RunbackForeverDB.off then return end
	local c = Runback and Runback.internal and Runback.internal.ActiveChat()
	if not c then return end
	Runback.askText = nudge.text
	print("|cff7ec8ff[Runback]|r " .. nudge.lead .. " |Hrunback:ask:" .. c.id .. "|h|cff55ff55[" .. nudge.label .. "]|r|h")
end

local function LookupTitle(logIndex, questId)
	local title
	if type(C_QuestLog) == "table" and type(C_QuestLog.GetTitleForQuestID) == "function" and tonumber(questId) then
		local ok, t = pcall(C_QuestLog.GetTitleForQuestID, questId)
		if ok and type(t) == "string" and t ~= "" then title = t end
	end
	if not title and type(GetQuestLogTitle) == "function" and tonumber(logIndex) then
		local ok, t = pcall(GetQuestLogTitle, logIndex)
		if ok and type(t) == "string" and t ~= "" then title = t end
	end
	return title
end

-- The client names the accepted quest by log index (older builds) or quest id (newer).
local function QuestTitle(a, b)
	-- The remembered window title is good for one accept only, so a later accept
	-- (an auto-accepted quest, say) can't be named after an earlier quest.
	local title = LookupTitle(a, b) or LookupTitle(nil, a) or lastTitle
	lastTitle = nil
	return title
end

RunbackForever.On("LOCKOUT_CHANGED", function(locked) if not locked then Offer() end end)

RunbackForever.Register({
	name = "nudge",
	events = { PLAYER_LEVEL_UP = true, QUEST_DETAIL = true, QUEST_ACCEPTED = true },
	onEvent = function(event, a, b)
		if event == "PLAYER_LEVEL_UP" then
			local level = tonumber(a) or (type(UnitLevel) == "function" and UnitLevel("player")) or nil
			pending = {
				lead = "Level " .. tostring(level) .. "!", label = "what changes at this level?",
				text = "I just reached level " .. tostring(level) .. ". What changes at this level?",
			}
		elseif event == "QUEST_DETAIL" then
			-- The quest text is open: remember its title for the accept that may follow.
			local t = type(GetTitleText) == "function" and GetTitleText() or nil
			lastTitle = (type(t) == "string" and t ~= "") and t or nil
			return
		else
			-- The client names the quest by log index (older builds) or quest id (newer).
			local title = QuestTitle(a, b)
			local what = title and ("the quest \"" .. title:gsub("[%c\"]", "") .. "\"") or "a new quest"
			pending = {
				lead = "Quest accepted.", label = "explain this quest",
				text = "I just accepted " .. what .. ". Explain what it asks of me, without spoilers.",
			}
		end
		Offer()
	end,
})
