-- Quest reward question: when a quest offers a choice of rewards, a small button
-- next to the reward window puts the offered items into the question box. The
-- player still presses Enter to send it and still picks and clicks the reward;
-- nothing is chosen, accepted or turned in for them. It only reads the item names
-- the game shows in the window, stays hidden in a fight and while the AI is off,
-- and is a separate frame (no Blizzard function or frame method is replaced).
local button, choices = nil, nil

local function ItemName(i)
	local link = type(GetQuestItemLink) == "function" and GetQuestItemLink("choice", i)
	return type(link) == "string" and link:match("%[(.-)%]") or nil
end

local function Names()
	local n = type(GetNumQuestChoices) == "function" and tonumber(GetNumQuestChoices()) or 0
	local names = {}
	for i = 1, math.min(n, 6) do names[#names + 1] = ItemName(i) end
	return names
end

local function Question(names)
	local level = type(UnitLevel) == "function" and UnitLevel("player") or nil
	return "I can pick one quest reward" .. (level and (" at level " .. level) or "") .. ": "
		.. table.concat(names, ", ") .. ". Which fits my class and spec best?"
end

local function Hide() if button then button:Hide() end end

local function Make()
	button = CreateFrame("Button", "RunbackQuestAsk", UIParent, "UIPanelButtonTemplate")
	button:SetSize(110, 22)
	button:SetText("Ask Runback")
	button:SetScript("OnClick", function()
		if RunbackForever.Locked and RunbackForever.Locked() then return end
		local c = Runback and Runback.internal and Runback.internal.ActiveChat()
		if not (c and choices and Runback.AskInBox) then return end
		Runback.AskInBox(c.id, Question(choices))
	end)
	if QuestFrame then
		button:SetPoint("TOPLEFT", QuestFrame, "BOTTOMLEFT", 20, 6)
		if QuestFrame.HookScript then QuestFrame:HookScript("OnHide", Hide) end
	else
		button:SetPoint("CENTER", UIParent, "CENTER", 0, -200)
	end
end

RunbackForever.Register({
	name = "quest",
	events = { QUEST_COMPLETE = true, QUEST_FINISHED = true },
	onEvent = function(event)
		if event ~= "QUEST_COMPLETE" then Hide(); return end
		choices = nil
		if RunbackForeverDB and RunbackForeverDB.off then return Hide() end
		if RunbackForever.Locked and RunbackForever.Locked() then return Hide() end
		local names = Names()
		if #names < 2 then return Hide() end
		for _, name in ipairs(names) do if not name then return Hide() end end
		choices = names
		if not button then Make() end
		button:Show()
	end,
})
