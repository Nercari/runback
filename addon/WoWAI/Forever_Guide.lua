-- Guide panel (backlog 69): a small window with the current step of a leveling
-- guide and the next two, Previous / Next buttons, a guide picker and a hide
-- button. Read only: it shows text the player follows by hand and changes
-- nothing in the game. The guides come from Guide.lua (WoWAIGuide.List); the text
-- is AI-written, so the panel hides while the lockout is on (combat, encounter,
-- challenge run) and comes back after, like the chat window (Forever_Calm.lua).
-- State lives in WoWAIGuideDB.panel = { shown, guide = id, step = { [id] = n }, pos }.
local M = {}
WoWAIGuidePanel = M
local SHOWN_STEPS = 3
local KIND = { accept = "Accept", ["do"] = "Do", turnin = "Turn in", travel = "Go", train = "Train", buy = "Buy", note = "Note" }

local function Panel()
	WoWAIGuideDB = WoWAIGuideDB or {}
	local p = WoWAIGuideDB.panel
	if type(p) ~= "table" then p = {}; WoWAIGuideDB.panel = p end
	if type(p.step) ~= "table" then p.step = {} end
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

-- "/wow-ai guide <rest>": returns the subcommand and its argument, or nil when the
-- text is a message for the agent ("guide me to Goldshire").
local WORDS = { show = 0, hide = 0, next = 0, prev = 0, list = 0, pick = 1 }
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

local function StepLine(s)
	local line = (KIND[s.kind] or "Step") .. ": " .. Plain(s.text)
	if type(s.quest) == "string" and s.quest ~= "" and not s.text:find(s.quest, 1, true) then line = line .. " (" .. Plain(s.quest) .. ")" end
	if s.optional then line = line .. " (optional)" end
	return line
end

-- What the panel shows: a header and up to three step lines.
function M.Lines()
	local g = Current()
	if not g then return "Guide", { "No guide yet. Ask the mentor: /ai make me a leveling guide" } end
	local order = M.Order(g, Who())
	local list, k, total = M.Window(order, Panel().step[g.id], SHOWN_STEPS)
	local lines = {}
	for _, i in ipairs(list) do lines[#lines + 1] = StepLine(g.steps[i]) end
	if #lines == 0 then lines[1] = "No step in this guide fits your character." end
	return Plain(g.title or g.id) .. "  " .. (total > 0 and (k .. "/" .. total) or ""), lines
end

-- Frame ----------------------------------------------------------------------

local frame, rows, header, picker

local function Build()
	if frame then return frame end
	local f = CreateFrame("Frame", "WoWAIGuideFrame", UIParent, "BackdropTemplate")
	f:SetSize(340, 120)
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
		r:SetPoint("RIGHT", f, "RIGHT", -10, 0)
		r:SetJustifyH("LEFT")
		r:SetWordWrap(false)
		rows[i] = r
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
	f.prev = Btn("Previous", 76, 8, function() M.Step(-1) end)
	f.next = Btn("Next", 76, 86, function() M.Step(1) end)
	picker = Btn("Pick guide", 160, 172, function() M.Cycle() end)
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
	local title, lines = M.Lines()
	header:SetText(title)
	for i, r in ipairs(rows) do r:SetText(lines[i] or "") end
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

WoWAIForever.On("LOCKOUT_CHANGED", function() M.Refresh() end)
if WoWAIGuide then hooksecurefunc(WoWAIGuide, "Sync", function() M.Refresh() end) end

WoWAIForever.Register({
	name = "guide",
	init = function() M.Refresh() end,
	commands = { guide = Command },
})
