local buffer = {}
local lastSendTime = -10
local lastSender = nil
local lastChannel = nil
local translateFrame = nil

local VALID_CHANNELS = {
	whisper = true,
	party = true,
	raid = true,
	guild = true,
	say = true,
	general = true,
	trade = true,
}

local function GetDB()
	RunbackForeverDB = RunbackForeverDB or {}
	RunbackForeverDB.translate = RunbackForeverDB.translate or {}
	local tdb = RunbackForeverDB.translate
	tdb.channels = tdb.channels or {}
	if not tdb.lang or tdb.lang == "" then
		tdb.lang = "pt"
	end
	return tdb
end

local function IsBlocked()
	if RunbackForever and type(RunbackForever.Locked) == "function" and RunbackForever.Locked() then
		return true
	end
	if RunbackForeverDB and RunbackForeverDB.off then
		return true
	end
	return false
end

local function FindTargetChat()
	if RunbackDB and RunbackDB.chats then
		for _, c in ipairs(RunbackDB.chats) do
			if type(c.name) == "string" and c.name:lower() == "translate" then
				return c
			end
		end
		for _, c in ipairs(RunbackDB.chats) do
			if type(c.name) == "string" and c.name:lower() == "mentor" then
				return c
			end
		end
	end
	if Runback and Runback.internal and type(Runback.internal.ActiveChat) == "function" then
		return Runback.internal.ActiveChat()
	end
	return nil
end

-- The pending message id of the last translate request, per chat: the bridge's
-- reply record carries no cmd, so this is how a translation is told from a
-- plain reply in the same chat.
local translateIds = {}

local function SendBuffer()
	if #buffer == 0 then return end
	if IsBlocked() then return end
	local now = GetTime()
	if now - lastSendTime < 10 then return end
	local target = FindTargetChat()
	if not target then return end
	local tdb = GetDB()
	local lines = {}
	for _, item in ipairs(buffer) do
		table.insert(lines, item.line)
	end
	-- A reply goes to one person: only offer it when the whole batch came from one sender.
	lastSender = buffer[1].sender
	lastChannel = buffer[1].chan
	for _, item in ipairs(buffer) do
		if item.sender ~= lastSender or item.chan ~= lastChannel then lastSender = nil end
	end
	buffer = {}
	lastSendTime = now
	local payload = "[translate] to " .. tdb.lang .. ":\n" .. table.concat(lines, "\n")
	local before = target.pendingId
	Runback.Send(payload, nil, { cmd = "translate", chat = target.id })
	if target.pendingId and target.pendingId ~= before then translateIds[target.id] = target.pendingId end
end

local function EnsureFrame()
	if translateFrame then return translateFrame end
	local f = CreateFrame("Frame", "RunbackTranslateFrame", UIParent, "BackdropTemplate")
	f:SetSize(340, 180)
	f:SetPoint("BOTTOMRIGHT", UIParent, "BOTTOMRIGHT", -20, 200)
	f:SetFrameStrata("DIALOG")
	f:SetMovable(true)
	f:EnableMouse(true)
	if type(f.SetBackdrop) == "function" then
		f:SetBackdrop({
			bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 16,
			insets = { left = 4, right = 4, top = 4, bottom = 4 },
		})
		if type(f.SetBackdropColor) == "function" then
			f:SetBackdropColor(0.05, 0.05, 0.08, 0.95)
		end
	end
	local sc = CreateFrame("ScrollFrame", "RunbackTranslateScroll", f, "UIPanelScrollFrameTemplate")
	sc:SetPoint("TOPLEFT", f, "TOPLEFT", 10, -10)
	sc:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -30, 36)
	local content = CreateFrame("Frame", nil, sc)
	content:SetSize(300, 1)
	sc:SetScrollChild(content)
	local text = content:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	text:SetPoint("TOPLEFT", content, "TOPLEFT", 0, 0)
	text:SetWidth(290)
	text:SetJustifyH("LEFT")
	f.content = content
	f.msgText = text

	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -2, -2)
	close:SetScript("OnClick", function() f:Hide() end)

	f:Hide()
	translateFrame = f
	return f
end

local function ShowTranslatedReply(text)
	local f = EnsureFrame()
	if f.msgText then
		f.msgText:SetText(text or "")
		local h = f.msgText:GetStringHeight() or 20
		f.content:SetHeight(math.max(1, h + 10))
	end
	f:Show()
end

local function OnReply(chat, rec)
	if not rec or type(rec.text) ~= "string" then return end
	-- Only translations open the popup. A plain reply in the mentor chat (where
	-- translations are sent when no "translate" chat exists) is not one.
	local isTranslateChat = chat and type(chat.name) == "string" and chat.name:lower() == "translate"
	local isTranslateCmd = (rec.cmd == "translate")
	if chat and rec.id ~= nil and translateIds[chat.id] == rec.id then
		isTranslateCmd = true
		translateIds[chat.id] = nil
	end
	if not isTranslateChat and not isTranslateCmd and not rec.text:find("%[translate%]") then
		return
	end
	ShowTranslatedReply(rec.text)
	local replyText = rec.text:match("```reply%s*\n(.-)\n```") or rec.text:match("```reply%s*(.-)```")
	if replyText and replyText ~= "" then
		if lastChannel == "whisper" and lastSender and type(ChatFrame_SendTell) == "function" then
			ChatFrame_SendTell(lastSender)
			local eb = ChatEdit_GetActiveWindow and ChatEdit_GetActiveWindow() or LAST_ACTIVE_CHAT_EDIT_BOX
			if eb and type(eb.SetText) == "function" then
				eb:SetText(replyText)
			end
		elseif type(ChatFrame_OpenChat) == "function" then
			ChatFrame_OpenChat(replyText)
		end
	end
end

local function ChannelFromEvent(event, ...)
	if event == "CHAT_MSG_WHISPER" then return "whisper" end
	if event == "CHAT_MSG_PARTY" or event == "CHAT_MSG_PARTY_LEADER" then return "party" end
	if event == "CHAT_MSG_RAID" or event == "CHAT_MSG_RAID_LEADER" then return "raid" end
	if event == "CHAT_MSG_GUILD" then return "guild" end
	if event == "CHAT_MSG_SAY" then return "say" end
	if event == "CHAT_MSG_CHANNEL" then
		local _, _, _, _, _, _, _, num = ...
		local n = tonumber(num)
		if n == 1 then return "general" end
		if n == 2 then return "trade" end
	end
	return nil
end

local function OnChatEvent(event, ...)
	local chan = ChannelFromEvent(event, ...)
	if not chan then return end
	local tdb = GetDB()
	if not tdb.channels[chan] then return end
	local text, sender = ...
	text = tostring(text or "")
	sender = tostring(sender or "")
	local me = type(UnitName) == "function" and UnitName("player")
	if me and (sender == me or sender:find("^" .. me .. "%-")) then return end
	table.insert(buffer, { chan = chan, sender = sender, line = sender .. ": " .. text })
	while #buffer > 10 do
		table.remove(buffer, 1)
	end
	SendBuffer()
end

local function HandleCommand(rest)
	local tdb = GetDB()
	local sub, arg = (rest or ""):match("^(%S+)%s*(.-)$")
	sub = sub and sub:lower() or ""
	arg = arg and arg:lower() or ""
	if sub == "on" then
		if VALID_CHANNELS[arg] then
			tdb.channels[arg] = true
			print("Translate enabled for " .. arg)
		else
			print("Unknown channel: " .. arg .. ". Valid: whisper, party, raid, guild, say, general, trade")
		end
	elseif sub == "off" then
		if VALID_CHANNELS[arg] then
			tdb.channels[arg] = false
			print("Translate disabled for " .. arg)
		else
			print("Unknown channel: " .. arg)
		end
	elseif sub == "lang" then
		if arg ~= "" then
			tdb.lang = arg
			print("Translate language set to " .. arg)
		else
			print("Usage: /ai translate lang <lang>")
		end
	elseif sub == "list" then
		print("Translate target language: " .. tdb.lang)
		for ch in pairs(VALID_CHANNELS) do
			print("  " .. ch .. ": " .. (tdb.channels[ch] and "ON" or "off"))
		end
	else
		print("Usage: /ai translate on|off <channel> | /ai translate lang <lang> | /ai translate list")
	end
end

local function Init()
	GetDB()
	if C_Timer and type(C_Timer.NewTicker) == "function" then
		C_Timer.NewTicker(1, SendBuffer)
	end
	RunbackForever.On("LOCKOUT_CHANGED", function(locked)
		if not locked then
			SendBuffer()
		end
	end)
end

RunbackForever.Register({
	name = "translate",
	init = Init,
	onReply = OnReply,
	events = {
		CHAT_MSG_WHISPER = true,
		CHAT_MSG_PARTY = true,
		CHAT_MSG_PARTY_LEADER = true,
		CHAT_MSG_RAID = true,
		CHAT_MSG_RAID_LEADER = true,
		CHAT_MSG_GUILD = true,
		CHAT_MSG_SAY = true,
		CHAT_MSG_CHANNEL = true,
	},
	onEvent = OnChatEvent,
	commands = {
		translate = HandleCommand,
	},
})
