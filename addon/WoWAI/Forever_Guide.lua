-- Guide panel (backlog 69): a small window with the current step of a leveling
-- guide and the next two, Previous / Next buttons, a guide picker and a hide
-- button. Read only: it shows text the player follows by hand and changes
-- nothing in the game. The guides come from Guide.lua (WoWAIGuide.List); the text
-- is AI-written, so the panel hides while the lockout is on (combat, encounter,
-- challenge run) and comes back after, like the chat window (Forever_Calm.lua).
-- A step ticks itself off when the quest log shows it done (backlog 70), or by
<<<<<<< HEAD
-- hand with the Tick button. Steps the player's own data shows closed (prerequisite
-- not turned in, an exclusive quest turned in, reputation or profession too low)
-- are skipped, and an XP pace line shows under the steps (backlog 76).
=======
-- hand with the Tick button. A Why? button by each step puts a question about it
-- in the chat box (backlog 75); the player sends it.
>>>>>>> origin/forever
-- State lives in WoWAIGuideDB.panel = { shown, guide = id, step = { [id] = n }, pos,
-- ticks = { [id] = { [n] = { done, at } } } }, and time per level in
-- WoWAIGuideDB.levels = { ["Name-Realm"] = { [level] = { at, sec } } }.
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

local function Norm(s) return type(s) == "string" and (s:lower():gsub("[%s'%-]", "")) or nil end

local function Has(list, a, b)
	if type(list) ~= "table" then return true end
	a, b = Norm(a), Norm(b)
	for _, name in ipairs(list) do
		local n = Norm(name)
		if n and (n == a or n == b) then return true end
	end
	return false
end

local function Ask(fn, x) if type(fn) == "function" then return fn(x) end end

-- Availability rules (backlog 76), keyed by step field. Each says false only when
-- the player's own data shows the step closed; an unknown answer (nil) passes.
local RULES = {
	requires = function(ids, who)
		for _, id in ipairs(ids) do if Ask(who.turned, id) == false then return false end end
		return true
	end,
	exclusive = function(ids, who)
		for _, id in ipairs(ids) do if Ask(who.turned, id) == true then return false end end
		return true
	end,
	rep = function(r, who)
		local s = Ask(who.standing, r.faction)
		return s == nil or s >= (tonumber(r.standing) or 0)
	end,
	profession = function(p, who)
		local s = Ask(who.skill, p.name)
		return s == nil or s >= (tonumber(p.skill) or 0)
	end,
}

-- Whether this player can see a step: its filters (docs/GUIDE.md) and, while its
-- quest is neither in the log nor turned in, the availability rules. who = { level,
-- class, classToken, race, raceToken, faction, quest, turned, standing, skill },
-- the last four being lookups; an unknown value or a missing lookup passes.
function M.Visible(step, who)
	who = who or {}
	local lv, l = tonumber(who.level), step.level
	if lv and type(l) == "table" and (lv < (tonumber(l.min) or lv) or lv > (tonumber(l.max) or lv)) then return false end
	if who.faction and type(step.faction) == "string" and step.faction:lower() ~= who.faction:lower() then return false end
	if who.class and not Has(step.class, who.class, who.classToken) then return false end
	if who.race and not Has(step.race, who.race, who.raceToken) then return false end
	if step.questId and (tonumber(Ask(who.quest, step.questId)) or 0) > 0 then return true end
	for field, rule in pairs(RULES) do
		if type(step[field]) == "table" and not rule(step[field], who) then return false end
	end
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

-- The current step and up to n - 1 after it that are not done (done(i) true):
-- returns { positions }, place, total.
function M.Window(order, cur, n, done)
	local k = Place(order, cur)
	local list = { order[k] }
	for j = k + 1, #order do
		if #list >= (n or SHOWN_STEPS) then break end
		if not (done and done(order[j])) then list[#list + 1] = order[j] end
	end
	return list, k, #order
end

-- The step position after moving delta visible steps, clamped to the ends. Moving
-- forward passes over steps that are done (done(i) true).
function M.Move(order, cur, delta, done)
	if #order == 0 then return 1 end
	local k = math.max(1, math.min(#order, Place(order, cur) + delta))
	while delta > 0 and k < #order and done and done(order[k]) do k = k + 1 end
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

-- One read of the quest log. Returns two lookups: questId -> state (0 to 3), and
-- questId -> turned in (true, false, or nil when the client cannot say).
function M.Snapshot()
	local log = {}
	if not ModernLog(log) then ClassicLog(log) end
	local flagged = Api(C_QuestLog, "IsQuestFlaggedCompleted") or IsQuestFlaggedCompleted
	local turned = {}
	local function Turned(id)
		id = tonumber(id)
		if not id then return nil end
		if turned[id] == nil then
			local v = turnedIn[id] or Call(flagged, id)
			if Yes(v) then turned[id] = true elseif v == false or log[id] then turned[id] = false else turned[id] = "?" end
		end
		if turned[id] ~= "?" then return turned[id] end
	end
	local function State(id)
		if Turned(id) then return 3 end
		return log[tonumber(id)] or 0
	end
	return State, Turned
end

-- Reputation standing (1 Hated to 8 Exalted) with a faction id, or nil.
local function Standing(id)
	local data = Call(Api(C_Reputation, "GetFactionDataByID"), id)
	if type(data) == "table" and tonumber(data.reaction) then return tonumber(data.reaction) end
	local name, _, standing = Call(GetFactionInfoByID, id)
	if name then return tonumber(standing) end
end

-- Profession ranks by name, read once: a lookup name -> rank, or nil when the client
-- lists none. A profession not listed is rank 0, unless a collapsed skill header
-- may hide it, then unknown.
function M.Skills()
	local ranks, found, complete = {}, false, true
	local a, b, c, d, e = Call(GetProfessions)
	for _, index in pairs({ a, b, c, d, e }) do
		local name, _, rank = Call(GetProfessionInfo, index)
		if type(name) == "string" and tonumber(rank) then ranks[Norm(name)] = tonumber(rank); found = true end
	end
	local n = not found and Call(GetNumSkillLines)
	for i = 1, type(n) == "number" and math.min(n, 100) or 0 do
		local name, isHeader, isExpanded, rank = Call(GetSkillLineInfo, i)
		if Yes(isHeader) then
			if not Yes(isExpanded) then complete = false end
		elseif type(name) == "string" and tonumber(rank) then
			ranks[Norm(name)] = tonumber(rank); found = true
		end
	end
	if not found then return nil end
	return function(name)
		local rank = ranks[Norm(name)]
		if rank == nil and complete then return 0 end
		return rank
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
	who.quest, who.turned = M.Snapshot()
	who.standing, who.skill = Standing, M.Skills()
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

<<<<<<< HEAD
-- The current guide, this player's view of it, the steps they see and a done(i) test.
local function View()
	local g = Current()
	if not g then return nil end
	local who = Who()
	return g, who, M.Order(g, who), function(i) return IsDone(g, i, who.quest) end
end

-- What the panel shows: a header and up to three step lines.
function M.Lines()
	local g, _, order, done = View()
	if not g then return "Guide", { "No guide yet. Ask the mentor: /ai make me a leveling guide" } end
	local list, k, total = M.Window(order, Panel().step[g.id], SHOWN_STEPS, done)
=======
-- What the panel shows: a header, up to three step lines and their step positions.
function M.Lines()
	local g = Current()
	if not g then return "Guide", { "No guide yet. Ask the mentor: /ai make me a leveling guide" }, {} end
	local order = M.Order(g, Who())
	local list, k, total = M.Window(order, Panel().step[g.id], SHOWN_STEPS)
	local state = M.Snapshot()
>>>>>>> origin/forever
	local lines = {}
	for _, i in ipairs(list) do lines[#lines + 1] = StepLine(g.steps[i], done(i)) end
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

-- Frame ----------------------------------------------------------------------

local frame, rows, asks, header, picker

local function Build()
	if frame then return frame end
	local f = CreateFrame("Frame", "WoWAIGuideFrame", UIParent, "BackdropTemplate")
	f:SetSize(360, 138)
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
	header:SetPoint("RIGHT", f, "RIGHT", -28, 0)
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
<<<<<<< HEAD
	f.pace = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.pace:SetPoint("TOPLEFT", f, "TOPLEFT", 10, -12 - (SHOWN_STEPS + 1) * 18)
	f.pace:SetPoint("RIGHT", f, "RIGHT", -10, 0)
	f.pace:SetJustifyH("LEFT")
=======
	asks = {}
	for i = 1, SHOWN_STEPS do
		local b = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
		b:SetSize(40, 18)
		b:SetPoint("TOPRIGHT", f, "TOPRIGHT", -10, -10 - i * 18)
		b:SetText("Why?")
		b:SetScript("OnClick", function(self) M.Explain(self.step) end)
		asks[i] = b
	end
>>>>>>> origin/forever
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
<<<<<<< HEAD
	frame.pace:SetText(M.PaceLine() or "")
	local g, _, order, done = View()
	local cur = g and order[Place(order, p.step[g.id])]
	frame.tick:SetText(cur and done(cur) and "Untick" or "Tick")
=======
	for i, b in ipairs(asks) do
		b.step = list[i]
		b:SetShown(list[i] ~= nil)
	end
	local g = Current()
	local order = g and M.Order(g, Who()) or {}
	local cur = order[Place(order, g and p.step[g.id])]
	frame.tick:SetText(cur and IsDone(g, cur, M.Snapshot()) and "Untick" or "Tick")
>>>>>>> origin/forever
	local count = #Guides()
	picker:SetText(count > 1 and ("Next guide (" .. count .. ")") or "Pick guide")
	frame:Show()
end

function M.SetShown(v)
	Panel().shown = v and true or false
	M.Refresh()
end

function M.Step(delta)
	local g, _, order, done = View()
	if not g then return end
	local p = Panel()
	p.step[g.id] = M.Move(order, p.step[g.id], delta, done)
	M.Refresh()
end

-- Steps this session has already seen done, per guide: the panel moves on only
-- when the current step turns done, so Previous back onto a done step stays put.
local seenDone = {}

-- Re-read the quest log; when the current step has just turned done, move past it
-- and every done step after it.
function M.Evaluate()
	local g, _, order, done = View()
	if g then
		local p = Panel()
		local seen = seenDone[g.id] or {}
		local k = Place(order, p.step[g.id])
		if order[k] and not seen[order[k]] and done(order[k]) then
			while k < #order and done(order[k]) do k = k + 1 end
			p.step[g.id] = order[k]
		end
		local now = {}
		for _, i in ipairs(order) do if done(i) then now[i] = true end end
		seenDone[g.id] = now
	end
	M.Refresh()
end

-- Tick or untick the current step by hand. The mark holds until the quest's
-- state changes; ticking moves on like a step the log ticked.
function M.Tick()
	local g, who, order = View()
	if not g then return end
	local p, state = Panel(), who.quest
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

-- XP pace and time per level (backlog 76) -----------------------------------------
-- The pace line is the XP gained in the last ten minutes of this session, from the
-- game's own UnitXP / UnitXPMax read on PLAYER_XP_UPDATE. Time per level is played
-- time counted between events, kept per character for the session recap.
local PACE_WINDOW, PACE_MIN = 600, 300
local pace = { gained = 0, samples = {} } -- gained: XP this session; samples: { t, gained }

local function LevelTimes()
	WoWAIGuideDB = WoWAIGuideDB or {}
	local db = WoWAIGuideDB
	if type(db.levels) ~= "table" then db.levels = {} end
	local key = tostring(Call(UnitName, "player") or "?") .. "-" .. tostring(Call(GetRealmName) or "?")
	if type(db.levels[key]) ~= "table" then db.levels[key] = {} end
	return db.levels[key]
end

local function LevelRecord(level)
	local t = LevelTimes()
	if type(t[level]) ~= "table" then t[level] = {} end
	return t[level]
end

-- Add the seconds since the last mark to the level being counted, then move to `level`.
local function CountTime(level)
	local now = GetTime()
	if pace.level and pace.mark then
		local r = LevelRecord(pace.level)
		r.sec = (tonumber(r.sec) or 0) + math.max(0, now - pace.mark)
	end
	pace.mark = now
	level = tonumber(level)
	if level and pace.level and level > pace.level then LevelRecord(level).at = time() end
	if level and (not pace.level or level > pace.level) then pace.level = level end
end

local function ReadXP()
	local level, xp, max = tonumber(Call(UnitLevel, "player")), tonumber(Call(UnitXP, "player")), tonumber(Call(UnitXPMax, "player"))
	CountTime(level)
	if not level or not xp or not max then return end
	local last, now = pace.last, GetTime()
	if last and level > last.level then
		pace.gained = pace.gained + math.max(0, last.max - last.xp) + xp
	elseif last and level == last.level and xp >= last.xp then
		pace.gained = pace.gained + xp - last.xp
	else
		pace.samples = {}
	end
	pace.last = { level = level, xp = xp, max = max }
	local kept = {}
	for _, s in ipairs(pace.samples) do if s.t >= now - PACE_WINDOW then kept[#kept + 1] = s end end
	kept[#kept + 1] = { t = now, gained = pace.gained }
	pace.samples = kept
end

-- "About N min to level, from your last M minutes", or nil without five minutes of
-- readings in the last ten, or no XP gained in them.
function M.PaceLine()
	local s, last, now = pace.samples, pace.last, GetTime()
	local first = s[1]
	if not first or not last or last.max <= last.xp or first.t < now - PACE_WINDOW then return nil end
	local span, gained = now - first.t, s[#s].gained - first.gained
	if span < PACE_MIN or gained <= 0 then return nil end
	local minutes = math.ceil((last.max - last.xp) * span / gained / 60)
	return "About " .. minutes .. " min to level, from your last " .. math.floor(span / 60) .. " minutes"
end

-- For the session recap: "levelMinutes=24:38,25:12", minutes played at each level the
-- addon saw reached (the last is the current level, still counting); "" when none.
function M.LevelMinutes()
	local t, list = LevelTimes(), {}
	for level, r in pairs(t) do
		if type(r) == "table" and r.at and tonumber(level) then list[#list + 1] = tonumber(level) end
	end
	table.sort(list)
	local parts = {}
	for j = math.max(1, #list - 4), #list do
		parts[#parts + 1] = list[j] .. ":" .. math.floor((tonumber(t[list[j]].sec) or 0) / 60)
	end
	return #parts > 0 and ("levelMinutes=" .. table.concat(parts, ",")) or ""
end

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
	if event == "PLAYER_XP_UPDATE" then ReadXP(); M.Refresh(); return end
	if event == "PLAYER_LOGOUT" then CountTime(); return end
	if event == "PLAYER_LEVEL_UP" then CountTime(questId) end
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
	init = function() ReadXP(); M.Evaluate() end,
	events = {
		QUEST_ACCEPTED = true, QUEST_TURNED_IN = true, QUEST_REMOVED = true,
		QUEST_WATCH_UPDATE = true, QUEST_LOG_UPDATE = true, PLAYER_LEVEL_UP = true,
		PLAYER_XP_UPDATE = true, PLAYER_LOGOUT = true,
	},
	onEvent = OnEvent,
	context = function(kind) if kind == "recap" then return M.LevelMinutes() end end,
	commands = { guide = Command },
})
