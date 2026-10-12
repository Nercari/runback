-- Guide panel (backlog 69): a small window with the current step of a leveling
-- guide and the next two, Previous / Next buttons, a guide picker and a hide
-- button. Read only: it shows text the player follows by hand and changes
-- nothing in the game. The guides come from Guide.lua (WoWAIGuide.List); the text
-- is AI-written, so the panel hides while the lockout is on (combat, encounter,
-- challenge run) and comes back after, like the chat window (Forever_Calm.lua).
-- A step ticks itself off when the quest log shows it done (backlog 70), or by
-- hand with the Tick button. A Why? button by each step puts a question about it
-- in the chat box (backlog 75); the player sends it. The Re-plan button does the
-- same with a request for a new guide from the player's current point (backlog 73).
-- State lives in WoWAIGuideDB.panel = { shown, guide = id, step = { [id] = n }, pos,
-- ticks = { [id] = { [n] = { done, at } } } }.
local M = {}
WoWAIGuidePanel = M
local SHOWN_STEPS = 3
local KIND = { accept = "Accept", ["do"] = "Do", turnin = "Turn in", travel = "Go", train = "Train", buy = "Buy", note = "Note" }

local function Panel()
	WoWAIGuideDB = WoWAIGuideDB or {}
	local p = WoWAIGuideDB.panel
	if type(p) ~= "table" then p = {}; WoWAIGuideDB.panel = p end
	if type(p.step) ~= "table" then p.step = {} end
	if type(p.ticks) ~= "table" then p.ticks = {} end
	return p
end

local function Guides() return WoWAIGuide and WoWAIGuide.List() or {} end
local function Locked() return WoWAIForever.Locked and WoWAIForever.Locked() ~= nil end

-- Pure step logic -------------------------------------------------------------

local function Has(list, a, b)
	if type(list) ~= "table" then return true end
	local function norm(s) return type(s) == "string" and s:lower():gsub("[%s'%-]", "") or nil end
	a, b = norm(a), norm(b)
	for _, name in ipairs(list) do
		local n = norm(name)
		if n and (n == a or n == b) then return true end
	end
	return false
end

-- Whether a step's filters (docs/GUIDE.md) let this player see it. who = { level,
-- class, classToken, race, raceToken, faction }; an unknown value passes.
function M.Visible(step, who)
	who = who or {}
	local lv, l = tonumber(who.level), step.level
	if lv and type(l) == "table" and (lv < (tonumber(l.min) or lv) or lv > (tonumber(l.max) or lv)) then return false end
	if who.faction and type(step.faction) == "string" and step.faction:lower() ~= who.faction:lower() then return false end
	if who.class and not Has(step.class, who.class, who.classToken) then return false end
	if who.race and not Has(step.race, who.race, who.raceToken) then return false end
	return true
end

-- Positions (in guide.steps) of the steps this player sees, in order.
function M.Order(guide, who)
	local order = {}
	for i, s in ipairs(guide and guide.steps or {}) do
		if M.Visible(s, who) then order[#order + 1] = i end
	end
	return order
end

-- Where `cur` falls in order: its own place, else the next visible step, else the last.
local function Place(order, cur)
	cur = tonumber(cur) or 1
	for k, i in ipairs(order) do if i >= cur then return k end end
	return #order
end

-- The current step and up to n - 1 after it: returns { positions }, place, total.
function M.Window(order, cur, n)
	local k = Place(order, cur)
	local list = {}
	for j = k, math.min(#order, k + (n or SHOWN_STEPS) - 1) do list[#list + 1] = order[j] end
	return list, k, #order
end

-- The step position after moving delta visible steps, clamped to the ends.
function M.Move(order, cur, delta)
	if #order == 0 then return 1 end
	local k = math.max(1, math.min(#order, Place(order, cur) + delta))
	return order[k]
end

-- Progress from the quest log (backlog 70) ---------------------------------------
-- A quest's state is one number: 0 not in the log, 1 in the log, 2 objectives
-- complete, 3 turned in. A step kind is done once its quest reaches NEED[kind].
-- Read only: the log, the completed flag and the QUEST_TURNED_IN event.
local NEED = { accept = 1, ["do"] = 2, turnin = 3 }
local turnedIn = {} -- quest ids seen in QUEST_TURNED_IN this session

local function Results(ok, ...) if ok then return ... end end
local function Call(fn, ...)
	if type(fn) ~= "function" then return nil end
	return Results(pcall(fn, ...))
end
local function Api(namespace, name) return type(namespace) == "table" and namespace[name] or nil end
local function Yes(v) return v == true or v == 1 end

local function AllFinished(list)
	if type(list) ~= "table" or #list == 0 then return false end
	for _, o in ipairs(list) do
		if type(o) ~= "table" or o.finished ~= true then return false end
	end
	return true
end

local function ModernLog(out)
	local n = Call(Api(C_QuestLog, "GetNumQuestLogEntries"))
	if type(n) ~= "number" or not Api(C_QuestLog, "GetInfo") then return false end
	for i = 1, math.min(n, 200) do
		local info = Call(C_QuestLog.GetInfo, i)
		local id = type(info) == "table" and not info.isHeader and tonumber(info.questID)
		if id and id > 0 then
			local done = Yes(info.isComplete) or Yes(Call(Api(C_QuestLog, "IsComplete"), id))
				or AllFinished(Call(Api(C_QuestLog, "GetQuestObjectives"), id))
			out[id] = done and 2 or 1
		end
	end
	return true
end

local function ClassicLog(out)
	local n = Call(GetNumQuestLogEntries)
	if type(n) ~= "number" or type(GetQuestLogTitle) ~= "function" then return end
	for i = 1, math.min(n, 200) do
		local title, _, _, isHeader, _, isComplete, _, id = Call(GetQuestLogTitle, i)
		id = tonumber(id)
		if title and not isHeader and id and id > 0 then
			local done = Yes(isComplete)
			local count = Call(GetNumQuestLeaderBoards, i)
			if not done and type(count) == "number" and count > 0 then
				done = true
				for j = 1, count do
					local _, _, finished = Call(GetQuestLogLeaderBoard, j, i)
					if not Yes(finished) then done = false end
				end
			end
			out[id] = done and 2 or 1
		end
	end
end

-- One read of the quest log. Returns a function questId -> state (0 to 3).
function M.Snapshot()
	local log = {}
	if not ModernLog(log) then ClassicLog(log) end
	local flagged = Api(C_QuestLog, "IsQuestFlaggedCompleted") or IsQuestFlaggedCompleted
	local seen = {}
	return function(id)
		id = tonumber(id)
		if not id then return 0 end
		if seen[id] == nil then seen[id] = (turnedIn[id] or Yes(Call(flagged, id))) and 3 or log[id] or 0 end
		return seen[id]
	end
end

-- Whether a step is done. A hand tick or untick ({ done, at }) wins while the
-- quest is still in the state it was in when the player clicked.
function M.Done(step, state, mark)
	local now = step.questId and state(step.questId) or 0
	if type(mark) == "table" and mark.at == now then return mark.done == true end
	local need = step.questId and NEED[step.kind]
	return need ~= nil and now >= need
end

-- "/wow-ai guide <rest>": returns the subcommand and its argument, or nil when the
-- text is a message for the agent ("guide me to Goldshire").
local WORDS = { show = 0, hide = 0, next = 0, prev = 0, list = 0, tick = 0, pick = 1 }
function M.Parse(rest)
	local cmd, arg = (rest or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = cmd:lower()
	if cmd == "" then return "toggle", "" end
	if cmd == "back" or cmd == "previous" then cmd = "prev" end
	local want = WORDS[cmd]
	if want == 0 and arg == "" then return cmd, "" end
	if want == 1 and arg ~= "" and not arg:find("%s") then return cmd, arg end
	return nil
end

-- Panel state ----------------------------------------------------------------

local function Who()
	local who = { level = UnitLevel("player") }
	who.class, who.classToken = UnitClass("player")
	who.race, who.raceToken = UnitRace("player")
	if type(UnitFactionGroup) == "function" then who.faction = UnitFactionGroup("player") end
	return who
end

local function Current()
	local list, p = Guides(), Panel()
	if #list == 0 then return nil end
	for _, g in ipairs(list) do if g.id == p.guide then return g end end
	p.guide = list[#list].id -- the newest guide until the player picks one
	return list[#list]
end

local function Plain(s) return (tostring(s or ""):gsub("|", "||")) end

local function StepLine(s, done)
	local line = (KIND[s.kind] or "Step") .. ": " .. Plain(s.text)
	if type(s.quest) == "string" and s.quest ~= "" and not s.text:find(s.quest, 1, true) then line = line .. " (" .. Plain(s.quest) .. ")" end
	if s.optional then line = line .. " (optional)" end
	if done then line = line .. " (done)" end
	return line
end

local function Marks(g)
	local ticks = Panel().ticks
	if type(ticks[g.id]) ~= "table" then ticks[g.id] = {} end
	return ticks[g.id]
end

local function IsDone(g, i, state) return M.Done(g.steps[i], state, Marks(g)[i]) end

-- What the panel shows: a header, up to three step lines and their step positions.
function M.Lines()
	local g = Current()
	if not g then return "Guide", { "No guide yet. Ask the mentor: /ai make me a leveling guide" }, {} end
	local order = M.Order(g, Who())
	local list, k, total = M.Window(order, Panel().step[g.id], SHOWN_STEPS)
	local state = M.Snapshot()
	local lines = {}
	for _, i in ipairs(list) do lines[#lines + 1] = StepLine(g.steps[i], IsDone(g, i, state)) end
	if #lines == 0 then lines[1] = "No step in this guide fits your character." end
	return Plain(g.title or g.id) .. "  " .. (total > 0 and (k .. "/" .. total) or ""), lines, list
end

-- Explain this step (backlog 75): the question about step i of the current guide.
local function Clean(s) return (tostring(s):gsub("[%c\"|]", "")) end
function M.Question(step)
	local text = "Why this step, and what do I need? Guide step: \"" .. (KIND[step.kind] or "Step") .. ": " .. Clean(step.text) .. "\""
	if type(step.quest) == "string" and step.quest ~= "" then text = text .. " Quest: \"" .. Clean(step.quest) .. "\"" end
	return text .. "."
end

-- Out of combat only, it types the question in the box and sends nothing.
function M.Explain(i)
	if Locked() then return end
	local g = Current()
	local step = g and g.steps[tonumber(i) or 0]
	local c = WoWAI and WoWAI.internal and WoWAI.internal.ActiveChat()
	if not (step and c and WoWAI.AskInBox) then return end
	WoWAI.AskInBox(c.id, M.Question(step))
end

-- Re-plan from here (backlog 73): level, zone and quest log already travel with every
-- message (the game context), so the question adds only the guide, its current step
-- and how many steps are done. With no guide it asks for a new one.
function M.ReplanQuestion()
	local g = Current()
	local text = "Re-plan my leveling guide from here: I skipped steps or took another route. Use my level, zone and quest log from the game context and write a new guide for what comes next, under a new id."
	if not g then return "Make me a leveling guide from here. Use my level, zone and quest log from the game context." end
	local order = M.Order(g, Who())
	local state, done = M.Snapshot(), 0
	for _, i in ipairs(order) do if IsDone(g, i, state) then done = done + 1 end end
	text = text .. " Current guide: \"" .. Clean(g.title or g.id) .. "\" (" .. Clean(g.id) .. ")."
	local cur = g.steps[order[Place(order, Panel().step[g.id])] or 0]
	if cur then text = text .. " Current step: \"" .. (KIND[cur.kind] or "Step") .. ": " .. Clean(cur.text) .. "\"." end
	return text .. " Steps done: " .. done .. " of " .. #order .. "."
end

-- Out of combat only, it types the request in the box and sends nothing.
function M.Replan()
	if Locked() then return end
	local c = WoWAI and WoWAI.internal and WoWAI.internal.ActiveChat()
	if not (c and WoWAI.AskInBox) then return end
	WoWAI.AskInBox(c.id, M.ReplanQuestion())
end

-- Frame ----------------------------------------------------------------------

local frame, rows, asks, header, picker

local function Build()
	if frame then return frame end
	local f = CreateFrame("Frame", "WoWAIGuideFrame", UIParent, "BackdropTemplate")
	f:SetSize(360, 120)
	local pos = Panel().pos
	if type(pos) == "table" and tonumber(pos.x) and tonumber(pos.y) then
		f:SetPoint("CENTER", UIParent, "BOTTOMLEFT", pos.x, pos.y)
	else
		f:SetPoint("RIGHT", UIParent, "RIGHT", -40, 120)
	end
	f:SetClampedToScreen(true)
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", function(self) self:StartMoving() end)
	f:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local x, y = self:GetCenter()
		if x and y then Panel().pos = { x = x, y = y } end
	end)
	if type(f.SetBackdrop) == "function" then
		f:SetBackdrop({
			bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 16,
			insets = { left = 4, right = 4, top = 4, bottom = 4 },
		})
		if type(f.SetBackdropColor) == "function" then f:SetBackdropColor(0.05, 0.05, 0.07, 0.9) end
	end
	header = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	header:SetPoint("TOPLEFT", f, "TOPLEFT", 10, -9)
	header:SetPoint("RIGHT", f, "RIGHT", -100, 0)
	header:SetJustifyH("LEFT")
	rows = {}
	for i = 1, SHOWN_STEPS do
		local r = f:CreateFontString(nil, "OVERLAY", i == 1 and "GameFontHighlight" or "GameFontDisableSmall")
		r:SetPoint("TOPLEFT", f, "TOPLEFT", 10, -12 - i * 18)
		r:SetPoint("RIGHT", f, "RIGHT", -54, 0)
		r:SetJustifyH("LEFT")
		r:SetWordWrap(false)
		rows[i] = r
	end
	asks = {}
	for i = 1, SHOWN_STEPS do
		local b = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
		b:SetSize(40, 18)
		b:SetPoint("TOPRIGHT", f, "TOPRIGHT", -10, -10 - i * 18)
		b:SetText("Why?")
		b:SetScript("OnClick", function(self) M.Explain(self.step) end)
		asks[i] = b
	end
	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -2, -2)
	close:SetScript("OnClick", function() M.SetShown(false) end)
	local function Btn(text, width, x, fn)
		local b = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
		b:SetSize(width, 20)
		b:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", x, 8)
		b:SetText(text)
		b:SetScript("OnClick", fn)
		return b
	end
	f.prev = Btn("Previous", 72, 8, function() M.Step(-1) end)
	f.next = Btn("Next", 60, 82, function() M.Step(1) end)
	f.tick = Btn("Tick", 64, 144, function() M.Tick() end)
	local replan = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	replan:SetSize(66, 18)
	replan:SetPoint("TOPRIGHT", f, "TOPRIGHT", -30, -6)
	replan:SetText("Re-plan")
	replan:SetScript("OnClick", function() M.Replan() end)
	picker = Btn("Pick guide", 140, 210, function() M.Cycle() end)
	f:Hide()
	frame = f
	return f
end

function M.Refresh()
	local p = Panel()
	local want = p.shown and not Locked()
	if not want then
		if frame then frame:Hide() end
		return
	end
	Build()
	local title, lines, list = M.Lines()
	header:SetText(title)
	for i, r in ipairs(rows) do r:SetText(lines[i] or "") end
	for i, b in ipairs(asks) do
		b.step = list[i]
		b:SetShown(list[i] ~= nil)
	end
	local g = Current()
	local order = g and M.Order(g, Who()) or {}
	local cur = order[Place(order, g and p.step[g.id])]
	frame.tick:SetText(cur and IsDone(g, cur, M.Snapshot()) and "Untick" or "Tick")
	local count = #Guides()
	picker:SetText(count > 1 and ("Next guide (" .. count .. ")") or "Pick guide")
	frame:Show()
end

function M.SetShown(v)
	Panel().shown = v and true or false
	M.Refresh()
end

function M.Step(delta)
	local g = Current()
	if not g then return end
	local p = Panel()
	p.step[g.id] = M.Move(M.Order(g, Who()), p.step[g.id], delta)
	M.Refresh()
end

-- Steps this session has already seen done, per guide: the panel moves on only
-- when the current step turns done, so Previous back onto a done step stays put.
local seenDone = {}

-- Re-read the quest log; when the current step has just turned done, move past it
-- and every done step after it.
function M.Evaluate()
	local g = Current()
	if g then
		local p, state = Panel(), M.Snapshot()
		local order = M.Order(g, Who())
		local seen = seenDone[g.id] or {}
		local k = Place(order, p.step[g.id])
		if order[k] and not seen[order[k]] and IsDone(g, order[k], state) then
			while k < #order and IsDone(g, order[k], state) do k = k + 1 end
			p.step[g.id] = order[k]
		end
		local now = {}
		for _, i in ipairs(order) do if IsDone(g, i, state) then now[i] = true end end
		seenDone[g.id] = now
	end
	M.Refresh()
end

-- Tick or untick the current step by hand. The mark holds until the quest's
-- state changes; ticking moves on like a step the log ticked.
function M.Tick()
	local g = Current()
	if not g then return end
	local p, state = Panel(), M.Snapshot()
	local order = M.Order(g, Who())
	local i = order[Place(order, p.step[g.id])]
	if not i then return end
	local step = g.steps[i]
	local marks = Marks(g)
	local want = not IsDone(g, i, state)
	marks[i] = nil
	if M.Done(step, state, nil) ~= want then
		marks[i] = { done = want, at = step.questId and state(step.questId) or 0 }
	end
	M.Evaluate()
end

-- Choose a guide by number or id, or the next one in the list when nil.
function M.Pick(which)
	local list = Guides()
	if #list == 0 then return false end
	local p = Panel()
	local target = list[tonumber(which) or 0]
	if not target and which then
		for _, g in ipairs(list) do if g.id == which then target = g end end
	end
	if not target and not which then
		local at = 0
		for i, g in ipairs(list) do if g.id == p.guide then at = i end end
		target = list[at % #list + 1]
	end
	if not target then return false end
	p.guide = target.id
	M.Refresh()
	return true
end

function M.Cycle() M.Pick(nil) end

local function Say(text) print("|cff66ccff[WoW AI]|r " .. text) end

local function Command(rest)
	local cmd, arg = M.Parse(rest)
	if not cmd then
		WoWAI.Send("guide " .. (rest or ""))
		return
	end
	if Locked() and cmd ~= "hide" then
		Say("The guide shows when the fight ends.")
		return
	end
	if cmd == "toggle" then M.SetShown(not Panel().shown)
	elseif cmd == "show" then M.SetShown(true)
	elseif cmd == "hide" then M.SetShown(false)
	elseif cmd == "next" then M.Step(1)
	elseif cmd == "prev" then M.Step(-1)
	elseif cmd == "tick" then M.Tick()
	elseif cmd == "pick" then
		if not M.Pick(arg) then Say("No guide " .. Plain(arg) .. ". /wow-ai guide list shows them.") end
	elseif cmd == "list" then
		local list = Guides()
		if #list == 0 then Say("No guide yet. Ask the mentor: /ai make me a leveling guide") end
		for i, g in ipairs(list) do
			Say(i .. ". " .. Plain(g.title or g.id) .. " (" .. g.id .. ", " .. #g.steps .. " steps)" .. (g.id == Panel().guide and "  (current)" or ""))
		end
	end
end
M.Command = Command

-- Quest data can arrive after its event, so every event reads the log now and
-- once more a second later.
local retryQueued = false
local function OnEvent(event, questId)
	if event == "QUEST_TURNED_IN" and tonumber(questId) then turnedIn[tonumber(questId)] = true end
	M.Evaluate()
	if not retryQueued and C_Timer and type(C_Timer.After) == "function" then
		retryQueued = true
		C_Timer.After(1, function() retryQueued = false; M.Evaluate() end)
	end
end

WoWAIForever.On("LOCKOUT_CHANGED", function() M.Refresh() end)
if WoWAIGuide then hooksecurefunc(WoWAIGuide, "Sync", function() M.Evaluate() end) end

WoWAIForever.Register({
	name = "guide",
	init = function() M.Evaluate() end,
	events = {
		QUEST_ACCEPTED = true, QUEST_TURNED_IN = true, QUEST_REMOVED = true,
		QUEST_WATCH_UPDATE = true, QUEST_LOG_UPDATE = true, PLAYER_LEVEL_UP = true,
	},
	onEvent = OnEvent,
	commands = { guide = Command },
})
