-- The between-pull coach card (#140): after a fight, one short note whose numbers
-- the bridge counted from the game's combat log file. The addon asks for it out of
-- combat, shows it only when the lockout is over and the combat log is on, and
-- counts the three answers for `/ai card`, keeps one row per fight (the last 60) and,
-- with the next note, first asks "Used the last note?". It reads no game state, takes no action
-- and prints nothing in the chat; the card sits clear of the quest tracker and the
-- chat. With no usable log the bridge sends no card and nothing here shows.
local M = {}
RunbackCard = M

local frame, body, whyText, countsText, noteButtons, askButtons
local pending, expanded, lastRequest
local asking -- the log row of the last shown note, while the card asks if it was used
local LOG_MAX = 60

local function DB()
	RunbackForeverDB = RunbackForeverDB or {}
	local c = RunbackForeverDB.card
	if type(c) ~= "table" then c = {}; RunbackForeverDB.card = c end
	if c.enabled == nil then c.enabled = true end
	if type(c.counts) ~= "table" then c.counts = {} end
	for _, k in ipairs({ "got", "why", "no" }) do c.counts[k] = tonumber(c.counts[k]) or 0 end
	if type(c.log) ~= "table" then c.log = {} end
	return c
end

-- The row for the note on screen, so an answer lands on its own fight.
local function RowOf(key)
	local log = DB().log
	for i = #log, 1, -1 do
		if type(log[i]) == "table" and log[i].key == key then return log[i] end
	end
end

-- One row per fight, newest last: { key, shown, answer = got|why|no, why, used }.
-- tools/card-report.js reads it from SavedVariables.
local function AddRow(key)
	local log = DB().log
	local row = { key = key }
	log[#log + 1] = row
	while #log > LOG_MAX do table.remove(log, 1) end
	return row
end

local function LogOn()
	return type(LoggingCombat) == "function" and LoggingCombat() and true or false
end

local function Locked()
	return RunbackForever.Locked and RunbackForever.Locked() and true or false
end

-- Off when the setting is off, when the combat log is off, in a fight, and while
-- the AI is off (the same quiet the other offers keep).
local function CanShow()
	return DB().enabled and LogOn() and not Locked() and not (RunbackForeverDB and RunbackForeverDB.off)
end

local function Hide()
	if frame then frame:Hide() end
end

local function Ensure()
	if frame then return frame end
	frame = CreateFrame("Frame", "RunbackCardFrame", UIParent, "BackdropTemplate")
	frame:SetSize(340, 118)
	-- Top centre: the quest tracker is on the right and the chat is bottom left,
	-- so the card covers neither.
	frame:SetPoint("TOP", UIParent, "TOP", -140, -190)
	frame:SetFrameStrata("DIALOG")
	frame:SetClampedToScreen(true)
	if type(frame.SetBackdrop) == "function" then
		frame:SetBackdrop({
			bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
			edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
			tile = true, tileSize = 32, edgeSize = 32,
			insets = { left = 11, right = 11, top = 11, bottom = 11 },
		})
		frame:SetBackdropColor(0.03, 0.03, 0.05, 0.95)
	end
	local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOPLEFT", frame, "TOPLEFT", 16, -12)
	title:SetText("Next pull")
	body = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	body:SetPoint("TOPLEFT", frame, "TOPLEFT", 16, -34)
	body:SetPoint("RIGHT", frame, "RIGHT", -16, 0)
	body:SetJustifyH("LEFT")
	whyText = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	whyText:SetPoint("TOPLEFT", body, "BOTTOMLEFT", 0, -8)
	whyText:SetPoint("RIGHT", frame, "RIGHT", -16, 0)
	whyText:SetJustifyH("LEFT")
	countsText = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	countsText:SetPoint("TOPLEFT", whyText, "BOTTOMLEFT", 0, -6)
	countsText:SetPoint("RIGHT", frame, "RIGHT", -16, 0)
	countsText:SetJustifyH("LEFT")

	local function Button(label, x, onClick)
		local b = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
		b:SetSize(90, 20)
		b:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", x, 10)
		b:SetText(label)
		b:SetScript("OnClick", onClick)
		return b
	end
	noteButtons = {
		Button("Got it", 16, function() M.Answer("got") end),
		Button("Why?", 116, function() M.Answer("why") end),
		Button("Not useful", 216, function() M.Answer("no") end),
	}
	askButtons = {
		Button("Yes", 16, function() M.Used(true) end),
		Button("No", 116, function() M.Used(false) end),
	}
	frame:Hide()
	return frame
end

local function Show()
	if not (asking or pending) or not CanShow() then return end
	Ensure()
	for _, b in ipairs(noteButtons) do b:SetShown(not asking) end
	for _, b in ipairs(askButtons) do b:SetShown(asking and true or false) end
	if asking then
		body:SetText("Used the last note?")
		whyText:SetText("")
		countsText:SetText("")
		frame:SetHeight(118)
		frame:Show()
		return
	end
	local row = RowOf(pending.key)
	if row then row.shown = true end
	body:SetText(pending.text)
	whyText:SetText(pending.why)
	countsText:SetText(expanded and pending.counts or "")
	frame:SetHeight(expanded and 140 or 118)
	frame:Show()
end

-- The bridge's card for the newest fight, from a slot file. True when it was new.
function M.Sync(card)
	if type(card) ~= "table" or type(card.text) ~= "string" or card.text == "" then return false end
	if type(card.key) ~= "string" or card.key == "" then return false end
	local db = DB()
	if db.seen == card.key then return false end
	db.seen = card.key
	-- A note that was shown and has no answer yet is asked about before this one.
	local last = db.log[#db.log]
	if not asking and type(last) == "table" and last.shown and last.used == nil then asking = last end
	AddRow(card.key:sub(1, 40))
	pending = {
		key = card.key:sub(1, 40),
		text = card.text:sub(1, 200),
		why = type(card.why) == "string" and card.why:sub(1, 200) or "",
		counts = type(card.counts) == "string" and card.counts:sub(1, 200) or "",
	}
	expanded = false
	Show()
	return true
end

-- One answer: it adds to the local count /ai card prints and to the note's row.
-- "Why?" counts once per note and also opens the numbers behind it; the other two
-- close the card.
function M.Answer(kind)
	if not pending then return end
	local c = DB().counts
	if type(c[kind]) ~= "number" then return end
	local row = RowOf(pending.key)
	if kind == "why" then
		expanded = true
		if not pending.whyCounted then
			pending.whyCounted = true
			c.why = c.why + 1
			if row then row.why = true end
		end
		Show()
		return
	end
	c[kind] = c[kind] + 1
	if row then row.answer = kind end
	pending, expanded = nil, false
	Hide()
end

-- "Used the last note?" Yes or No. It marks that note's row, then the new note shows.
function M.Used(yes)
	if not asking then return end
	asking.used = yes and true or false
	asking = nil
	if pending then Show() else Hide() end
end

function M.Show()
	Show()
end

function M.Hide()
	Hide()
end

local function Line()
	local c = DB().counts
	local yes, no = 0, 0
	for _, r in ipairs(DB().log) do
		if type(r) == "table" and r.used == true then yes = yes + 1 elseif type(r) == "table" and r.used == false then no = no + 1 end
	end
	return string.format("Coach card: %s. Got it %d, Why? %d, Not useful %d. Used the last note: yes %d, no %d.",
		DB().enabled and "on" or "off", c.got, c.why, c.no, yes, no)
end

-- /ai card: the counts, or on/off. The card is off whenever the combat log is off.
local function Command(rest)
	local word = tostring(rest or ""):lower():match("^%s*(%a*)")
	if word == "on" or word == "off" then
		DB().enabled = word == "on"
		DB().requested = nil
		if not DB().enabled then Hide() else Show() end
	end
	local line = Line()
	if not LogOn() then line = line .. " It stays off while the combat log is off." end
	print("|cff7ec8ff[Runback]|r " .. line)
end

-- Ask the bridge for a card once per fight, after the fight's lockout ends. The
-- request carries the fight context only; the answer comes back in the slot files.
local function Request()
	if not DB().enabled or not LogOn() or Locked() then return end
	if RunbackForeverDB and RunbackForeverDB.off then return end
	if not (Runback and Runback.RequestCard) then return end
	local ok, ctx = pcall(Runback.GameContext, "review")
	if not ok or type(ctx) ~= "string" then return end
	local s, e = ctx:match("lastFight=start=([^,\n]+),end=([^,\n]+)")
	if not s or not e then return end
	local key = s .. "/" .. e
	if key == lastRequest or DB().requested == key then return end
	if Runback.RequestCard(ctx) then
		lastRequest = key
		DB().requested = key
	end
end

RunbackForever.On("LOCKOUT_CHANGED", function(locked)
	if locked then
		Hide()
		return
	end
	Show()
	-- One frame later: the context module records the fight's end on the same
	-- event, so the request must read the context after it has run.
	if C_Timer and C_Timer.After then C_Timer.After(0, Request) else Request() end
end)

RunbackForever.Register({
	name = "card",
	commands = { card = Command },
})
