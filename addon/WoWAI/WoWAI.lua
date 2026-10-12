-- WoWAI: talk to local coding agents (Claude Code, Codex, Grok) from inside WoW,
-- without reloading.
--
-- The WoW sandbox has no network and no file reads at runtime. Two doors remain open:
--
--   OUT ("pixel" mode): pending messages are drawn as a strip of colored squares in
--        the top-left corner of the screen until the bridge acknowledges them.
--        bridge.js screen-captures that corner and decodes it. Nothing touches the game.
--   IN:  load-on-demand addons read their files from disk at the moment they load.
--        The bridge writes the latest replies for every chat into a pool of pre-made
--        slot addons (WoWAI_S001..S200); we load a fresh slot from a timer.
--        Each slot is single-use per session; a /reload frees them all.
--   Fallback ("reload" mode): SavedVariables + Inbox.lua, a ReloadUI() per step.
--
-- Chats: each chat is its own agent session (like a separate terminal) with its own
-- folder, agent, history and pending message. The bridge runs them in parallel.
-- Everything here is plain addon API. No automation, no memory reading.

local ADDON_NAME = ...
local WoWAI = {}
_G.WoWAI = WoWAI
local function ForeverModules() return WoWAIForever and WoWAIForever.modules or {} end
local function ForeverBlocked()
	for _, mod in ipairs(ForeverModules()) do
		if type(mod.blocked) == "function" then
			local ok, reason = pcall(mod.blocked)
			if ok and reason and tostring(reason) ~= "" then return tostring(reason) end
		end
	end
end
local Codec = WoWAI_Codec

local DEFAULT_CWD = "" -- empty = the bridge's configured defaultCwd
local MAX_HISTORY = 200
local MAX_CHATS = 16

local SLOT_COUNT = 200
local SLOT_PREFIX = "WoWAI_S"
local ACT_MAX = 60 -- heartbeat files per message (act/NNN/01..60.wav)
local PRESENCE_MAX = 2000 -- presence/0001..2000.wav, one flipped by the bridge every 30 s
local STRIP_TRIES = 3 -- re-show an unacknowledged message this many times before falling back
local CELL, CELLS_PER_ROW, MAX_ROWS = 4, 200, 48
local STRIP_SECONDS = 40 -- max per message; it leaves the strip as soon as the bridge acknowledges
-- Seconds after a send at which a slot is read. With the sound channel the
-- readiness signal brings most replies in early, so polls are cheap insurance;
-- without it every check costs one of the SLOT_COUNT slots, so they thin out
-- after the first minute.
local POLL_SCHEDULE = { 5, 10, 16, 24, 34, 46, 60, 80, 100, 130, 160, 200, 240, 300 }
local POLL_TAIL = 60
local SLOT_ONLY_SCHEDULE = { 5, 15, 30, 60, 120, 180, 300 }
local SLOT_ONLY_TAIL = 120
local TICK_SECONDS = 2
local CONNECT_WAIT = 15 -- seconds the Connect button waits for the bridge before giving up
-- Without the sound channel the bridge is heard from only on a slot read, and
-- its clock in the slot is when it last wrote one (a reply, progress, a hello).
local SLOT_ONLY_OK, SLOT_ONLY_STALE = 720, 1320
local RS, US = "\30", "\31" -- record / unit separators in the strip payload

local db
local ui = {}
-- Transport state for this UI session. outbound[id] = { chat, cwd, flags, text, sentAt, acked }
-- slotsUsed counts slot reads by reason; startedAt is when this UI session (and its slot pool) began.
local run = { outbound = {}, slotsUsed = {}, startedAt = 0 }

-- Shared window backdrop. Declared up here because ShowCopy (rendering section)
-- uses it too: a later `local` would be invisible there and resolve to a nil global.
local BACKDROP = {
	bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
	edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
	tile = true, tileSize = 16, edgeSize = 16,
	insets = { left = 4, right = 4, top = 4, bottom = 4 },
}

-- The assistant bubble is labelled with the agent that wrote it (see AgentName).
local ROLE_STYLE = {
	user      = { label = "You",    color = { 0.49, 0.78, 1.00 }, bg = { 0.25, 0.45, 0.75, 0.16 } },
	assistant = { label = "AI",     color = { 1.00, 0.82, 0.25 }, bg = { 0.85, 0.70, 0.30, 0.10 } },
	system    = { label = "System", color = { 0.62, 0.62, 0.62 }, bg = { 0.50, 0.50, 0.50, 0.10 } },
}

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function ToHex(s)
	return (s:gsub(".", function(c)
		return string.format("%02x", c:byte())
	end))
end

-- Record fields use control characters as separators, so keep them out of the wire format.
local function Wire(s)
	local value = tostring(s or "")
	return (value:gsub("[\30\31]", " "))
end

-- EditBoxes do not render UI escape sequences, so just make pipes harmless.
local function Display(s)
	return (tostring(s or ""):gsub("|", "¦"))
end

-- Reply text for the window: the chat has no markdown, so drop the marks the AI
-- wraps around words (`code`, **bold**) and keep the words. The copy box keeps
-- the original text.
local function Plain(s)
	s = tostring(s or ""):gsub("```[%w_]*", ""):gsub("%*%*", ""):gsub("`", "")
	return s
end

local function Trim(s)
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function FmtDur(sec)
	sec = math.floor(sec or 0)
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m" .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h" .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

-- Last path component of a folder, for labels.
local function FolderName(cwd)
	local name = tostring(cwd or ""):gsub("[\\/]+$", ""):match("([^\\/]+)$")
	return name or ""
end

-- The folder a chat works in: its own, or the bridge's default (the folder the
-- bridge was started from), which the bridge reports in every slot file.
local function ChatFolder(c)
	if c and c.cwd ~= "" then return c.cwd end
	return run.bridgeCwd or ""
end

-- Agents are named by id as the bridge knows them ("claude", "codex", "grok");
-- the bridge lists the ones it has, and its default, in every slot file. A chat
-- with no agent of its own runs on the bridge's default.
local AGENT_NAMES = { claude = "Claude", codex = "Codex", grok = "Grok", agy = "Antigravity", hermes = "Hermes" }

local function AgentName(id)
	id = tostring(id or "")
	if id == "" then return "AI" end
	return AGENT_NAMES[id] or (id:sub(1, 1):upper() .. id:sub(2))
end

local function ChatAgent(c)
	if c and c.agent and c.agent ~= "" then return c.agent end
	return run.bridgeAgent or ""
end

local function ChatAgentName(c)
	return AgentName(ChatAgent(c))
end

-- A chat can also pick one of the models the bridge offers for its agent
-- ("Claude · sonnet"); empty = the agent's own default model.
local function ChatModel(c)
	return (c and c.model and c.model ~= "") and c.model or ""
end

local function PoolName(agent, model)
	return AgentName(agent) .. ((model and model ~= "") and (" · " .. model) or "")
end

-- The flags that pick a chat's agent and model ("agent=claude;model=sonnet").
local function PoolFlags(c)
	local t = {}
	if c.agent and c.agent ~= "" then table.insert(t, "agent=" .. c.agent) end
	if ChatModel(c) ~= "" then table.insert(t, "model=" .. c.model) end
	return table.concat(t, ";")
end

-- The name to show on a reply: the agent the bridge says wrote it, else the chat's.
local function ReplyAgentName(c, agent)
	if agent and agent ~= "" then return AgentName(agent) end
	return ChatAgentName(c)
end

local function Contains(list, v)
	for _, x in ipairs(list or {}) do
		if x == v then return true end
	end
	return false
end

-- First few words of a message, as a chat title.
local function AutoTitle(text)
	local words = {}
	for w in tostring(text or ""):gmatch("%S+") do
		w = w:gsub("^[%p]+", ""):gsub("[%p]+$", "")
		if w ~= "" then
			table.insert(words, w)
			if #words >= 5 then break end
		end
	end
	local title = table.concat(words, " ")
	if #title > 24 then title = title:sub(1, 24):gsub("%s+%S*$", "") end
	if title == "" then return nil end
	return title:sub(1, 1):upper() .. title:sub(2)
end

local function NewId()
	return string.format("%x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF))
end

local function FindChat(id)
	for i, c in ipairs(db.chats) do
		if c.id == id then return c, i end
	end
end

local function ActiveChat()
	return FindChat(db.activeChat)
end

local function AddChat(name, cwd)
	if #db.chats >= MAX_CHATS then return nil end
	local current = ActiveChat()
	local c = {
		id = NewId(),
		name = name or ("Chat " .. (#db.chats + 1)),
		cwd = cwd or (current and current.cwd) or DEFAULT_CWD,
		agent = (current and current.agent) or "",
		model = (current and current.model) or "",
		history = {},
		unread = 0,
		created = time(),
	}
	table.insert(db.chats, c)
	return c
end

local function AnyPending()
	for _, c in ipairs(db.chats) do
		if c.pendingId then return true end
	end
	return false
end

local function InitDB()
	WoWAIDB = WoWAIDB or {}
	db = WoWAIDB
	db.settings = db.settings or {}
	local s = db.settings
	if s.autoRefresh == nil then s.autoRefresh = true end
	if s.signal == nil then s.signal = true end
	if s.context == nil then s.context = true end -- tell the agent about the character, zone, etc.
	-- How much of each reply to print in the game chat. "summary" (the agent's
	-- closing TL;DR lines) replaced "full" as the default; an install that still
	-- has the old default saved moves over once, any other choice is kept.
	if not s.echoV2 then
		s.echoV2 = true
		if s.echo == "full" then s.echo = "summary" end
	end
	s.echo = s.echo or "summary"
	s.mode = s.mode or "pixel"
	s.interval = s.interval or 20
	s.cwd = s.cwd or DEFAULT_CWD
	s.width = s.width or 780
	s.height = s.height or 500
	db.lastSeq = db.lastSeq or 0
	-- Chats deleted in game that the bridge hasn't confirmed forgetting yet.
	db.forget = db.forget or {}
	-- Identifies this counter's lifetime. If the saved data is ever reset, a new
	-- session lets the bridge tell "message #1 again" from "message #1, already done".
	if not db.session then
		db.session = string.format("%x%04x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF), math.random(0, 0xFFFF))
	end
	if not db.chats then
		-- Migrate the single-chat layout into the first chat.
		db.chats = {}
		local c = {
			id = NewId(),
			name = "Chat 1",
			cwd = s.cwd,
			history = db.history or {},
			pendingId = db.pendingId,
			unread = db.unread or 0,
			draft = db.draft,
			created = time(),
		}
		table.insert(db.chats, c)
		db.activeChat = c.id
		db.history, db.pendingId, db.unread, db.draft = nil, nil, nil, nil
	end
	if #db.chats == 0 then AddChat() end
	if not FindChat(db.activeChat) then db.activeChat = db.chats[1].id end
	-- Chats from before agents had names: replies were stored with role "claude".
	for _, c in ipairs(db.chats) do
		c.agent = c.agent or ""
		c.model = c.model or ""
		for _, m in ipairs(c.history or {}) do
			if m.role == "claude" then m.role, m.agent = "assistant", m.agent or "claude" end
		end
	end
end

local function AddHistory(chat, role, text, id, denied, agent)
	table.insert(chat.history, { role = role, text = text, id = id, t = time(), denied = denied, agent = agent })
	while #chat.history > MAX_HISTORY do
		table.remove(chat.history, 1)
	end
end

local function SlotName(i)
	return string.format("%s%03d", SLOT_PREFIX, i)
end

local function SlotNumber(id)
	return ((id - 1) % SLOT_COUNT) + 1
end

---------------------------------------------------------------------------
-- Reload plumbing (fallback path)
---------------------------------------------------------------------------

local function SafeReload()
	if InCombatLockdown() then
		WoWAI.reloadAfterCombat = true
		if ui.status then
			ui.status:SetText("In combat - will reload on your first keypress after it ends")
		end
		return
	end
	ReloadUI()
end

-- ReloadUI() only works from a hardware event (a keypress or click), never from
-- a timer. So the automatic reload piggybacks on the player's own next keypress
-- once the interval has elapsed. The key still reaches the game normally.
local keyCatcher = CreateFrame("Frame", "WoWAIKeyCatcher", UIParent)
keyCatcher:Hide()
keyCatcher:EnableKeyboard(true)
keyCatcher:SetScript("OnKeyDown", function(self, key)
	if InCombatLockdown() then return end
	if WoWAI.reloadAfterCombat or (db and AnyPending() and db.settings.autoRefresh
		and GetTime() >= (WoWAI.nextAutoRefresh or 0)) then
		WoWAI.reloadAfterCombat = nil
		self:Hide()
		ReloadUI()
	end
end)

-- Propagation can't be changed in combat. Never show the catcher without it,
-- or it would eat every keypress. Returns whether the catcher is now listening.
local function ShowKeyCatcher()
	if not keyCatcher.propagates then
		if InCombatLockdown() or not keyCatcher.SetPropagateKeyboardInput then return false end
		keyCatcher:SetPropagateKeyboardInput(true)
		keyCatcher.propagates = true
	end
	keyCatcher:Show()
	return true
end

-- Arm the keypress reload. In pixel mode this is only used once the slot pool
-- is exhausted (a reload frees every slot) or the slots are not installed.
function WoWAI.ArmAutoRefresh()
	keyCatcher:Hide()
	-- A reload the player asked for during combat waits for their next keypress.
	if WoWAI.reloadAfterCombat then
		if not InCombatLockdown() then ShowKeyCatcher() end
		return
	end
	if not AnyPending() or not db.settings.autoRefresh then return end
	if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing or run.pixelFailed) then return end
	-- PLAYER_REGEN_ENABLED re-arms after combat.
	WoWAI.nextAutoRefresh = GetTime() + db.settings.interval
	ShowKeyCatcher()
end

---------------------------------------------------------------------------
-- Pixel strip (out)
---------------------------------------------------------------------------

local strip
local cellPool = {}

local function EnsureStrip()
	if strip then return strip end
	strip = CreateFrame("Frame", "WoWAIStrip", UIParent)
	strip:SetFrameStrata("TOOLTIP")
	strip:SetFrameLevel(10000)
	-- Scale so that one UI unit is exactly one physical pixel (see Blizzard's PixelUtil).
	local physH = 1080
	if GetPhysicalScreenSize then
		local _, h = GetPhysicalScreenSize()
		physH = h or physH
	end
	if strip.SetIgnoreParentScale then strip:SetIgnoreParentScale(true) end
	strip:SetScale(768 / physH)
	strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
	strip:SetSize(CELLS_PER_ROW * CELL, MAX_ROWS * CELL)
	strip:Hide()
	return strip
end

local function HideStrip()
	if strip then strip:Hide() end
	run.stripShown = nil
end

local function ShowStrip(id, payload)
	local cells = Codec.Encode(id % 65536, payload)
	local s = EnsureStrip()
	local rows = math.ceil(#cells / CELLS_PER_ROW)
	local total = rows * CELLS_PER_ROW
	for i = 1, total do
		local t = cellPool[i]
		if not t then
			t = s:CreateTexture(nil, "OVERLAY")
			t:SetSize(CELL, CELL)
			local c = (i - 1) % CELLS_PER_ROW
			local r = math.floor((i - 1) / CELLS_PER_ROW)
			t:SetPoint("TOPLEFT", s, "TOPLEFT", c * CELL, -r * CELL)
			cellPool[i] = t
		end
		local cr, cg, cb = Codec.CellColor(cells[i] or 0)
		t:SetColorTexture(cr, cg, cb, 1)
		t:Show()
	end
	for i = total + 1, #cellPool do
		cellPool[i]:Hide()
	end
	s:Show()
	run.stripShown = true
end

-- Record: session, chat, id, cwd, flags, name, [context,] text. Several records
-- per frame. The context field is only present when the flags carry "c", so the
-- bridge can tell it from a separator inside the text.
local function RecordFor(id, rec)
	local flags = Wire(rec.flags)
	local fields = { Wire(db.session), Wire(rec.chat), tostring(id), Wire(rec.cwd), flags, Wire(rec.name) }
	if rec.ctx ~= nil then
		fields[5] = flags == "" and "c" or (flags .. ";c")
		table.insert(fields, Wire(rec.ctx))
	end
	table.insert(fields, Wire(rec.text))
	return table.concat(fields, US)
end

-- Redraw the strip from every outbound message the bridge hasn't acknowledged.
local function RefreshStrip()
	-- While blocked (combat, AI off) only the off/on switch records are drawn.
	local blocked = ForeverBlocked()
	local ids = {}
	for id, rec in pairs(run.outbound) do
		if not rec.acked and (rec.force or not blocked) then table.insert(ids, id) end
	end
	if #ids == 0 then
		HideStrip()
		return
	end
	table.sort(ids)
	-- Newest first; drop the oldest if the frame would overflow.
	local parts, size, latest = {}, 0, ids[#ids]
	for i = #ids, 1, -1 do
		local r = RecordFor(ids[i], run.outbound[ids[i]])
		if size + #r + 1 > Codec.MAX_PAYLOAD then break end
		table.insert(parts, 1, r)
		size = size + #r + 1
	end
	ShowStrip(latest, table.concat(parts, RS))
end

---------------------------------------------------------------------------
-- Signals and slots (in)
---------------------------------------------------------------------------

-- Optional cheap poll: an empty .wav won't play, a valid one will. The bridge
-- fills sig/NNN.wav when reply NNN is ready. Self-disables if it misbehaves.
local signalAvailable = type(PlaySoundFile) == "function"
local signalStats = { checks = 0, hits = 0, lastHit = nil }

local function SoundValid(path)
	if not signalAvailable or not db.settings.signal then return false end
	signalStats.checks = signalStats.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		signalAvailable = false
		signalStats.error = tostring(willPlay)
		return false
	end
	if willPlay and handle then pcall(StopSound, handle) end
	if willPlay then
		signalStats.hits = signalStats.hits + 1
		signalStats.lastHit = GetTime()
	end
	return willPlay and true or false
end

local function CheckSignal(kind, id)
	if run.signalUnreliable then return false end
	return SoundValid(string.format("Interface\\AddOns\\WoWAI\\%s\\%03d.wav", kind, SlotNumber(id)))
end

-- Heartbeat: the bridge flips act/NNN/kk.wav for the k-th action of message NNN.
local function ActPath(id, k)
	return string.format("Interface\\AddOns\\WoWAI\\act\\%03d\\%02d.wav", SlotNumber(id), k)
end

local function StartActivity(chat, id)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	-- The bridge can't have written anything yet, so a valid first file means the
	-- client cached this slot number's files from an earlier use: don't trust them.
	if SoundValid(ActPath(id, 1)) then a.unreliable = true end
	run.act = run.act or {}
	run.act[chat.id] = a
end

-- Returns true if the counter moved.
local function PollActivity(chat)
	local a = run.act and run.act[chat.id]
	if not a or a.unreliable or not chat.pendingId then return false end
	local moved = false
	for _ = 1, 3 do
		if a.next > ACT_MAX then break end
		if not SoundValid(ActPath(chat.pendingId, a.next)) then break end
		a.count = a.count + 1
		a.next = a.next + 1
		a.last = GetTime()
		moved = true
	end
	return moved
end

-- Bridge presence. Evidence the bridge is alive comes from several places:
-- presence beats, acks, slot data (which carries the bridge's clock), replies.
local function NotedBridge(at)
	at = at or GetTime()
	if not run.bridgeSeen or at > run.bridgeSeen then run.bridgeSeen = at end
	run.pixelFailed = nil
end

local function PresencePath(k)
	return string.format("Interface\\AddOns\\WoWAI\\presence\\%04d.wav", k)
end

-- Valid presence files form a prefix 1..k, so a binary search finds the head.
local function FindPresenceHead()
	local lo, hi = 0, PRESENCE_MAX
	while lo < hi do
		local mid = math.ceil((lo + hi) / 2)
		if SoundValid(PresencePath(mid)) then lo = mid else hi = mid - 1 end
	end
	return lo
end

local function PollPresence()
	if not signalAvailable or not db.settings.signal then return end
	run.presence = run.presence or { last = FindPresenceHead() }
	local p = run.presence
	for _ = 1, 3 do
		local k = (p.last % PRESENCE_MAX) + 1
		if not SoundValid(PresencePath(k)) then break end
		p.last = k
		p.beats = (p.beats or 0) + 1
		NotedBridge()
	end
end

-- Whether the 30-second presence beats can reach us at all. When they can't
-- (self-test failed, or signal checks turned off), the only evidence of the
-- bridge is a slot read, and slots are read only while a reply is pending.
local function PresenceWorks()
	return signalAvailable and db ~= nil and db.settings.signal
end

-- Returns state ("ok" | "idle" | "stale" | "down" | "unknown"), a color and a description.
-- With presence beats the bridge is heard from every 30 s, so 90 s of silence is
-- suspicious. Without them it is heard from only on a slot read: while a reply
-- is pending the wider SLOT_ONLY windows apply; while idle nothing is read (it
-- would cost a slot and only repeat the bridge's last write), so past the ok
-- window the light says "idle" (not checked) instead of stale or down.
function WoWAI.BridgeState()
	local seen = run.bridgeSeen
	if not seen then
		return "unknown", 0.6, 0.6, 0.6, "Bridge: not seen yet this session"
	end
	local age = GetTime() - seen
	local okFor, staleFor = 90, 300
	if not PresenceWorks() then
		okFor, staleFor = SLOT_ONLY_OK, SLOT_ONLY_STALE
		if age >= okFor and not AnyPending() then
			return "idle", 0.6, 0.6, 0.6, "Bridge: last heard from " .. FmtDur(age) .. " ago; not checked while idle, to save reply slots (sending checks it)"
		end
	end
	if age < okFor then
		return "ok", 0.2, 0.9, 0.3, "Bridge: connected (seen " .. FmtDur(age) .. " ago)"
	elseif age < staleFor then
		return "stale", 0.95, 0.8, 0.2, "Bridge: last seen " .. FmtDur(age) .. " ago"
	end
	return "down", 0.9, 0.25, 0.25, "Bridge: not seen for " .. FmtDur(age) .. " - is the bridge running?"
end

-- Same icons the friends list uses for online / away / busy / offline.
local STATE_ICON = {
	ok = "Interface\\FriendsFrame\\StatusIcon-Online",
	stale = "Interface\\FriendsFrame\\StatusIcon-Away",
	down = "Interface\\FriendsFrame\\StatusIcon-DnD",
	unknown = "Interface\\FriendsFrame\\StatusIcon-Offline",
	idle = "Interface\\FriendsFrame\\StatusIcon-Offline",
}

function WoWAI.UpdateDot()
	local state, _, _, _, tip = WoWAI.BridgeState()
	if run.pixelFailed then state = "down" end
	if not signalAvailable and signalStats.selftest then
		tip = tip .. "\n(sound-file channel unavailable: " .. signalStats.selftest .. "; using slot checks only)"
	end
	-- The chat's folder and the transport (backlog 82): details for the curious,
	-- kept off the window's footer.
	if run.detailTip then tip = tip .. "\n" .. run.detailTip end
	for _, dot in ipairs({ ui.dot, ui.miniDot }) do
		if dot then
			dot:SetTexture(STATE_ICON[state] or STATE_ICON.unknown)
			dot.tip = tip
		end
	end
end

-- Connected = the bridge has been seen recently, or the light is "idle" (the
-- first poll after sending checks it). In pixel mode, sending needs this;
-- until then the Connect button takes the Send button's place. The reload
-- transport has no idea whether the bridge is there, so it never gates.
function WoWAI.IsConnected()
	if not db or db.settings.mode ~= "pixel" then return true end
	local state = WoWAI.BridgeState()
	return (state == "ok" or state == "idle") and not run.pixelFailed
end

-- Connect button: say hello to the bridge (it acks, refreshes the slots and
-- offers a restore), ignoring SayHello's throttle so a click always does something.
function WoWAI.Connect()
	if db.settings.mode ~= "pixel" then
		SafeReload()
		return
	end
	run.lastHelloAt = nil
	run.pixelFailed = nil
	run.connectFailed = nil
	run.connectingAt = GetTime()
	WoWAI.SayHello()
end

-- One word for the connection state, so Tick can tell when it changed.
local function ConnectionKey()
	if WoWAI.IsConnected() then return "ok" end
	if run.connectingAt then return "connecting" end
	if run.connectFailed then return "failed" end
	return WoWAI.BridgeState()
end

-- Called every tick: time out a Connect attempt, and redraw when the state flips
-- (light, button, status line, placeholder) without redrawing every tick.
function WoWAI.CheckConnection()
	if run.connectingAt then
		if WoWAI.IsConnected() then
			run.connectingAt, run.connectFailed = nil, nil
			-- A message typed while disconnected goes out now, without a second click,
			-- as long as the same chat is still in front and free.
			local queued = run.sendOnConnect
			run.sendOnConnect = nil
			local c = queued and ActiveChat()
			if c and c.id == queued.chat and not c.pendingId then
				if ui.input and Trim(ui.input:GetText() or "") == queued.text then ui.input:SetText("") end
				WoWAI.Send(queued.text, queued.allow)
			end
		elseif GetTime() - run.connectingAt > CONNECT_WAIT then
			run.connectingAt, run.connectFailed = nil, true
			run.sendOnConnect = nil -- the text is still in the box
		end
	elseif run.connectFailed and WoWAI.IsConnected() then
		run.connectFailed = nil
	end
	local key = ConnectionKey()
	if key ~= run.connKey then
		run.connKey = key
		WoWAI.Render()
	end
end

-- Swap Send and Connect depending on the state; part of UpdateStatus.
function WoWAI.UpdateConnect()
	if not ui.connect or not ui.send then return end
	local connected = WoWAI.IsConnected()
	ui.send:SetShown(connected)
	ui.connect:SetShown(not connected)
	if connected then return end
	if run.connectingAt then
		ui.connect:SetText("Connecting...")
		ui.connect:Disable()
	else
		ui.connect:SetText(WoWAI.BridgeState() == "stale" and "Reconnect" or "Connect")
		ui.connect:Enable()
	end
end

-- Prove the sound-file trick actually distinguishes empty from valid files on this
-- client before trusting it for presence, heartbeats and readiness signals.
local function SelfTestSignals()
	if not signalAvailable then
		signalStats.selftest = "PlaySoundFile missing"
		return
	end
	local emptyLooksValid = SoundValid("Interface\\AddOns\\WoWAI\\ctl\\empty.wav")
	local validLooksValid = SoundValid("Interface\\AddOns\\WoWAI\\ctl\\valid.wav")
	if emptyLooksValid then
		signalAvailable = false
		signalStats.selftest = "an empty file reports as playable"
	elseif not validLooksValid then
		signalAvailable = false
		signalStats.selftest = "a valid file reports as unplayable (files not indexed? restart WoW)"
	else
		signalStats.selftest = "passed"
	end
end

local function ActivityLine(chat)
	local a = run.act and run.act[chat.id]
	local now = GetTime()
	local started = (a and a.startedAt) or run.sentAt or now
	local s = "running " .. FmtDur(now - started)
	-- Never show fewer actions than the progress text lists: the heartbeat count
	-- stays at 0 when the sound channel is off.
	local listed = 0
	for _ in (chat.progress or ""):gmatch("[^\n]+") do listed = listed + 1 end
	local reliable = a and not a.unreliable
	local count = math.max(reliable and a.count or 0, listed)
	if reliable or listed > 0 then
		s = s .. " - " .. count .. (count == 1 and " action" or " actions")
	end
	if reliable then
		if a.last then
			local quiet = now - a.last
			s = s .. ", last " .. FmtDur(quiet) .. " ago"
			if quiet > 120 then s = s .. " (quiet for a while - stuck? /wow-ai cancel)" end
		elseif count == 0 and now - started > 60 then
			s = s .. ", no activity seen yet"
		end
	end
	return s
end

local function FreeSlot()
	for i = 1, SLOT_COUNT do
		local name = SlotName(i)
		if not C_AddOns.IsAddOnLoaded(name) then
			return name
		end
	end
end

local function ScheduleNextPoll()
	local schedule, tail = POLL_SCHEDULE, POLL_TAIL
	if not PresenceWorks() or run.signalUnreliable then schedule, tail = SLOT_ONLY_SCHEDULE, SLOT_ONLY_TAIL end
	local idx = (run.polls or 0) + 1
	local t = schedule[idx]
	if not t then
		t = schedule[#schedule] + tail * (idx - #schedule)
	end
	run.nextPollAt = (run.sentAt or GetTime()) + t
end

local MAX_FOLLOW_UPS = 2 -- suggested follow-up buttons under a reply
-- The player is using the window (open, type, send, click, or a reply lands in
-- it): tell the extension modules so the recap offer waits (Forever_Recap.lua).
local function WindowUsed()
	if WoWAIForever and WoWAIForever.Fire then WoWAIForever.Fire("WINDOW_USED") end
end
local Finish -- defined below

-- The bridge has read this record: whatever game context rode on it is now
-- what the bridge knows, so later messages only carry it again if it changes.
local function NoteAcked(rec)
	rec.acked = true
	if rec.temporaryContext then run.contextSent = nil elseif rec.ctx ~= nil then run.contextSent = rec.ctx end
end

local function MarkAcked(id)
	local rec = run.outbound[id]
	if rec and not rec.acked then
		NoteAcked(rec)
		RefreshStrip()
	end
	NotedBridge()
end

local ApplyReplies -- defined below

-- No AI output mid-fight: a reply that lands during a lockout (combat, encounter,
-- challenge run) waits here and is shown once when the lockout lifts.
local held, heldHooked = {}, false
local function HoldReply(c, r)
	c.progress = "Reply ready. It shows when the fight ends."
	for _, h in ipairs(held) do if h.id == r.id then return end end
	table.insert(held, r)
	if heldHooked then return end
	heldHooked = true
	WoWAIForever.On("LOCKOUT_CHANGED", function(locked)
		if locked or #held == 0 then return end
		local list = held
		held = {}
		ApplyReplies(list)
	end)
end

-- Dispatch a list of reply records to the chats waiting for them.
ApplyReplies = function(replies)
	local matched = false
	for _, r in ipairs(replies or {}) do
		local c = FindChat(r.chat)
		if c and c.pendingId and r.id == c.pendingId then
			matched = true
			MarkAcked(r.id)
			if r.status == "done" or r.status == "error" then run.repliesIn = (run.repliesIn or 0) + 1 end
			local denied = type(r.denied) == "table" and #r.denied > 0 and r.denied or nil
			if (r.status == "done" or r.status == "error") and ForeverBlocked() then
				HoldReply(c, r)
			elseif r.status == "done" then
				Finish(c, "assistant", r.text or "", denied, r.agent, r.summary, r.followUps, r.stall)
			elseif r.status == "error" then
				Finish(c, "system", "Bridge error: " .. tostring(r.text), denied)
			elseif r.status == "working" then
				c.progress = r.text
				-- The bridge marks a run quiet or long; the window then offers Stop and Ask Claude instead.
				c.stall = (r.stall == "quiet" or r.stall == "long") and r.stall or nil
				WoWAI.UpdateStatus()
			end
			if c.pendingId == nil then
				for _, mod in ipairs(ForeverModules()) do if type(mod.onReply) == "function" then pcall(mod.onReply, c, r) end end
			end
		end
	end
	return matched
end

-- The bridge keeps every chat's transcript. After the client wipes our saved data,
-- it sends them back once, addressed to our new session token.
local function ImportRestore(r)
	if type(r) ~= "table" or r.token ~= db.session or db.restored then return end
	db.restored = true
	local added = 0
	local current = ActiveChat()
	for _, rc in ipairs(r.chats or {}) do
		-- Skip chats deleted here that the bridge hasn't been told about yet.
		if type(rc) == "table" and rc.id and not FindChat(rc.id) and not db.forget[rc.id] and #db.chats < MAX_CHATS then
			local chat = {
				id = rc.id,
				name = (rc.name and rc.name ~= "") and rc.name or ("Chat " .. (#db.chats + 1)),
				cwd = rc.cwd or DEFAULT_CWD,
				agent = "",
				history = {},
				unread = 0,
				created = time(),
			}
			for _, m in ipairs(rc.messages or {}) do
				local role, agent = m.role, m.agent
				if role == "claude" then role, agent = "assistant", agent or "claude" end -- an older bridge's transcript
				if agent == "" then agent = nil end
				table.insert(chat.history, { role = role, text = m.text, id = m.id, t = m.t, agent = agent })
			end
			-- Keep the chat we're currently using last so it stays where it was.
			table.insert(db.chats, math.max(1, #db.chats), chat)
			added = added + 1
		end
	end
	run.restoring = nil
	if added > 0 then
		if current and #current.history <= 2 then
			for _, ch in ipairs(db.chats) do
				if ch ~= current and ch.name == current.name then current.name = "New chat" end
			end
		end
		AddHistory(current, "system", "Restored " .. added .. " chat(s) from the bridge after the game reset the saved data.")
		WoWAI.RenderChatList()
	end
end

local function TryLoadSlot(why)
	local name = FreeSlot()
	if not name then
		run.slotsExhausted = true
		WoWAI.ArmAutoRefresh()
		WoWAI.UpdateStatus()
		return
	end
	WoWAI_SlotData = nil
	local loaded, reason = C_AddOns.LoadAddOn(name)
	if not loaded then
		run.slotError = reason
		if reason == "MISSING" or reason == "DISABLED" then
			run.slotsMissing = true
			WoWAI.ArmAutoRefresh()
		end
		WoWAI.UpdateStatus()
		return
	end
	run.polls = (run.polls or 0) + 1
	run.slotsUsed[why] = (run.slotsUsed[why] or 0) + 1
	ScheduleNextPoll()
	local data = WoWAI_SlotData
	if type(data) == "table" and type(data.now) == "number" then
		-- The bridge's clock and ours are the same machine; translate to GetTime().
		NotedBridge(GetTime() - (time() - data.now))
	end
	if type(data) == "table" and type(data.cwd) == "string" and data.cwd ~= "" then run.bridgeCwd = data.cwd end
	if type(data) == "table" then
		if type(data.agent) == "string" and data.agent ~= "" then run.bridgeAgent = data.agent end
		if type(data.agents) == "table" and #data.agents > 0 then run.bridgeAgents = data.agents end
		if type(data.models) == "table" then run.bridgeModels = data.models end
	end
	local matched = ApplyReplies(type(data) == "table" and data.replies or nil)
	if type(data) == "table" and data.restore then ImportRestore(data.restore) end
	if type(data) == "table" and data.map and WoWAIMap then WoWAIMap.Sync(data.map) end
	if type(data) == "table" and data.guides and WoWAIGuide then WoWAIGuide.Sync(data.guides) end
	if why == "signal" and not matched then
		run.signalUnreliable = true
	end
	WoWAI.Render()
end

-- "slots used this session: 17 (hello 1, schedule 16), replies 2, 8.5 per reply, 6.2 per hour"
local function SlotUsageLine()
	local total, parts = 0, {}
	for _, why in ipairs({ "hello", "schedule", "signal", "manual" }) do
		local n = run.slotsUsed[why]
		if n then total = total + n; table.insert(parts, why .. " " .. n) end
	end
	local replies = run.repliesIn or 0
	local hours = math.max(GetTime() - run.startedAt, 60) / 3600
	local function one(x) return (string.format("%.1f", x):gsub("%.0$", "")) end
	return "slots used this session: " .. total .. (#parts > 0 and (" (" .. table.concat(parts, ", ") .. ")") or "")
		.. ", replies " .. replies .. (replies > 0 and (", " .. one(total / replies) .. " per reply") or "")
		.. ", " .. one(total / hours) .. " per hour"
end

local function Tick()
	if not db then return end
	local now = GetTime()
	PollPresence()
	RefreshStrip()
	WoWAI.UpdateDot()
	WoWAI.CheckConnection()
	WoWAI.WatchCombatLog()
	if db.settings.mode ~= "pixel" then return end
	local changed = false
	if run.helloPollAt and now >= run.helloPollAt then
		run.helloPollAt = nil
		TryLoadSlot("hello")
		-- A message queued behind Connect goes out now, not a tick later.
		WoWAI.CheckConnection()
		-- Whatever that slot held, the wait is over.
		if run.restoring then
			run.restoring = nil
			WoWAI.Render()
		end
	end
	if run.restoring and now - run.restoring > 25 then
		run.restoring = nil
		WoWAI.Render()
	end
	for id, rec in pairs(run.outbound) do
		if not rec.acked and CheckSignal("ack", id) then
			NoteAcked(rec)
			changed = true
			NotedBridge()
		end
		-- A hello only needs the bridge to have been seen; it never escalates.
		-- A forget is the same, but the bridge must have been seen a moment after
		-- the record went up, so it had a chance to read it.
		if (rec.hello or rec.forget) and not rec.acked and run.bridgeSeen and run.bridgeSeen >= rec.sentAt + (rec.forget and 2 or 0) then
			NoteAcked(rec)
			changed = true
		end
		if rec.acked then
			if rec.forget then db.forget[rec.forget] = nil end
			run.outbound[id] = nil
			changed = true
		elseif (rec.hello or rec.stop) and now - rec.sentAt >= 20 then
			run.outbound[id] = nil
			changed = true
		elseif now - rec.sentAt >= STRIP_SECONDS then
			rec.tries = (rec.tries or 1) + 1
			if rec.tries <= STRIP_TRIES then
				-- Nobody picked it up: show it again.
				rec.sentAt = now
				changed = true
			elseif rec.forget or rec.stop then
				-- The bridge is away; db.forget keeps a delete for the next hello, and a
				-- stop has nothing left to stop by then.
				run.outbound[id] = nil
				changed = true
			else
				-- Give up on pixels for this message; the reload path still has it.
				run.outbound[id] = nil
				run.pixelFailed = true
				changed = true
				WoWAI.ArmAutoRefresh()
			end
		end
	end
	if changed then
		RefreshStrip()
		WoWAI.UpdateStatus()
	end
	if not AnyPending() then return end
	local moved = false
	for _, c in ipairs(db.chats) do
		if c.pendingId and PollActivity(c) then moved = true end
	end
	if moved then WoWAI.Render() end
	for _, c in ipairs(db.chats) do
		if c.pendingId and CheckSignal("sig", c.pendingId) then
			TryLoadSlot("signal")
			return
		end
	end
	if run.nextPollAt and now >= run.nextPollAt then
		TryLoadSlot("schedule")
	end
end

-- Pull whatever bridge.js last wrote into Inbox.lua (the reload path).
local function ProcessInbox()
	local inbox = WoWAI_Inbox
	if type(inbox) ~= "table" then return end
	if type(inbox.cwd) == "string" and inbox.cwd ~= "" then run.bridgeCwd = inbox.cwd end
	if type(inbox.agent) == "string" and inbox.agent ~= "" then run.bridgeAgent = inbox.agent end
	if type(inbox.agents) == "table" and #inbox.agents > 0 then run.bridgeAgents = inbox.agents end
	if type(inbox.models) == "table" then run.bridgeModels = inbox.models end
	ApplyReplies(inbox.replies)
	if inbox.restore then ImportRestore(inbox.restore) end
	if inbox.map and WoWAIMap then WoWAIMap.Sync(inbox.map) end
	if inbox.guides and WoWAIGuide then WoWAIGuide.Sync(inbox.guides) end
end

Finish = function(chat, role, text, denied, agent, summary, followUps, stall)
	AddHistory(chat, role, text, chat.pendingId, denied, agent)
	if type(followUps) == "table" and #followUps > 0 then
		local keep = {}
		for _, q in ipairs(followUps) do
			if type(q) == "string" and q ~= "" and #keep < MAX_FOLLOW_UPS then keep[#keep + 1] = q end
		end
		chat.history[#chat.history].followUps = keep
	end
	chat.pendingId = nil
	chat.progress = nil
	-- A run that ended with no reply keeps the Ask Claude instead offer.
	chat.stall = (role == "assistant" and stall == "noreply") and "noreply" or nil
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	if visible then WindowUsed() end
	if not visible then
		chat.unread = (chat.unread or 0) + 1
	end
	if not AnyPending() and not WoWAI.reloadAfterCombat then
		keyCatcher:Hide()
	end
	if visible and ui.input and chat.draft and chat.draft ~= "" then
		ui.input:SetText(chat.draft)
		chat.draft = nil
	end
	WoWAI.Render()
	WoWAI.Notify(chat, text, agent, summary)
end

---------------------------------------------------------------------------
-- Game context and links
---------------------------------------------------------------------------

-- The agent only sees text, so two things about the game are spelled out for it:
-- who is asking (the character, where they are; sent with the hello and again
-- when it changes, and put into the agent's system prompt by the bridge), and
-- what the player shift-clicked into the message (item, spell and quest links
-- are meaningless markup to the agent; their tooltips are what the player sees).
-- Every game API here is optional: whatever the client lacks is left out.

local CONTEXT_MAX = 1200 -- bytes of context per record; the strip has ~3.2 KB for everything
local LINK_LINES_MAX = 30 -- tooltip lines kept per link
local LINK_BYTES_MAX = 900 -- bytes kept per link

-- Call a game API that may not exist or may throw, and get its returns or nothing.
local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g end
end

local function Money(copper)
	copper = tonumber(copper) or 0
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	if g > 0 then return g .. "g " .. s .. "s " .. c .. "c" end
	if s > 0 then return s .. "s " .. c .. "c" end
	return c .. "c"
end

-- A few lines about the game and the character, as the bridge will show them to the agent.
-- Profession and secondary skill lines by skill id (vanilla ids).
local PROFESSION_SKILL_IDS = {
	[164] = true, [165] = true, [171] = true, [182] = true, [186] = true, [197] = true, [202] = true,
	[333] = true, [393] = true, [129] = true, [185] = true, [356] = true,
}

-- The character's skill lines as { name, isHeader, rank, maxRank, skillID }.
-- Forever only has C_SkillInfo (one table per line); the classic globals
-- (multiple returns) are the fallback for other clients.
function WoWAI.SkillLines()
	local out = {}
	if C_SkillInfo and C_SkillInfo.GetNumSkillLines then
		local n = Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = Try(C_SkillInfo.GetSkillLineInfo, i)
			-- Child lines (parentSkillLineID ~= 0) repeat their parent; Blizzard's
			-- skills frame skips them too.
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local sname, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
		if type(sname) == "string" then
			out[#out + 1] = { name = sname, isHeader = isHeader and true or false, rank = rank, maxRank = maxRank }
		end
	end
	return out
end

function WoWAI.GameContext(kind)
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)

	local name = Try(UnitName, "player")
	if name then
		local realm = Try(GetRealmName)
		local level = Try(UnitLevel, "player")
		local race = Try(UnitRace, "player")
		local class = Try(UnitClass, "player")
		local faction = Try(UnitFactionGroup, "player")
		local guild = Try(GetGuildInfo, "player")
		local who = "Character: " .. tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
		local desc = {}
		if level then table.insert(desc, "level " .. tostring(level)) end
		if race then table.insert(desc, tostring(race)) end
		if class then table.insert(desc, tostring(class)) end
		if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
		if faction then who = who .. " (" .. tostring(faction) .. ")" end
		if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
		table.insert(lines, who)
	end

	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then
		table.insert(lines, "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or ""))
	end

	-- Map coordinates, as the minimap shows them (0-100 across the current map;
	-- addons get no world x/y/z). Modern C_Map first, the vanilla call as fallback.
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then x, y = pos.x, pos.y end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then x, y = px, py end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	end

	local progress = {}
	local copper = Try(GetMoney)
	if copper then table.insert(progress, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then
		table.insert(progress, "XP: " .. xp .. "/" .. xpMax)
	end
	if #progress > 0 then table.insert(lines, table.concat(progress, "; ")) end

	-- Classic-style talent tabs: name, icon, points spent.
	local tabs = Try(GetNumTalentTabs)
	if type(tabs) == "number" and tabs > 0 then
		local parts = {}
		for i = 1, tabs do
			local tname, _, points = Try(GetTalentTabInfo, i)
			if type(tname) == "string" and type(points) == "number" then
				table.insert(parts, tname .. " " .. points)
			end
		end
		if #parts > 0 then table.insert(lines, "Talents: " .. table.concat(parts, " / ")) end
	end

	-- Skill lines under the Professions and Secondary Skills headers.
	local header, parts = nil, {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	for _, sk in ipairs(WoWAI.SkillLines()) do
		if sk.isHeader then
			header = sk.name
		elseif (header and wanted[header]) or PROFESSION_SKILL_IDS[sk.skillID] then
			table.insert(parts, sk.name .. (sk.rank and (" " .. tostring(sk.rank) .. (sk.maxRank and ("/" .. tostring(sk.maxRank)) or "")) or ""))
		end
	end
	if #parts > 0 then table.insert(lines, "Professions: " .. table.concat(parts, ", ")) end

	-- Quest log ids (what is accepted, and which are done), so route planning can
	-- skip pickups and turn-ins that no longer apply.
	local quests = {}
	local qn = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries)
	if type(qn) == "number" then
		for i = 1, math.min(qn, 40) do
			local id, header, complete
			local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
			if type(info) == "table" then
				id, header = info.questID, info.isHeader
				complete = Try(C_QuestLog.IsComplete, id)
			else
				local _, _, _, isHeader, _, isComplete, _, qid = Try(GetQuestLogTitle, i)
				id, header, complete = qid, isHeader, isComplete == 1 or isComplete == true
			end
			if not header and type(id) == "number" and id > 0 then
				table.insert(quests, tostring(id) .. (complete and "*" or ""))
			end
		end
	end
	if #quests > 0 then table.insert(lines, "Quest log (id, * = ready to turn in): " .. table.concat(quests, ",")) end

	local extra = {}
	for _, mod in ipairs(ForeverModules()) do
		if type(mod.context) == "function" then
			local ok, value = pcall(mod.context, kind)
			if ok and type(value) == "string" and value ~= "" then
				local moduleMax = tonumber(mod.contextMax) or (kind and kind ~= "game" and 700 or 300)
				table.insert(extra, value:sub(1, moduleMax))
			end
		end
	end
	for _, value in ipairs(extra) do table.insert(lines, value) end
	local s = table.concat(lines, "\n"):gsub("[\30\31]", " ")
	local max = kind and kind ~= "game" and (Codec.MAX_PAYLOAD - 520) or CONTEXT_MAX
	if #s > max then s = s:sub(1, max) end
	return s
end

-- The context to put on the next record, or nil when the bridge already has
-- it (or it wouldn't fit next to this message; it goes with a later one).
-- "" when the setting is off, so the bridge drops what it had.
local function ContextToSend(room)
	local ctx = db.settings.context and WoWAI.GameContext() or ""
	if ctx == (run.contextSent or "") then return nil end
	if room and #ctx > room then return nil end
	return ctx
end

-- Read a link's tooltip off a hidden GameTooltip, one line per row.
local scanTip
local function TooltipLines(payload)
	if not scanTip then
		scanTip = CreateFrame("GameTooltip", "WoWAIScanTip", UIParent, "GameTooltipTemplate")
	end
	scanTip:SetOwner(UIParent, "ANCHOR_NONE")
	scanTip:ClearLines()
	local lines = {}
	if pcall(scanTip.SetHyperlink, scanTip, payload) then
		for i = 1, math.min(scanTip:NumLines() or 0, LINK_LINES_MAX) do
			local left = _G["WoWAIScanTipTextLeft" .. i]
			local right = _G["WoWAIScanTipTextRight" .. i]
			local l = Trim(tostring((left and left:GetText()) or ""))
			local r = Trim(tostring((right and right:IsShown() and right:GetText()) or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then table.insert(lines, l) end
		end
	end
	scanTip:Hide()
	return lines
end

local function MapName(id)
	local info = Try(C_Map and C_Map.GetMapInfo, tonumber(id))
	if type(info) == "table" and type(info.name) == "string" and info.name ~= "" then return info.name end
end

-- A shared map pin names its map by number ("/mappin 1420 9.7 63.9"). The map's
-- name goes after it, coordinates exactly as typed, so the agent need not look
-- the number up (backlog 60). An unknown map leaves the text as it was.
local PIN_PATTERNS = {
	"/mappin%s+#?(%d+)%s+(%d+%.?%d*)[,%s]+(%d+%.?%d*)",
	"/way%s+#(%d+)%s+(%d+%.?%d*)[,%s]+(%d+%.?%d*)",
}
function WoWAI.DecodePins(text)
	for _, pattern in ipairs(PIN_PATTERNS) do
		text = text:gsub("(" .. pattern .. ")", function(whole, id, x, y)
			local name = MapName(id)
			return name and (whole .. " (" .. name .. " " .. x .. ", " .. y .. ")") or whole
		end)
	end
	return text
end

-- What a link is, in words: "item 2140 (Uncommon)", "spell 1978", "quest 176",
-- "map pin Tirisfal Glades 9.7, 63.9".
local function DescribeLink(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local s = kind .. " " .. id
	if kind == "worldmap" then
		local x, y = payload:match("^worldmap:%d+:(%d+):(%d+)")
		local name = MapName(id)
		if name and x then return "map pin " .. name .. " " .. tonumber(x) / 100 .. ", " .. tonumber(y) / 100 end
	end
	if kind == "item" then
		local _, _, quality = Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then s = s .. " (" .. desc .. ")" end
	end
	return s
end

-- Turn the links in a message into text the agent can use: each becomes [Name]
-- in place, and a block at the end lists what the tooltip says about it.
-- Returns the new text and the number of links found.
function WoWAI.ExpandLinks(text)
	local links, seen = {}, {}
	local function Take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			table.insert(links, { payload = payload, name = name })
		end
		return "[" .. name .. "]"
	end
	-- Coloured links first (|cAARRGGBB|H...|h[Name]|h|r), then bare ones.
	local out = text:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", Take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, l in ipairs(links) do
		local head = "[" .. l.name .. "] " .. DescribeLink(l.payload)
		local body = table.concat(TooltipLines(l.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > LINK_BYTES_MAX then block = block:sub(1, LINK_BYTES_MAX) .. "..." end
		table.insert(blocks, block)
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------

-- Plain questions that need a context kind, first match wins: a rotation, build
-- or spell question gets the spellbook (backlog 61); a question about bags,
-- selling or junk gets the bag contents (backlog 62); "recap", as the recap offer's
-- link writes it, gets the recap profile with the low-health count (backlog 63).
local ASK_KINDS = {
	{ kind = "rotation", words = { "rotation", "opener", "build", "talents?", "specs?", "spells?", "abilit%a*", "cast%a*" } },
	{ kind = "bags", words = { "bags?", "bolsas?", "sell%a*", "vend%a*", "junk", "destroy%a*", "inventory" } },
	{ kind = "recap", words = { "recap" } },
}
function WoWAI.AskKind(text)
	local lower = tostring(text or ""):lower()
	for _, entry in ipairs(ASK_KINDS) do
		for _, word in ipairs(entry.words) do
			if lower:find("%f[%a]" .. word .. "%f[%A]") then return entry.kind end
		end
	end
end

-- allow: optional list of permission rules to grant before this message runs.
function WoWAI.Send(text, allow, opts)
	opts = type(opts) == "table" and opts or {}
	local c = type(opts.chat) == "string" and FindChat(opts.chat) or ActiveChat()
	-- force: the off/on switch itself, which must work even in combat.
	local blocked = opts.force ~= true and ForeverBlocked()
	if blocked then if c then AddHistory(c, "system", blocked); WoWAI.Render() end; return end
	if not c then return end
	text = Trim(text or "")
	if c.pendingId then
		-- Typing while waiting: keep the draft, and check for the reply.
		if text ~= "" then c.draft = text end
		if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then
			TryLoadSlot("manual")
		else
			SafeReload()
		end
		return
	end
	if text == "" then return end
	if not WoWAI.IsConnected() then
		-- Not connected: the message stays in the box and we try to connect;
		-- CheckConnection sends it the moment the light turns green. If the bridge
		-- never answers, the text is still in the box for a later try.
		if ui.input then ui.input:SetText(text) end
		run.sendOnConnect = { chat = c.id, text = text, allow = allow }
		if not run.connectingAt then WoWAI.Connect() end
		WoWAI.Toggle(true)
		return
	end
	-- Shift-clicked links become [Name] plus their tooltip, which is what the agent can read.
	local links, asked = nil, text
	text, links = WoWAI.ExpandLinks(WoWAI.DecodePins(text))
	local limit = Codec.MAX_PAYLOAD - 300
	if #text > limit then
		AddHistory(c, "system", "That message is too long for one send (" .. #text .. " chars, max ~" .. limit .. "). Split it up." .. (links > 0 and " Each linked item adds its tooltip to the message." or ""))
		WoWAI.Render()
		return
	end
	-- The game context rides along when the bridge doesn't have this version yet.
	-- A command, or a plain question about spells (backlog 61), gets that kind's context.
	local ctx
	local kind = type(opts.cmd) == "string" and opts.cmd or WoWAI.AskKind(asked)
	if kind then
		ctx = db.settings.context and WoWAI.GameContext(kind) or ""
	else
		ctx = ContextToSend(limit - #text)
	end
	ctx = ctx or ""
	local addition = type(opts.context) == "string" and opts.context or ""
	-- A command profile or one-off addition is not the base context the bridge caches.
	local temporaryContext = kind ~= nil or addition ~= ""
	local contextMax = math.max(0, Codec.MAX_PAYLOAD - 520 - #text)
	if #ctx > contextMax then ctx = ctx:sub(1, contextMax) end
	if addition ~= "" then
		local room = math.max(0, contextMax - #ctx - (ctx ~= "" and 1 or 0))
		ctx = ctx .. (ctx ~= "" and "\n" or "") .. addition:sub(1, room)
	end
	if ctx == "" then ctx = nil end

	db.lastSeq = db.lastSeq + 1
	local id = db.lastSeq
	local tokens = {}
	if c.resetNext then table.insert(tokens, "n") end
	local pool = PoolFlags(c)
	if pool ~= "" then table.insert(tokens, pool) end
	if type(opts.cmd) == "string" and opts.cmd:match("^[a-z0-9-]+$") and #opts.cmd <= 24 then table.insert(tokens, "cmd=" .. opts.cmd) end
	local allowHex
	if type(allow) == "table" and #allow > 0 then
		table.insert(tokens, "allow=" .. table.concat(allow, ","))
		allowHex = ToHex(table.concat(allow, US))
	end
	local flags = table.concat(tokens, ";")
	local newSession = c.resetNext and true or nil
	c.resetNext = nil
	db.outbox = {
		id = id,
		session = db.session,
		chat = c.id,
		text = ToHex(text),
		cwd = ToHex(c.cwd),
		ctx = ctx and ToHex(ctx) or nil,
		agent = (c.agent and c.agent ~= "") and c.agent or nil,
		model = ChatModel(c) ~= "" and c.model or nil,
		allow = allowHex,
		cmd = (type(opts.cmd) == "string" and opts.cmd:match("^[a-z0-9-]+$") and #opts.cmd <= 24) and opts.cmd or nil,
		newSession = newSession,
		t = time(),
	}
	c.pendingId = id
	c.draft = nil
	c.progress = nil
	c.stall = nil
	AddHistory(c, "user", text, id)
	-- A chat still carrying its default name takes its title from the first message
	-- you send (system notes like "/wow-ai cd" before it don't count).
	if c.name:match("^Chat %d+$") then
		local first = true
		for _, m in ipairs(c.history) do
			if m.role == "user" and m.id ~= id then first = false break end
		end
		if first then c.name = AutoTitle(text) or c.name end
	end
	db.settings.shown = true

	if db.settings.mode == "pixel" then
		run.outbound[id] = { chat = c.id, cwd = c.cwd, flags = flags, name = c.name, text = text, ctx = ctx, temporaryContext = temporaryContext, force = opts.force == true or nil, sentAt = GetTime() }
		run.sentAt = GetTime()
		run.polls = 0
		StartActivity(c, id)
		ScheduleNextPoll()
		RefreshStrip()
		WoWAI.Render()
	else
		SafeReload()
	end
end

-- Forget: a record with no text telling the bridge a chat was deleted, so it drops
-- the transcript (which a later restore would otherwise bring back) and the
-- agent session. db.forget keeps the id until the bridge acks, so a delete made
-- while the bridge was away is sent again with the next hello.
local function SendForget(chatId)
	if db.settings.mode ~= "pixel" then return end
	for _, rec in pairs(run.outbound) do
		if rec.forget == chatId and not rec.acked then return end
	end
	local info = db.forget[chatId] or {}
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = chatId, cwd = info.cwd or "", flags = "d", name = info.name or "", text = "", sentAt = GetTime(), forget = chatId }
	RefreshStrip()
end

local function ForgetOnBridge(c)
	if not c or not c.id then return end
	db.forget[c.id] = { name = c.name, cwd = c.cwd }
	SendForget(c.id)
end

-- Hello: a record with no text that just announces our session token. The bridge
-- acks it, offers a restore if our saved data is fresh, and refreshes the slots,
-- so the status light and any lost chats come back before the first message.
-- The game context always rides on it (empty when turned off), so the bridge's
-- copy is brought in line at every login and Connect.
function WoWAI.SayHello()
	if db.settings.mode ~= "pixel" then return end
	local now = GetTime()
	if run.lastHelloAt and now - run.lastHelloAt < 60 then return end
	run.lastHelloAt = now
	db.lastSeq = db.lastSeq + 1
	local c = ActiveChat()
	local ctx = db.settings.context and WoWAI.GameContext() or ""
	run.outbound[db.lastSeq] = { chat = c and c.id or "", cwd = c and c.cwd or "", flags = "h", name = c and c.name or "", text = "", ctx = ctx, sentAt = now, hello = true }
	run.helloPollAt = now + 5
	-- Deletions the bridge never confirmed ride along with the hello.
	for id in pairs(db.forget) do SendForget(id) end
	-- Fresh saved data: show "restoring" instead of an empty panel until we hear back.
	if not db.restored then
		local empty = true
		for _, ch in ipairs(db.chats) do
			if #ch.history > 0 then empty = false end
		end
		if empty then run.restoring = now end
	end
	RefreshStrip()
	WoWAI.Render()
end

-- Put the active chat's pending message back on the strip.
function WoWAI.Resend()
	local c = ActiveChat()
	if not c or not c.pendingId then return end
	local text
	for i = #c.history, 1, -1 do
		if c.history[i].id == c.pendingId and c.history[i].role == "user" then
			text = c.history[i].text
			break
		end
	end
	if not text then return end
	run.outbound[c.pendingId] = { chat = c.id, cwd = c.cwd, flags = PoolFlags(c), name = c.name, text = text, sentAt = GetTime() }
	run.sentAt = GetTime()
	run.polls = 0
	ScheduleNextPoll()
	RefreshStrip()
	WoWAI.UpdateStatus()
end

-- The text of the last message the player sent in a chat.
local function LastUserText(c)
	for i = #c.history, 1, -1 do
		if c.history[i].role == "user" then return c.history[i].text end
	end
end

-- Stop button: give up on the pending message here and tell the bridge to end the
-- agent's run (a record like a delete: no text, flag "s"). Pixel transport only;
-- in reload mode the bridge cannot be told until the next reload.
function WoWAI.StopRun(c)
	c = c or ActiveChat()
	if not c or not c.pendingId then return end
	if db.settings.mode == "pixel" then
		db.lastSeq = db.lastSeq + 1
		run.outbound[db.lastSeq] = { chat = c.id, cwd = c.cwd, flags = "s", name = c.name, text = "", sentAt = GetTime(), stop = true }
	end
	AddHistory(c, "system", "Stopped waiting for " .. ChatAgentName(c) .. "; the bridge was told to stop it")
	run.outbound[c.pendingId] = nil
	if run.act then run.act[c.id] = nil end
	c.pendingId = nil
	c.progress = nil
	c.stall = nil
	RefreshStrip()
	if not AnyPending() and not WoWAI.reloadAfterCombat then keyCatcher:Hide() end
	WoWAI.Render()
end

-- Whether "Ask Claude instead" makes sense: Claude is installed on the bridge PC,
-- this chat is not already on it, and there is a question to send again.
function WoWAI.CanAskClaude(c)
	return c ~= nil and c.stall ~= nil and run.bridgeAgents ~= nil and Contains(run.bridgeAgents, "claude")
		and ChatAgent(c) ~= "claude" and LastUserText(c) ~= nil
end

-- Ask Claude instead: stop the stalled run if there is one, switch this chat to
-- Claude and send the same question again. Only ever runs from the player's click.
function WoWAI.AskClaude(c)
	c = c or ActiveChat()
	if not WoWAI.CanAskClaude(c) then return end
	local text = LastUserText(c)
	if c.pendingId then WoWAI.StopRun(c) end
	c.stall = nil
	WoWAI.SetPool(c, "claude", "")
	WoWAI.Send(text)
end

-- Exactly these, any case, trailing . ! ? allowed; "look at the boss in Deadmines" stays a message.
local LONE_LOOK = { ["look"] = true, ["look at this"] = true, ["look at my screen"] = true }
local function IsLoneLook(text)
	local s = Trim(text):lower():gsub("[%.!%?]+$", ""):gsub("%s+", " ")
	return LONE_LOOK[s] == true
end

function WoWAI.SendFromInput()
	if not ui.input then return end
	WindowUsed()
	local text = ui.input:GetText()
	ui.input:SetText("")
	ui.input:ClearFocus() -- hand the keyboard back to the game after sending
	-- A lone "review" typed in the box is the review command, not a plain message.
	if Trim(text):lower():match("^review[%.!]*$") then return SlashCmdList["WOWAI"]("review") end
	-- So is a lone "look" (backlog 84): the player pressed Print Screen and typed "look!".
	if IsLoneLook(text) then return SlashCmdList["WOWAI"]("look") end
	-- A line starting with "/" is a command: it runs here or is called unknown,
	-- and never reaches the agent (backlog 55).
	if Trim(text):sub(1, 1) == "/" then return WoWAI.BoxCommand(text) end
	WoWAI.Send(text)
end

-- The commands the box understands. Each maps onto the addon's own logic (the
-- AI picker's model switch, new chat, review); none runs a game command.
local BOX_HELP = "The box understands: /model [name] (this chat's model), /agent [name [model]] (which AI), /new [name] (new chat), /review (review your last fight), /look [question] (ask about your newest screenshot: press Print Screen first), /help. Anything else starting with / is not sent; type it in the game chat instead, or drop the / to ask the agent."

function WoWAI.BoxCommand(text)
	local c = ActiveChat()
	if not c then return end
	local word, rest = Trim(text):match("^/(%S*)%s*(.-)$")
	word = (word or ""):lower()
	if word == "model" then
		WoWAI.SetModel(rest, c)
	elseif word == "agent" then
		WoWAI.SetAgent(rest, c)
	elseif word == "new" then
		WoWAI.NewChat(rest)
	elseif word == "review" and rest == "" then
		return SlashCmdList["WOWAI"]("review")
	elseif word == "look" then
		return SlashCmdList["WOWAI"](rest == "" and "look" or "look " .. rest)
	elseif word == "help" and rest == "" then
		AddHistory(c, "system", BOX_HELP)
		WoWAI.Render()
	else
		AddHistory(c, "system", "Unknown command /" .. word:sub(1, 24) .. ". Type /help to see what the box understands.")
		WoWAI.Render()
	end
end

-- The Allow button: grant the rules a reply asked for, then tell the agent to carry on.
function WoWAI.Allow(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if db.activeChat ~= c.id then WoWAI.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do m.denied = nil end
	AddHistory(c, "system", "Allowed: " .. table.concat(rules, ", "))
	WoWAI.Send("Those actions are allowed now. Continue from where you left off.", rules)
end

---------------------------------------------------------------------------
-- Chats
---------------------------------------------------------------------------

function WoWAI.SwitchChat(id)
	local c = FindChat(id)
	if not c then return end
	local prev = ActiveChat()
	if prev and prev ~= c and ui.input then
		local typed = Trim(ui.input:GetText() or "")
		prev.draft = typed ~= "" and typed or nil
	end
	db.activeChat = c.id
	c.unread = 0
	-- A menu opened for the old chat would name it while another is shown.
	if ui.picker then ui.picker:Hide() end
	if ui.chatMenu then ui.chatMenu:Hide() end
	if ui.input then
		ui.input:SetText(c.draft or "")
		c.draft = nil
	end
	WoWAI.Render()
	WoWAI.RenderChatList()
end

function WoWAI.NewChat(name)
	-- Unnamed and an empty chat already waits: use it instead of piling up more.
	if not name or name == "" then
		for _, e in ipairs(db.chats) do
			if #e.history == 0 and not e.pendingId then
				WoWAI.SwitchChat(e.id)
				WoWAI.Toggle(true)
				return
			end
		end
	end
	local c = AddChat(name and name ~= "" and name or nil)
	if not c then
		local a = ActiveChat()
		AddHistory(a, "system", "Chat limit reached (" .. MAX_CHATS .. "). Delete one first with /wow-ai delete.")
		WoWAI.Render()
		return
	end
	WoWAI.SwitchChat(c.id)
	WoWAI.Toggle(true)
end

-- Folder this chat's agent works in. Empty (or "-" / "default") = the bridge's
-- default. Relative paths are resolved by the bridge against that default.
function WoWAI.SetFolder(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or "")
	if rest == "-" or rest == "default" then rest = "" end
	local base = run.bridgeCwd or "the bridge's default folder"
	if rest ~= "" then
		local changed = rest ~= c.cwd
		c.cwd = rest
		local absolute = rest:match("^%a:[\\/]") or rest:match("^[\\/~]")
		local note = absolute and "" or (" (relative to " .. base .. ")")
		AddHistory(c, "system", "cwd set to " .. rest .. note .. (changed and #c.history > 1 and ("; the next message starts a fresh " .. ChatAgentName(c) .. " session there") or ""))
	elseif c.cwd ~= "" then
		c.cwd = ""
		AddHistory(c, "system", "cwd reset to the bridge's default: " .. base)
	else
		AddHistory(c, "system", "cwd is the bridge's default: " .. base .. " (/wow-ai cd <folder>, or right-click the chat and pick Folder, to change)")
	end
	WoWAI.Render()
end

StaticPopupDialogs["WOWAI_FOLDER"] = {
	text = "Folder for this chat\n\nRelative to the bridge's folder (%s), ~, or a full path.\nEmpty = the bridge's default. Changing it starts a fresh agent session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 320,
	maxLetters = 250,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.cwd or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then WoWAI.SetFolder(box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["WOWAI_FOLDER"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Folder dialog for a chat (the active one when no id is given).
function WoWAI.FolderPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("WOWAI_FOLDER", run.bridgeCwd or "unknown until connected", nil, { id = c.id, cwd = c.cwd })
end

-- The agent this chat talks to, by id, and optionally one of the models the
-- bridge offers for it. Empty (or "-" / "default") = the bridge's default. The
-- bridge starts a fresh session when a chat changes agent, since a session
-- belongs to the agent that made it; a model change keeps the conversation.
local function AgentList()
	return run.bridgeAgents and table.concat(run.bridgeAgents, ", ") or "claude, codex, grok, agy, hermes"
end

-- The models the bridge offers for an agent, or nil before it has said.
local function ModelsFor(agent)
	local m = run.bridgeModels and run.bridgeModels[agent]
	return type(m) == "table" and m or nil
end

local function DefaultPoolText()
	return run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"
end

-- Switch a chat to an agent and model ("" and "" = the bridge's default).
function WoWAI.SetPool(c, agent, model)
	if not c then return end
	agent, model = agent or "", model or ""
	if agent == "" then model = "" end
	local agentChanged = agent ~= (c.agent or "")
	local changed = agentChanged or model ~= ChatModel(c)
	c.agent, c.model = agent, model
	if agent ~= "" then
		AddHistory(c, "system", "agent set to " .. PoolName(agent, model) .. (agentChanged and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		AddHistory(c, "system", "agent reset to the bridge's default: " .. DefaultPoolText())
	else
		AddHistory(c, "system", "agent is the bridge's default: " .. DefaultPoolText() .. " (click the AI button under the chat, or /wow-ai agent <name> [model], to change; agents: " .. AgentList() .. ")")
	end
	WoWAI.Render()
end

-- /wow-ai agent [name [model]]
function WoWAI.SetAgent(rest, c)
	c = c or ActiveChat()
	if not c then return end
	local agent, model = Trim(rest or ""):match("^(%S*)%s*(.-)$")
	agent, model = (agent or ""):lower(), Trim(model or "")
	if agent == "-" or agent == "default" then agent, model = "", "" end
	if agent ~= "" and run.bridgeAgents and not Contains(run.bridgeAgents, agent) then
		AddHistory(c, "system", "Unknown agent \"" .. agent .. "\". This PC has: " .. AgentList())
		WoWAI.Render()
		return
	end
	if model ~= "" then
		local models = ModelsFor(agent)
		if #model > 64 or not model:match("^[%w][%w%._:/@%[%]%-]*$") or (models and not Contains(models, model)) then
			AddHistory(c, "system", "Unknown model \"" .. model .. "\" for " .. AgentName(agent) .. ". Models: " .. ((models and #models > 0) and table.concat(models, ", ") or "only its default"))
			WoWAI.Render()
			return
		end
	end
	WoWAI.SetPool(c, agent, model)
end

-- /model [name]: the model for this chat's agent (the bridge's default agent
-- when the chat has none). Same checks and wording as /wow-ai agent <name> <model>.
function WoWAI.SetModel(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or "")
	local agent = (c.agent and c.agent ~= "") and c.agent or run.bridgeAgent
	if not agent or agent == "" then
		AddHistory(c, "system", "Connect to the bridge first; it says which models this PC has.")
		WoWAI.Render()
		return
	end
	if rest == "" then
		local models = ModelsFor(agent)
		AddHistory(c, "system", "This chat uses " .. PoolName(c.agent or "", ChatModel(c)) .. ". Models for " .. AgentName(agent) .. ": " .. ((models and #models > 0) and table.concat(models, ", ") or "only its default") .. ". Pick one with /model <name>, or click the AI button under the chat.")
		WoWAI.Render()
	elseif rest:lower() == "default" or rest == "-" then
		WoWAI.SetPool(c, c.agent or "", "")
	else
		WoWAI.SetAgent(agent .. " " .. rest, c)
	end
end

-- The choices the AI picker lists: the bridge's default, then every agent
-- installed on the bridge PC, once on its own default model and once per model
-- the bridge offers for it.
function WoWAI.PoolChoices()
	local list = { { agent = "", model = "", label = "Bridge default (" .. DefaultPoolText() .. ")" } }
	local agents = run.bridgeAgents or { "claude", "codex", "grok", "agy", "hermes" }
	for _, id in ipairs(agents) do
		table.insert(list, { agent = id, model = "", label = AgentName(id) })
		for _, m in ipairs(ModelsFor(id) or {}) do
			table.insert(list, { agent = id, model = m, label = "    " .. PoolName(id, m) })
		end
	end
	return list
end

-- Agent picker for a chat (the active one when no id is given).
function WoWAI.AgentPrompt(id, anchor)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c or not WoWAI.ShowPicker then return end
	WoWAI.ShowPicker(c.id, anchor)
end

StaticPopupDialogs["WOWAI_RENAME"] = {
	text = "Rename this chat",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	maxLetters = 24,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.name or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		local name = box and Trim(box:GetText() or "") or ""
		if chat and name ~= "" then
			chat.name = name:sub(1, 24)
			WoWAI.Render()
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["WOWAI_RENAME"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Rename dialog for a chat (the active one when no id is given).
function WoWAI.RenamePrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("WOWAI_RENAME", nil, nil, { id = c.id, name = c.name })
end
WoWAI.RenameActive = WoWAI.RenamePrompt

-- Delete a chat (the active one when no id is given). The last chat is cleared
-- and renamed instead of removed, so there is always one to type into. Either
-- way the bridge is told to forget it, so a restore won't bring it back.
function WoWAI.DeleteChat(id)
	local c, idx = nil, nil
	if id then c, idx = FindChat(id) end
	if not c then c, idx = ActiveChat() end
	if not c then return end
	ForgetOnBridge(c)
	if #db.chats == 1 then
		wipe(c.history)
		c.pendingId, c.progress, c.unread, c.draft = nil, nil, 0, nil
		c.name = "Chat 1"
		WoWAI.Render()
		WoWAI.RenderChatList()
		return
	end
	table.remove(db.chats, idx)
	if db.activeChat == c.id then
		WoWAI.SwitchChat(db.chats[math.min(idx, #db.chats)].id)
	else
		WoWAI.RenderChatList()
	end
end

-- The trash can on a chat row asks first; /wow-ai delete does not.
StaticPopupDialogs["WOWAI_DELETE"] = {
	text = "Delete chat \"%s\"?\n\nIts transcript goes away (the last chat is cleared instead of removed).",
	button1 = OKAY,
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then WoWAI.DeleteChat(data.id) end
	end,
}

function WoWAI.ConfirmDelete(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("WOWAI_DELETE", Display(c.name), nil, { id = c.id })
end

---------------------------------------------------------------------------
-- Rendering
---------------------------------------------------------------------------

-- Stop and Ask Claude instead sit at the right end of the status line, only while a
-- run is stalled (or ended with no reply). The status text gives way to them.
function WoWAI.UpdateStallButtons(c)
	if not ui.stopBtn then return end
	local stop = c ~= nil and c.pendingId ~= nil and c.stall ~= nil
	local ask = WoWAI.CanAskClaude(c)
	ui.stopBtn:SetShown(stop)
	ui.askBtn:SetShown(ask)
	local width = 0
	if ask then width = width + 150 end
	if stop then width = width + 60 end
	ui.status:SetPoint("RIGHT", ui.frame, "RIGHT", -(60 + width), 0)
end

function WoWAI.UpdateStatus()
	if not ui.status then return end
	local c = ActiveChat()
	local mode = db.settings.mode
	local s
	if c and c.pendingId then
		local id = c.pendingId
		local elapsed = run.sentAt and (GetTime() - run.sentAt) or 0
		local rec = run.outbound[id]
		if mode == "pixel" then
			if run.slotsMissing then
				s = "Reply slots not installed (run install-slots.js, restart WoW). Using reload instead: Enter or Refresh"
			elseif run.slotsExhausted then
				-- No slot left to read the reply through; only a reload frees the pool.
				-- The addon cannot tell whether the reply is finished, so it says "check".
				s = "Out of reply slots: click Get reply to check for your reply (the game UI reloads)"
				if c.stall then s = ChatAgentName(c) .. (c.stall == "quiet" and " has gone quiet. " or " is taking long. ") .. s end
			elseif run.pixelFailed then
				s = "Bridge didn't see your message after " .. STRIP_TRIES .. " tries - next keypress switches to the reload path (or /wow-ai reload)"
			elseif c.stall then
				s = ChatAgentName(c) .. (c.stall == "quiet" and " has gone quiet" or " is taking long") .. " - " .. ActivityLine(c)
			elseif c.progress or (run.act and run.act[c.id] and run.act[c.id].count > 0) then
				s = ChatAgentName(c) .. " is working - " .. ActivityLine(c)
			elseif rec and not rec.acked then
				s = "Sending" .. (rec.tries and rec.tries > 1 and (" (try " .. rec.tries .. "/" .. STRIP_TRIES .. ")") or "") .. "..."
				local state = WoWAI.BridgeState()
				if state == "down" then s = s .. " - bridge not seen lately, is the bridge running?" end
			else
				s = "Waiting for the reply (checked " .. (run.polls or 0) .. "x)"
				if elapsed > 45 then
					s = s .. " - no sign of the bridge. Is the bridge running? /wow-ai resend"
				end
			end
		else
			s = "Waiting for the reply. Enter or Refresh checks now"
			if db.settings.autoRefresh then
				s = s .. "; auto on next keypress after " .. db.settings.interval .. "s"
			end
		end
	elseif not WoWAI.IsConnected() then
		if run.connectingAt and run.sendOnConnect then
			s = "Connecting to the bridge... your message goes out as soon as it answers"
		elseif run.connectingAt then
			s = "Connecting to the bridge..."
		elseif run.connectFailed then
			s = "No answer from the bridge. Is it running (npm start)? Connect tries again"
		elseif WoWAI.BridgeState() == "stale" then
			s = "Bridge not seen for a while - click Reconnect"
		else
			s = "Not connected - start the bridge, then click Connect"
		end
	elseif c and c.draft and c.draft ~= "" and ui.input and Trim(ui.input:GetText() or "") ~= "" then
		s = "Reply arrived. Your draft is back in the box - Enter to send it"
	elseif run.restoring then
		s = "Connecting to the bridge..."
	elseif c and c.stall == "noreply" then
		s = ChatAgentName(c) .. " sent no answer"
	else
		s = "Ready"
	end
	ui.status:SetText(s)
	WoWAI.UpdateStallButtons(c)
	run.statusText = s
	local cwdText
	if c and c.cwd ~= "" then
		cwdText = Display(c.cwd)
	elseif run.bridgeCwd then
		cwdText = Display(run.bridgeCwd) .. " (bridge default)"
	else
		cwdText = "(bridge default - start the bridge in a folder, or right-click the chat and pick Folder)"
	end
	local agentText
	if c and c.agent and c.agent ~= "" then
		agentText = PoolName(c.agent, ChatModel(c))
	elseif run.bridgeAgent then
		agentText = AgentName(run.bridgeAgent)
	else
		agentText = "default"
	end
	-- Footer: the agent's name only. Folder and mode go to the light's tooltip (backlog 82).
	run.detailTip = "cwd: " .. cwdText .. "\nmode: " .. mode
	ui.cwd:SetText("Agent: " .. agentText)
	WoWAI.UpdateDot()
	WoWAI.UpdateConnect()
	if ui.title then
		local t = c and Display(c.name) or "WoW AI"
		local folder = FolderName(ChatFolder(c))
		if folder ~= "" then t = t .. "  |cff888888" .. Display(folder) .. "|r" end
		if c and c.agent and c.agent ~= "" then t = t .. "  |cff888888" .. PoolName(c.agent, ChatModel(c)) .. "|r" end
		ui.title:SetText(t)
	end
	if ui.pool then ui.pool:SetText("AI: " .. ((c and c.agent and c.agent ~= "") and PoolName(c.agent, ChatModel(c)) or (run.bridgeAgent and AgentName(run.bridgeAgent) or "default"))) end
	-- Reload and Resend share one place on the bottom row (backlog 82): when a
	-- reload is the way forward, Reload (or Get reply) shows and Resend does not.
	local reloadShown = mode ~= "pixel" or run.slotsExhausted or run.slotsMissing or run.pixelFailed or false
	if ui.refresh then
		ui.refresh:SetText((mode == "pixel" and run.slotsExhausted and c and c.pendingId) and "Get reply" or "Reload")
		ui.refresh:SetShown(reloadShown)
	end
	if ui.resend then ui.resend:SetShown(c and c.pendingId ~= nil and mode == "pixel" and not reloadShown) end
	WoWAI.UpdateLogButton()
	WoWAI.UpdateMini()
end

-- One message bubble: accent bar, colored label, timestamp, wrapped body.
local function GetBubble(i)
	local b = ui.bubbles[i]
	if b then return b end
	b = CreateFrame("Frame", nil, ui.content)
	b.bg = b:CreateTexture(nil, "BACKGROUND")
	b.bg:SetAllPoints()
	b.accent = b:CreateTexture(nil, "BORDER")
	b.accent:SetPoint("TOPLEFT", b, "TOPLEFT", 0, 0)
	b.accent:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 0)
	b.accent:SetWidth(3)
	b.who = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", 10, -6)
	b.who:SetJustifyH("LEFT")
	b.when = b:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	b.when:SetPoint("TOPRIGHT", b, "TOPRIGHT", -8, -6)
	b.body = b:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
	b.body:SetPoint("TOPLEFT", b.who, "BOTTOMLEFT", 0, -4)
	b.body:SetJustifyH("LEFT")
	b.body:SetJustifyV("TOP")
	b.body:SetWordWrap(true)
	b.body:SetNonSpaceWrap(true)
	b.allow = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.allow:SetHeight(22)
	b.allow:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6)
	b.allow:SetScript("OnClick", function(self)
		WoWAI.Allow(self.chatId, self.rules)
	end)
	b.allow:Hide()
	-- FontStrings can't be selected, so a small copy icon opens the message in the
	-- copy box. No tooltip: it followed the mouse and covered the text.
	b.copyBtn = CreateFrame("Button", nil, b)
	b.copyBtn:SetSize(16, 16)
	b.copyBtn:SetPoint("TOPRIGHT", b, "TOPRIGHT", -6, -4)
	b.copyBtn.icon = b.copyBtn:CreateTexture(nil, "ARTWORK")
	b.copyBtn.icon:SetAllPoints()
	b.copyBtn.icon:SetTexture("Interface\\Buttons\\UI-GuildButton-PublicNote-Up")
	b.copyBtn.icon:SetVertexColor(0.8, 0.8, 0.8)
	local hl = b.copyBtn:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	hl:SetColorTexture(1, 1, 1, 0.2)
	b.copyBtn:SetScript("OnClick", function()
		if b.text and b.text ~= "" then WoWAI.ShowCopy(b.text) end
	end)
	b.when:ClearAllPoints()
	b.when:SetPoint("TOPRIGHT", b.copyBtn, "TOPLEFT", -4, -2)
	ui.bubbles[i] = b
	if WoWAIForever and WoWAIForever.Fire then WoWAIForever.Fire("BUBBLE_BUILT", b) end
	return b
end

-- The slash commands in a reply, one per line (backticks and list marks dropped),
-- so each can get its own copy button. Capped: a long list would bury the reply.
local COPY_MAX = 4
local NO_COPY = { run = true, script = true, runscript = true, console = true, dump = true }
function WoWAI.CommandLines(text)
	local out = {}
	for line in (tostring(text or "") .. "\n"):gmatch("(.-)\r?\n") do
		local cmd = line:match("^[%s%-%*>`]*(/%a[^`]*)")
		local word = cmd and cmd:match("^/([%w_%-]+)")
		-- Not a file path, and never a script line: those are not offered for pasting.
		local script = false
		for w in (cmd or ""):gmatch("/(%a+)") do
			if NO_COPY[w:lower()] then script = true end
		end
		if word and not cmd:match("^/[%w_%-]+/") and not script then
			if #out < COPY_MAX then table.insert(out, Trim(cmd)) end
		end
	end
	return out
end

-- Four first questions for an empty chat, fitted to the character's class and
-- level. Clicking one types it into the box; the player presses Enter.
function WoWAI.StarterQuestions()
	local class = type(UnitClass) == "function" and UnitClass("player") or nil
	local level = tonumber(type(UnitLevel) == "function" and UnitLevel("player")) or 1
	local who = "level " .. level .. " " .. (class or "character")
	return {
		"My character: " .. who .. ". What should I focus on right now?",
		"Which abilities matter most for a " .. (class or "character") .. " at level " .. level .. ", and what is each for?",
		level < 10 and "I'm new to the game. What should I set up before I go on?"
			or ("Is my gear fine for level " .. level .. ", and what should I look for next?"),
		"Where should my " .. who .. " go to level next?",
	}
end

-- The starter card's buttons: the four questions, then (if offered) a button
-- that switches the chat to the fast model. Short questions answer sooner there.
function WoWAI.StarterList(c)
	local list = WoWAI.StarterQuestions()
	local fast = WoWAI.FastModelOffer(c)
	if fast then
		fast.label = "Short questions? Use the fast model (" .. fast.model .. ")"
		table.insert(list, fast)
	end
	return list
end

-- A fast model of the chat's agent (haiku for Claude), offered on the starter card
-- for short questions. Nil when the chat already uses it or the agent has none.
function WoWAI.FastModelOffer(c)
	local agent = c and ((c.agent and c.agent ~= "") and c.agent or run.bridgeAgent) or nil
	if not agent or agent == "" then return nil end
	for _, m in ipairs(ModelsFor(agent) or {}) do
		if m:lower():find("haiku", 1, true) then
			if m == ChatModel(c) then return nil end
			return { agent = agent, model = m }
		end
	end
end

-- One-click follow-ups under the newest finished reply: only the questions the
-- mentor suggested in that reply (the bridge turns its "FOLLOW-UPS:" line into
-- `followUps`, at most two). A click types the question into the box; the player
-- presses Enter. A reply without the tag shows no buttons.

-- The player sees plain names on the Allow button, not rule syntax: "Bash(ls:*)" reads
-- "ls", "mcp__claude_ai_Google_Drive__create_file" reads "Google Drive (create file)",
-- and any other rule its first word ("Read(//c/x/**)" reads "Read").
local function AllowName(rule)
	rule = tostring(rule)
	local bash = rule:match("^Bash%(([^:]+):%*%)$")
	if bash then return bash end
	local server, action = rule:match("^mcp__(.-)__(.+)$")
	server = server or rule:match("^mcp__(.+)$")
	if server then
		server = server:gsub("^claude_ai_", ""):gsub("_", " ")
		if not action then return server end
		return server .. " (" .. action:gsub("_", " "):lower() .. ")"
	end
	return rule:match("^[%w_%-%.]+") or rule
end

function WoWAI.Render()
	local c = ActiveChat()
	if ui.content and c then
		-- Follow the bottom only when the player is there, switched chat, or a new
		-- message arrived; a resize or status refresh keeps a scrolled-up position.
		local last = c.history[#c.history]
		local stick = ui.scrollStick ~= false or ui.scrollChat ~= c.id or ui.scrollLast ~= last
		ui.scrollChat, ui.scrollLast = c.id, last
		local width = ui.scroll:GetWidth()
		if not width or width < 80 then width = 400 end
		ui.content:SetWidth(width)
		local y, n = 0, 0
		local function Place(role, text, when, dim, denied, agent, starters, follow)
			-- `follow` is the list of suggested questions (newest finished reply only).
			n = n + 1
			local b = GetBubble(n)
			local st = ROLE_STYLE[role] or ROLE_STYLE.system
			b:SetWidth(width)
			b.bg:SetColorTexture(st.bg[1], st.bg[2], st.bg[3], st.bg[4])
			b.accent:SetColorTexture(st.color[1], st.color[2], st.color[3], 0.9)
			b.who:SetText(st == ROLE_STYLE.assistant and ReplyAgentName(c, agent) or st.label)
			b.who:SetTextColor(st.color[1], st.color[2], st.color[3])
			b.when:SetText(when or "")
			b.body:SetWidth(width - 18)
			b.body:SetText(Display(Plain(text)))
			if dim then
				b.body:SetTextColor(0.72, 0.72, 0.72)
			else
				b.body:SetTextColor(0.93, 0.93, 0.93)
			end
			local h = b.body:GetStringHeight()
			if not h or h < 1 then h = 14 end
			local extra = 0
			if denied then
				local names = {}
				for _, rule in ipairs(denied) do table.insert(names, AllowName(rule)) end
				local label = "Allow " .. table.concat(names, ", ") .. " & retry"
				b.allow:SetText(label)
				b.allow:SetWidth(math.min(width - 24, math.max(160, b.allow:GetFontString():GetStringWidth() + 30)))
				b.allow.chatId = c.id
				b.allow.rules = denied
				b.allow:Show()
				extra = 28
			else
				b.allow:Hide()
			end
			-- One small copy button per command line of a finished reply: the copy box
			-- opens with only that line. The player still pastes and sends it.
			local cmds = starters or ((role == "assistant" and not dim) and WoWAI.CommandLines(text) or {})
			b.copies = b.copies or {}
			for k, cmd in ipairs(cmds) do
				local pool = type(cmd) == "table" and cmd or nil
				if pool then cmd = pool.label end
				local cb = b.copies[k]
				if not cb then
					cb = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
					cb:SetHeight(20)
					cb:SetScript("OnClick", function(self)
						if self.pool then return WoWAI.SetPool(FindChat(self.pool.chat), self.pool.agent, self.pool.model) end
						if not self.fill then return WoWAI.ShowCopy(self.line) end
						if ui.input then ui.input:SetText(self.line); ui.input:SetFocus() end
					end)
					b.copies[k] = cb
				end
				local label = starters and Display(cmd) or ("copy: " .. Display(#cmd > 44 and (cmd:sub(1, 44) .. "...") or cmd))
				cb:SetText(label)
				cb:SetWidth(math.min(width - 24, cb:GetFontString():GetStringWidth() + 30))
				cb.line = cmd
				cb.pool = pool and { chat = c.id, agent = pool.agent, model = pool.model } or nil
				cb.fill = starters ~= nil
				cb:ClearAllPoints()
				cb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				cb:Show()
				extra = extra + 24
			end
			for k = #cmds + 1, #b.copies do b.copies[k]:Hide() end
			b.follows = b.follows or {}
			local nfollow = 0
			if type(follow) == "table" and not (WoWAIForever and WoWAIForever.Locked and WoWAIForever.Locked()) then
				for _, question in ipairs(follow) do
					if nfollow >= MAX_FOLLOW_UPS then break end
					nfollow = nfollow + 1
					local fb = b.follows[nfollow]
					if not fb then
						fb = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
						fb:SetHeight(20)
						fb:SetScript("OnClick", function(self)
							if ui.input then
								ui.input:SetText(self.fill)
								ui.input:SetFocus()
							end
						end)
						b.follows[nfollow] = fb
					end
					fb:SetText(question)
					fb:SetWidth(math.min(width - 24, fb:GetFontString():GetStringWidth() + 30))
					fb.fill = question
					fb:ClearAllPoints()
					fb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
					fb:Show()
					extra = extra + 24
				end
			end
			for k = nfollow + 1, #b.follows do b.follows[k]:Hide() end
			b:SetHeight(6 + 12 + 4 + h + 8 + extra)
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
			b.text = text
			b.copyBtn:SetShown(text ~= nil and text ~= "")
			b:Show()
			y = y + b:GetHeight() + 6
		end
		local last = #c.history
		-- No AI text on screen while the lockout is on (backlog 79): a window opened
		-- by hand mid-fight shows this one line; Forever_Calm re-renders when it ends.
		if WoWAIForever and WoWAIForever.Locked and WoWAIForever.Locked() then
			Place("system", "Replies are hidden during combat", "", true)
		else
			for i, m in ipairs(c.history) do
				-- The Allow button only makes sense on the newest reply, and only while idle.
				local denied = (i == last and not c.pendingId and type(m.denied) == "table" and #m.denied > 0) and m.denied or nil
				local follow = i == last and not c.pendingId and m.role == "assistant" and not denied and m.followUps or nil
				Place(m.role, m.text, m.t and date("%H:%M", m.t) or "", false, denied, m.agent, nil, follow)
			end
			if c.pendingId then
				local p = c.progress
				-- No timer or status text here: the bubble is drawn once, goes stale next to the
				-- live status line, and its text read as part of the AI's own message.
				local head = "working..."
				Place("assistant", (p and p ~= "") and (head .. "\n\n" .. p) or head, "", true, nil, ChatAgent(c))
			elseif #c.history == 0 then
				if run.restoring then
					Place("system", "Connecting to the bridge and restoring your chats...", "", true)
				elseif not WoWAI.IsConnected() then
					Place("system", "Not connected to the bridge. Start it (npm start in the wow-ai folder, or wow-ai in your project), then click Connect below.", "", true)
				else
					Place("system", "Click the box below and type to start. Shift-click an item, spell or quest to link it into your message. /wow-ai help lists the commands; /ai <text> and /r work from the game chat too.\n\nOr click a question to put it in the box:", "", true, nil, nil, WoWAI.StarterList(c))
				end
			end
		end
		for i = n + 1, #ui.bubbles do
			ui.bubbles[i]:Hide()
		end
		ui.content:SetHeight(math.max(y, 1))
		-- The decision is parked on ui so renders queued close together settle it
		-- once, and a stale timer can't pull a player who scrolled up to the bottom.
		ui.scrollWantBottom = ui.scrollWantBottom or stick
		C_Timer.After(0.05, function()
			if ui.scroll then
				local range = ui.scroll:GetVerticalScrollRange()
				local toBottom = ui.scrollWantBottom
				ui.scrollWantBottom = nil
				ui.scroll:SetVerticalScroll(toBottom and range or math.min(ui.scroll:GetVerticalScroll(), range))
			end
		end)
	end
	WoWAI.UpdateStatus()
	WoWAI.RenderChatList()
end

-- Copy box (/wow-ai copy): a selectable EditBox with the last reply pre-highlighted for Ctrl+C.
function WoWAI.ShowCopy(text)
	if WoWAIForever and WoWAIForever.Locked and WoWAIForever.Locked() then return end
	if not ui.copy then
		local cf = CreateFrame("Frame", "WoWAICopy", UIParent, "BackdropTemplate")
		cf:SetSize(560, 320)
		cf:SetPoint("CENTER")
		cf:SetFrameStrata("FULLSCREEN_DIALOG")
		cf:SetMovable(true)
		cf:SetClampedToScreen(true)
		cf:EnableMouse(true)
		cf:RegisterForDrag("LeftButton")
		cf:SetScript("OnDragStart", cf.StartMoving)
		cf:SetScript("OnDragStop", cf.StopMovingOrSizing)
		cf:SetBackdrop(BACKDROP)
		cf:SetBackdropColor(0.03, 0.03, 0.05, 1)
		cf:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
		-- The tooltip backdrop texture is see-through whatever its colour: a solid
		-- fill keeps the reply underneath from showing through the selected text.
		local fill = cf:CreateTexture("WoWAICopyFill", "BACKGROUND")
		fill:SetPoint("TOPLEFT", cf, "TOPLEFT", 4, -4)
		fill:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -4, 4)
		fill:SetColorTexture(0.05, 0.05, 0.07, 1)
		tinsert(UISpecialFrames, "WoWAICopy")

		local t = cf:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		t:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -12)
		t:SetText("Text is selected - press Ctrl+C, then Esc")

		local x = CreateFrame("Button", nil, cf, "UIPanelCloseButton")
		x:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -4, -4)

		local sc = CreateFrame("ScrollFrame", "WoWAICopyScroll", cf, "UIPanelScrollFrameTemplate")
		sc:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -36)
		sc:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -32, 14)
		local eb = CreateFrame("EditBox", "WoWAICopyBox", sc)
		eb:SetMultiLine(true)
		eb:SetAutoFocus(false)
		eb:SetFontObject(ChatFontNormal)
		eb:SetMaxLetters(0)
		eb:SetSize(500, 260)
		eb:SetScript("OnEscapePressed", function() cf:Hide() end)
		sc:SetScrollChild(eb)
		sc:HookScript("OnSizeChanged", function(self, w) eb:SetWidth(w) end)
		ui.copy, ui.copyBox = cf, eb
		if WoWAIForever and WoWAIForever.Fire then WoWAIForever.Fire("COPY_BUILT", cf) end
	end
	ui.copyBox:SetText(text)
	ui.copy:Show()
	ui.copyBox:SetFocus()
	ui.copyBox:HighlightText()
end

-- Rows start 36px below the panel top (New chat button and gap), 21px apart,
-- and the last must end above the panel's bottom edge.
local CHAT_ROW_TOP, CHAT_ROW_STEP = 36, 21

local function ChatRowsFit()
	local h = ui.chatPanel and ui.chatPanel:GetHeight() or 0
	local n = math.floor((h - 4 - CHAT_ROW_TOP - 20) / CHAT_ROW_STEP) + 1
	return math.max(1, math.min(MAX_CHATS, n))
end

function WoWAI.RenderChatList()
	if not ui.chatButtons then return end
	local fit = ChatRowsFit()
	local total = #db.chats
	local offset = ui.chatOffset or 0
	-- When the active chat changes, bring it into view; otherwise leave the
	-- player's wheel position alone.
	if ui.chatSeenActive ~= db.activeChat then
		ui.chatSeenActive = db.activeChat
		for i, c in ipairs(db.chats) do
			if c.id == db.activeChat then
				if i <= offset then offset = i - 1 elseif i > offset + fit then offset = i - fit end
				break
			end
		end
	end
	offset = math.max(0, math.min(offset, total - fit))
	ui.chatOffset = offset
	for i, btn in ipairs(ui.chatButtons) do
		local c = i <= fit and db.chats[offset + i] or nil
		if c then
			local label = Display(c.name)
			local folder = FolderName(ChatFolder(c))
			if folder ~= "" and folder:lower() ~= c.name:lower() then
				label = label .. " |cff888888" .. Display(folder) .. "|r"
			end
			if c.agent and c.agent ~= "" then
				label = label .. " |cff888888" .. PoolName(c.agent, ChatModel(c)) .. "|r"
			end
			if c.pendingId then
				label = label .. " |cffffd100...|r"
			elseif (c.unread or 0) > 0 then
				label = label .. " |cff55ff55(" .. c.unread .. ")|r"
			end
			btn.label:SetText(label)
			btn.chatId = c.id
			btn.selected:SetShown(c.id == db.activeChat)
			btn:Show()
		else
			btn:Hide()
		end
	end
end

function WoWAI.UpdateMini()
	if not ui.miniBadge then return end
	local unread, working = 0, 0
	for _, c in ipairs(db.chats) do
		unread = unread + (c.unread or 0)
		if c.pendingId then working = working + 1 end
	end
	local t
	if working > 0 and unread > 0 then
		t = "|cff55ff55" .. unread .. " new|r |cffffd100" .. working .. " working|r"
	elseif working > 0 then
		t = "|cffffd100" .. (working == 1 and "working..." or (working .. " working...")) .. "|r"
	elseif unread > 0 then
		t = "|cff55ff55" .. unread .. (unread == 1 and " new reply" or " new replies") .. "|r"
	else
		t = "|cff999999idle|r"
	end
	-- Set by Forever_CombatLog.lua when a fight ends with the log off. It wins over
	-- the reply count until the log is on: the next pull is the one still to save.
	if WoWAI.unloggedFight and type(LoggingCombat) == "function" and not LoggingCombat() then
		t = "|cffff8040This fight wasn't logged|r"
	end
	ui.miniBadge:SetText(t)
	if ui.miniPulse then
		if unread > 0 then
			if not ui.miniPulse:IsPlaying() then ui.miniPulse:Play() end
		else
			ui.miniPulse:Stop()
			ui.miniBadge:SetAlpha(1)
		end
	end
end

local ECHO_DEFAULT = 4000 -- characters of a reply to print into the game chat ("/wow-ai echo <n>")

local function ChatLinks(chat)
	return "  |Hwowai:reply:" .. chat.id .. "|h|cff55ff55[reply]|r|h |Hwowai:open:" .. chat.id .. "|h|cff7ec8ff[open]|r|h"
end

local SUMMARY_LINES = 3 -- lines of the agent's TL;DR block printed in "summary" mode
local SUMMARY_FALLBACK_LINES = 2 -- lines of the reply shown when it came without one

-- Print a reply into the game chat: prefix on the first line, then the text line
-- by line up to the limit, then clickable links. `short` prints one preview line.
-- `summary` (the default) prints the TL;DR block the bridge split off the reply,
-- or the first lines of the reply when the agent didn't write one; the full text
-- is in the window, behind [open].
local function EchoToChat(chat, text, agent, summary)
	local mode = db.settings.echo
	if mode == "off" then return end
	local prefix = "|cff7ec8ff[" .. ReplyAgentName(chat, agent) .. " · " .. Display(chat.name) .. "]|r "
	local body = Display(text)
	if mode == "short" then
		local flat = (body:gsub("%s+", " "))
		if #flat > 200 then flat = flat:sub(1, 200) .. " ..." end
		print(prefix .. flat .. ChatLinks(chat))
		return
	end
	if mode == "summary" then
		local source, max = Display(summary or ""), SUMMARY_LINES
		if not source:match("%S") then source, max = body, SUMMARY_FALLBACK_LINES end
		local lines, total = {}, 0
		for line in (source .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				total = total + 1
				if total <= max then table.insert(lines, line) end
			end
		end
		for i, line in ipairs(lines) do
			print((i == 1 and prefix or "    ") .. line)
		end
		if total > max then
			print("    |cff888888... click [open] to read it all|r")
		end
		print("    " .. ChatLinks(chat):sub(3))
		return
	end
	local limit = tonumber(mode) or ECHO_DEFAULT
	local first, shown = true, 0
	for line in (body .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			if shown + #line > limit then
				print("    |cff888888... " .. (#body - shown) .. " more characters, click [open] to read it all|r")
				break
			end
			print((first and prefix or "    ") .. line)
			first = false
			shown = shown + #line
		end
	end
	print("    " .. ChatLinks(chat):sub(3))
end

-- A reply landed. Always play the sound; if that chat isn't on screen, also echo
-- it to the game chat, flash the screen text and light up the mini bar.
function WoWAI.Notify(chat, text, agent, summary)
	pcall(PlaySound, 3081)
	WoWAI.UpdateMini()
	if ui.frame and ui.frame:IsShown() and db.activeChat == chat.id then return end
	EchoToChat(chat, text, agent, summary)
	if UIErrorsFrame then
		UIErrorsFrame:AddMessage(ReplyAgentName(chat, agent) .. " replied in " .. Display(chat.name), 0.5, 0.8, 1, 1)
	end
end

-- Opens the window on a chat with a ready question in the box. Nothing is sent;
-- the player presses Enter.
function WoWAI.AskInBox(chatId, text)
	if not db then return end
	if FindChat(chatId) then WoWAI.SwitchChat(chatId) end
	WoWAI.Toggle(true)
	if ui.input and text then
		ui.input:SetText(text)
		ui.input:SetFocus()
	end
end

-- Clicks on our [reply] / [open] / [turn on combat log] links in the chat frame.
hooksecurefunc("SetItemRef", function(link)
	if link == "wowai:combatlog" then return WoWAI.CombatLogLinkClicked() end
	local action, chatId = tostring(link):match("^wowai:(%a+):(%w+)")
	if not action or not db then return end
	if FindChat(chatId) then WoWAI.SwitchChat(chatId) end
	WoWAI.Toggle(true)
	if action == "reply" and ui.input then ui.input:SetFocus() end
	-- [ask] links (the level-up nudge) put a ready question in the box; Enter sends it.
	if action == "ask" and ui.input and WoWAI.askText then
		ui.input:SetText(WoWAI.askText)
		ui.input:SetFocus()
	end
end)

-- Shift-clicking an item, spell, quest or name puts its link into the chat box
-- being typed in. Blizzard's insert function only knows its own boxes, so when
-- ours has the keyboard, take the link too. With no box focused the shift-click
-- keeps its normal meaning (splitting a stack, for one).
--
-- On this client (modern UI code, Blizzard_ChatFrameUtil) every shift-click
-- ends in ChatFrameUtil.InsertLink; ChatEdit_InsertLink is the older global
-- name, hooked only where the new one is missing so one click inserts once.
local function TakeLink(text)
	if text and text ~= "" and ui.input and ui.input:HasFocus() then
		ui.input:Insert(text)
	end
end
if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.InsertLink) == "function" then
	hooksecurefunc(ChatFrameUtil, "InsertLink", TakeLink)
elseif type(ChatEdit_InsertLink) == "function" then
	hooksecurefunc("ChatEdit_InsertLink", TakeLink)
end

---------------------------------------------------------------------------
-- UI
---------------------------------------------------------------------------

local function MakeButton(parent, label, width, onClick)
	local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local PANEL_W = 150

local function BuildUI()
	if ui.frame then return end
	local s = db.settings

	local f = CreateFrame("Frame", "WoWAIFrame", UIParent, "BackdropTemplate")
	ui.frame = f
	f:HookScript("OnMouseDown", WindowUsed)
	f:SetSize(s.width, s.height)
	if s.point then
		f:SetPoint(s.point, UIParent, s.relPoint or s.point, s.x or 0, s.y or 0)
	else
		-- Top centre: clear of the game chat (bottom left) and the quest tracker (right).
		f:SetPoint("TOP", UIParent, "TOP", 0, -40)
	end
	f:SetFrameStrata("DIALOG")
	f:SetMovable(true)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(560, 300)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.point, s.relPoint, s.x, s.y = point, relPoint, x, y
	end)
	f:SetBackdrop(BACKDROP)
	f:SetBackdropColor(0.03, 0.03, 0.05, 1)
	f:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	f:Hide()
	tinsert(UISpecialFrames, "WoWAIFrame")

	-- Status light: green = bridge seen recently, yellow = stale, red = gone.
	local function MakeDot(parent)
		local holder = CreateFrame("Frame", nil, parent)
		holder:SetSize(16, 16)
		local dot = holder:CreateTexture(nil, "OVERLAY")
		dot:SetAllPoints()
		dot:SetTexture("Interface\\FriendsFrame\\StatusIcon-Offline")
		holder:EnableMouse(true)
		holder:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(dot.tip or "Bridge status", 0.9, 0.9, 0.9, 1, true)
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end

	local dotHolder, dot = MakeDot(f)
	dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -16)
	ui.dot = dot

	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	title:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0)
	-- Stop short of the minimize button: a long chat name is cut, not drawn over the border.
	title:SetPoint("RIGHT", f, "TOPRIGHT", -60, -24)
	title:SetJustifyH("LEFT")
	title:SetWordWrap(false)
	title:SetText("WoW AI")
	ui.title = title

	local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -34)
	status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	status:SetJustifyH("LEFT")
	ui.status = status

	-- Stalled run (backlog 52): both are the player's own click.
	local askBtn = MakeButton(f, "Ask Claude instead", 144, function() WoWAI.AskClaude() end)
	askBtn:SetPoint("TOPRIGHT", f, "TOPRIGHT", -34, -28)
	askBtn:Hide()
	ui.askBtn = askBtn
	local stopBtn = MakeButton(f, "Stop", 54, function() WoWAI.StopRun() end)
	stopBtn:SetPoint("RIGHT", askBtn, "LEFT", -4, 0)
	stopBtn:Hide()
	ui.stopBtn = stopBtn

	-- Minimize button in the corner where a close X would be: this window is never
	-- closed from here, only collapsed to the mini bar (Esc does the same, see OnHide).
	-- The mini bar's own X is the one that hides everything.
	local mini
	if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("RedButton-MiniCondense") then
		-- Blizzard's own minimize button: the close button's chrome with a "condense" glyph.
		local ok, b = pcall(CreateFrame, "Button", nil, f, "UIPanelHideButtonNoScripts")
		if ok and b then mini = b end
	end
	if not mini then
		-- Older art: draw a dash on a plain button.
		mini = CreateFrame("Button", nil, f)
		mini:SetSize(24, 24)
		local dash = mini:CreateTexture(nil, "ARTWORK")
		dash:SetSize(10, 2)
		dash:SetPoint("CENTER", mini, "CENTER", 0, -3)
		dash:SetColorTexture(0.9, 0.9, 0.9, 1)
		local hl = mini:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.15)
	end
	mini:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
	mini:SetScript("OnClick", function() WoWAI.Minimize(true) end)
	mini:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Minimize to the small bar  (Esc)")
		GameTooltip:AddLine("The agent keeps working; the bar shows when a reply lands.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	mini:SetScript("OnLeave", function() GameTooltip:Hide() end)

	-- Esc (via UISpecialFrames) just calls Hide(); treat that as a minimize unless
	-- we're hiding on purpose. Ignore hides caused by the whole UI going away.
	f:SetScript("OnHide", function()
		if ui.quitting then
			ui.quitting = nil
			return
		end
		if not db or not db.settings.shown or not UIParent:IsShown() then return end
		db.settings.minimized = true
		if ui.mini then ui.mini:Show() end
		WoWAI.UpdateMini()
	end)

	-- Left panel: chat list
	local panel = CreateFrame("Frame", "WoWAIChatPanel", f, "BackdropTemplate")
	ui.chatPanel = panel
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -52)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 50)
	panel:SetWidth(PANEL_W)
	panel:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	panel:SetBackdropColor(0, 0, 0, 0.4)
	panel:SetBackdropBorderColor(0.4, 0.4, 0.4, 1)

	local newBtn = MakeButton(panel, "+ New chat", PANEL_W - 16, function() WoWAI.NewChat() end)
	newBtn:SetPoint("TOP", panel, "TOP", 0, -8)

	-- Per-chat menu: Rename, Folder and Agent, opened by right-clicking a chat
	-- row. A plain frame of our own rather than a Blizzard dropdown, so it looks
	-- the same on every client.
	local menu = CreateFrame("Frame", "WoWAIChatMenu", f, "BackdropTemplate")
	menu:SetSize(110, 4 * 20 + 12)
	menu:SetFrameStrata("TOOLTIP")
	menu:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	menu:SetBackdropColor(0.08, 0.08, 0.1, 1)
	menu:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	menu:EnableMouse(true)
	menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
	menu.title:SetPoint("RIGHT", menu, "RIGHT", -8, 0)
	menu.title:SetJustifyH("LEFT")
	menu.title:SetWordWrap(false)
	local function MenuItem(label, order, onClick)
		local it = CreateFrame("Button", nil, menu)
		it:SetSize(110 - 12, 20)
		it:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -6 - order * 20)
		local hl = it:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		it.label = it:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		it.label:SetPoint("LEFT", it, "LEFT", 6, 0)
		it.label:SetText(label)
		it:SetScript("OnClick", function()
			menu:Hide()
			onClick(menu.chatId, menu.owner)
		end)
		return it
	end
	MenuItem("Rename...", 1, WoWAI.RenamePrompt)
	MenuItem("Folder...", 2, WoWAI.FolderPrompt)
	MenuItem("AI / model...", 3, WoWAI.AgentPrompt)
	-- Close once the mouse has wandered away from the menu and the row it came from.
	menu:SetScript("OnUpdate", function(self, dt)
		if not MouseIsOver then return end
		if MouseIsOver(self) or (self.owner and MouseIsOver(self.owner)) then
			self.away = 0
		else
			self.away = (self.away or 0) + dt
			if self.away > 0.5 then self:Hide() end
		end
	end)
	menu:Hide()
	ui.chatMenu = menu

	-- AI picker: the agents installed on the bridge PC and their models, one
	-- click to switch the chat. Opened from the AI button under the chat or the
	-- chat row's menu. Same plain frame as the chat menu.
	local picker = CreateFrame("Frame", "WoWAIPoolPicker", f, "BackdropTemplate")
	picker:SetFrameStrata("TOOLTIP")
	picker:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	picker:SetBackdropColor(0.08, 0.08, 0.1, 1)
	picker:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	picker:EnableMouse(true)
	picker.title = picker:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	picker.title:SetPoint("TOPLEFT", picker, "TOPLEFT", 10, -8)
	picker.title:SetJustifyH("LEFT")
	picker.rows = {}
	local PICK_W, PICK_ROW, PICK_MAX = 210, 18, 24
	local function PickerRow(i)
		local it = picker.rows[i]
		if it then return it end
		it = CreateFrame("Button", nil, picker)
		it:SetSize(PICK_W - 12, PICK_ROW)
		it:SetPoint("TOPLEFT", picker, "TOPLEFT", 6, -24 - (i - 1) * PICK_ROW)
		local hl = it:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		it.label = it:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		it.label:SetPoint("LEFT", it, "LEFT", 6, 0)
		it.label:SetJustifyH("LEFT")
		it:SetScript("OnClick", function(self)
			picker:Hide()
			WoWAI.SetPool(FindChat(picker.chatId), self.agent, self.model)
		end)
		picker.rows[i] = it
		return it
	end
	picker:SetScript("OnUpdate", menu:GetScript("OnUpdate"))
	picker:Hide()
	ui.picker = picker

	function WoWAI.ShowPicker(chatId, anchor)
		local c = FindChat(chatId)
		if not c then return end
		if picker:IsShown() and picker.chatId == chatId then
			picker:Hide()
			return
		end
		local choices = WoWAI.PoolChoices()
		local n = math.min(#choices, PICK_MAX)
		for i = 1, n do
			local ch, it = choices[i], PickerRow(i)
			local current = ch.agent == (c.agent or "") and ch.model == ChatModel(c)
			it.agent, it.model = ch.agent, ch.model
			it.label:SetText((current and "|cff55ff55> " or "|cffffffff  ") .. Display(ch.label) .. "|r")
			it:Show()
		end
		for i = n + 1, #picker.rows do picker.rows[i]:Hide() end
		picker.title:SetText(run.bridgeAgents and ("AI for " .. Display(c.name)) or "AI for this chat (connect to see what this PC has)")
		picker:SetSize(PICK_W, 30 + n * PICK_ROW)
		picker.chatId = chatId
		picker.owner = anchor
		picker.away = 0
		picker:ClearAllPoints()
		if anchor and anchor ~= ui.pool then
			picker:SetPoint("TOPLEFT", anchor, "TOPRIGHT", 4, 0)
		else
			picker:SetPoint("BOTTOMLEFT", ui.pool or f, "TOPLEFT", 0, 4)
		end
		picker:Show()
	end

	function WoWAI.ShowChatMenu(chatId, anchor)
		local c = FindChat(chatId)
		if not c then return end
		if menu:IsShown() and menu.chatId == chatId then
			menu:Hide()
			return
		end
		menu.chatId = chatId
		menu.owner = anchor
		menu.away = 0
		menu.title:SetText(Display(c.name))
		menu:ClearAllPoints()
		menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 8, 2)
		menu:Show()
	end

	-- The list shows only the rows that fit the panel (see RenderChatList); the
	-- wheel moves the window over the chats, and a resize re-fits it.
	ui.chatOffset = 0
	panel:EnableMouseWheel(true)
	panel:SetScript("OnMouseWheel", function(_, delta)
		ui.chatOffset = (ui.chatOffset or 0) - (delta > 0 and 1 or -1)
		WoWAI.RenderChatList()
	end)
	panel:HookScript("OnSizeChanged", function()
		ui.chatSeenActive = nil -- re-fit around the active chat
		WoWAI.RenderChatList()
	end)

	ui.chatButtons = {}
	for i = 1, MAX_CHATS do
		local b = CreateFrame("Button", nil, panel)
		b:SetSize(PANEL_W - 16, 20)
		b:SetPoint("TOP", newBtn, "BOTTOM", 0, -6 - (i - 1) * 21)
		b.selected = b:CreateTexture(nil, "BACKGROUND")
		b.selected:SetAllPoints()
		b.selected:SetColorTexture(1, 1, 1, 0.12)
		b.selected:Hide()
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.08)

		-- Trash can: delete this chat (asks first). Blizzard's red delete button
		-- where the client has it, a plain X elsewhere.
		b.del = CreateFrame("Button", nil, b)
		b.del:SetSize(16, 16)
		b.del:SetPoint("RIGHT", b, "RIGHT", -2, 0)
		if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("128-RedButton-Delete") then
			b.del:SetNormalAtlas("128-RedButton-Delete")
			b.del:SetPushedAtlas("128-RedButton-Delete-Pressed")
			b.del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
		else
			b.del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
			b.del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
		end
		b.del:SetAlpha(0.6)
		b.del:SetScript("OnClick", function() WoWAI.ConfirmDelete(b.chatId) end)
		b.del:SetScript("OnEnter", function(self)
			self:SetAlpha(1)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText("Delete this chat")
			GameTooltip:Show()
		end)
		b.del:SetScript("OnLeave", function(self)
			self:SetAlpha(0.6)
			GameTooltip:Hide()
		end)

		b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		b.label:SetPoint("LEFT", b, "LEFT", 6, 0)
		b.label:SetPoint("RIGHT", b.del, "LEFT", -4, 0)
		b.label:SetJustifyH("LEFT")
		b.label:SetWordWrap(false)
		-- Left-click switches to the chat; right-click opens its menu (Rename,
		-- Folder, Agent). A second right-click on the same row closes the menu again.
		b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		b:SetScript("OnClick", function(self, button)
			if button == "RightButton" then
				WoWAI.ShowChatMenu(self.chatId, self)
			else
				WoWAI.SwitchChat(self.chatId)
			end
		end)
		b:SetScript("OnDoubleClick", function(self)
			WoWAI.SwitchChat(self.chatId)
			WoWAI.RenamePrompt(self.chatId)
		end)
		b:Hide()
		ui.chatButtons[i] = b
		if WoWAIForever and WoWAIForever.Fire then WoWAIForever.Fire("CHAT_ROW_BUILT", b) end
	end

	-- Transcript: a scrolling stack of message bubbles
	local scroll = CreateFrame("ScrollFrame", "WoWAIScroll", f, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", panel, "TOPRIGHT", 8, 0)
	scroll:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -32, 110)
	ui.scroll = scroll

	local content = CreateFrame("Frame", "WoWAIContent", scroll)
	content:SetSize(500, 1)
	scroll:SetScrollChild(content)
	ui.content = content
	ui.bubbles = {}
	-- Remember whether the player sits at the bottom (the new-message default).
	scroll:HookScript("OnVerticalScroll", function(self, offset)
		ui.scrollStick = self:GetVerticalScrollRange() - (offset or 0) <= 4
	end)
	scroll:HookScript("OnSizeChanged", function(self, w, h)
		if ui.frame:IsShown() then WoWAI.Render() end
	end)

	-- Input box, with Send docked at its right end like a messaging app.
	local SEND_W = 84
	local inputBg = CreateFrame("Frame", nil, f, "BackdropTemplate")
	inputBg:SetPoint("BOTTOMLEFT", panel, "BOTTOMRIGHT", 8, 0)
	inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -14 - SEND_W - 6, 50)
	inputBg:SetHeight(54)
	inputBg:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	inputBg:SetBackdropColor(0, 0, 0, 0.6)
	inputBg:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)

	local inScroll = CreateFrame("ScrollFrame", "WoWAIInputScroll", inputBg, "UIPanelScrollFrameTemplate")
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 8, -6)
	inScroll:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -24, 6)

	local input = CreateFrame("EditBox", "WoWAIInput", inScroll)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(500, 40)
	input:SetScript("OnEnterPressed", function() WoWAI.SendFromInput() end)
	input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	input:HookScript("OnTextChanged", function(self, userInput) if userInput then WindowUsed() end end)
	input:HookScript("OnEditFocusGained", WindowUsed)
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(self, w, h)
		input:SetWidth(w)
	end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input

	-- Send sits to the right of the input box, vertically centred on it.
	local send = MakeButton(f, "Send", SEND_W, WoWAI.SendFromInput)
	send:SetHeight(30)
	send:SetPoint("LEFT", inputBg, "RIGHT", 6, 0)
	ui.send = send

	-- Connect stands in for Send until the bridge has been seen (see UpdateConnect).
	local connect = MakeButton(f, "Connect", SEND_W, WoWAI.Connect)
	connect:SetHeight(30)
	connect:SetPoint("LEFT", inputBg, "RIGHT", 6, 0)
	connect:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Connect to the bridge")
		GameTooltip:AddLine("The bridge must be running on this PC (npm start in wow-ai, or wow-ai in your project). The light turns green once it answers.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	connect:SetScript("OnLeave", function() GameTooltip:Hide() end)
	connect:Hide()
	ui.connect = connect

	-- Reload is the fallback transport's button; it only shows when a reload
	-- would do something (see UpdateStatus), in Resend's place on the bottom row.
	local refresh = MakeButton(f, "Reload", 70, function() SafeReload() end)
	refresh:Hide()
	ui.refresh = refresh

	-- Bottom row: Clear, plus Resend while a message is in flight. Rename, Folder
	-- and Delete live on each chat row in the left panel.
	-- Two clicks: the first arms the button ("Sure?") for a few seconds, the
	-- second wipes the chat it was armed for.
	local clear
	local armed
	clear = MakeButton(f, "Clear", 60, function()
		local c = ActiveChat()
		if armed and c and armed == c.id then
			armed, clear.armToken = nil, nil
			clear:SetText("Clear")
			wipe(c.history)
			WoWAI.Render()
		elseif c then
			local token = {}
			armed = c.id
			clear.armToken = token
			clear:SetText("Sure?")
			C_Timer.After(3, function()
				if clear.armToken == token then
					armed = nil
					clear:SetText("Clear")
				end
			end)
		end
	end)
	clear:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 26)
	clear:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Clear this chat")
		GameTooltip:AddLine("Erases this chat's messages from the window. Click twice to confirm.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	clear:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.clear = clear

	-- The chat's AI and model; a click opens the picker above it.
	local pool = CreateFrame("Button", "WoWAIPoolButton", f, "UIPanelButtonTemplate")
	pool:SetSize(150, 22)
	pool:SetText("AI")
	pool:SetScript("OnClick", function(self) WoWAI.AgentPrompt(nil, self) end)
	pool:SetPoint("LEFT", clear, "RIGHT", 6, 0)
	pool:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Switch AI")
		GameTooltip:AddLine("Pick which AI and model answers this chat, from the ones installed on your PC. A different AI starts a fresh conversation; a different model of the same AI carries on.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	pool:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.pool = pool

	-- Same as typing /ai review: the command attaches the last fight's start and
	-- end times, which a plain "review my fight" message does not carry.
	local review = MakeButton(f, "Review last fight", 112, function() SlashCmdList["WOWAI"]("review") end)
	review:SetPoint("LEFT", pool, "RIGHT", 6, 0)
	review:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Review last fight")
		GameTooltip:AddLine("Asks the mentor to review your last fight from the combat log (same as /ai review). Out of combat only; the combat log must be on.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	review:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.review = review

	-- Same as typing /ai death: the command attaches the recent deaths.
	local death = MakeButton(f, "Why did I die?", 100, function() SlashCmdList["WOWAI"]("death") end)
	death:SetPoint("LEFT", review, "RIGHT", 6, 0)
	death:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Why did I die?")
		GameTooltip:AddLine("Asks the mentor about your last death (same as /ai death). Out of combat only.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	death:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.death = death

	-- Shows whether the game is writing the combat log and switches it on or off.
	local logBtn = MakeButton(f, "Combat log: ?", 130, function()
		if type(LoggingCombat) == "function" then WoWAI.SetCombatLog(not LoggingCombat()) end
	end)
	logBtn:SetPoint("LEFT", death, "RIGHT", 6, 0)
	logBtn:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Combat log")
		GameTooltip:AddLine("Reviews read the game's combat log, which must be on during the fight. Click to switch it on or off (out of combat only).", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	logBtn:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.logBtn = logBtn

	local resend = MakeButton(f, "Resend", 70, WoWAI.Resend)
	resend:SetPoint("LEFT", logBtn, "RIGHT", 6, 0)
	resend:Hide()
	ui.resend = resend
	-- Same place as Resend; UpdateStatus never shows both (backlog 82).
	refresh:SetPoint("LEFT", logBtn, "RIGHT", 6, 0)

	-- A named, always-present button so a keybinding can click it (see /wow-ai bind).
	local hotkey = CreateFrame("Button", "WoWAIRefreshButton", UIParent)
	hotkey:SetSize(1, 1)
	hotkey:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -10, 10)
	local function RefreshAction()
		local c = ActiveChat()
		if c and c.pendingId then
			WoWAI.Send("")
		else
			WoWAI.Toggle()
		end
	end
	hotkey:SetScript("OnClick", RefreshAction)
	WoWAI.refreshAction = RefreshAction

	local cwd = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	-- Sits above the frame border, not on it: the default skin's dialog border
	-- takes the bottom 11 px (the plain one 4).
	cwd:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 16, 13)
	cwd:SetPoint("RIGHT", f, "RIGHT", -30, 0)
	cwd:SetJustifyH("LEFT")
	cwd:SetWordWrap(false)
	ui.cwd = cwd

	-- Resize grip
	local grip = CreateFrame("Button", nil, f)
	grip:SetSize(16, 16)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -5, 5)
	grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
	grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
	grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
	grip:SetScript("OnMouseDown", function() f:StartSizing("BOTTOMRIGHT") end)
	grip:SetScript("OnMouseUp", function()
		f:StopMovingOrSizing()
		s.width, s.height = f:GetSize()
	end)

	-- Mini bar: what the window collapses into. Click it to expand, drag to move.
	local m = CreateFrame("Frame", "WoWAIMini", UIParent, "BackdropTemplate")
	ui.mini = m
	m:SetSize(250, 30)
	if s.miniPoint then
		m:SetPoint(s.miniPoint, UIParent, s.miniRelPoint or s.miniPoint, s.miniX or 0, s.miniY or 0)
	else
		m:SetPoint("TOP", UIParent, "TOP", 0, -40)
	end
	m:SetFrameStrata("DIALOG")
	m:SetMovable(true)
	m:SetClampedToScreen(true)
	m:EnableMouse(true)
	m:RegisterForDrag("LeftButton")
	m:SetScript("OnDragStart", function(self)
		self.dragging = true
		self:StartMoving()
	end)
	m:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = point, relPoint, x, y
		C_Timer.After(0, function() self.dragging = nil end)
	end)
	m:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and not self.dragging then
			WoWAI.Minimize(false)
		end
	end)
	m:SetBackdrop(BACKDROP)
	m:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
	m:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	m:Hide()

	local miniDotHolder, miniDot = MakeDot(m)
	miniDotHolder:SetPoint("LEFT", m, "LEFT", 9, 0)
	ui.miniDot = miniDot

	local mlabel = m:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	mlabel:SetPoint("LEFT", miniDotHolder, "RIGHT", 6, 0)
	mlabel:SetText("WoW AI")

	local badge = m:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	badge:SetPoint("LEFT", mlabel, "RIGHT", 8, 0)
	badge:SetPoint("RIGHT", m, "RIGHT", -26, 0)
	badge:SetJustifyH("LEFT")
	badge:SetWordWrap(false)
	ui.miniBadge = badge

	local ok, pulse = pcall(function()
		local g = badge:CreateAnimationGroup()
		local a1 = g:CreateAnimation("Alpha")
		a1:SetFromAlpha(1)
		a1:SetToAlpha(0.25)
		a1:SetDuration(0.6)
		a1:SetOrder(1)
		local a2 = g:CreateAnimation("Alpha")
		a2:SetFromAlpha(0.25)
		a2:SetToAlpha(1)
		a2:SetDuration(0.6)
		a2:SetOrder(2)
		g:SetLooping("REPEAT")
		return g
	end)
	if ok then ui.miniPulse = pulse end

	local mclose = CreateFrame("Button", nil, m, "UIPanelCloseButton")
	mclose:SetSize(24, 24)
	mclose:SetPoint("RIGHT", m, "RIGHT", -2, 0)
	mclose:SetScript("OnClick", function() WoWAI.Toggle(false) end)
	mclose:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Quit: hide completely (/wow-ai brings it back)")
		GameTooltip:Show()
	end)
	mclose:SetScript("OnLeave", function() GameTooltip:Hide() end)
	if WoWAIForever and WoWAIForever.Fire then
		WoWAIForever.Fire("UI_BUILT", { frame = f, title = title, status = status, panel = panel,
			menu = menu, scroll = scroll, inputBg = inputBg, input = input, cwd = cwd, grip = grip,
			mini = m, chatButtons = ui.chatButtons })
	end
end

-- The only place the addon switches the combat log, and only from the player's
-- click: the Combat log button and the [turn on combat log] chat link. LoggingCombat
-- is not a protected function, but it never runs in combat or by itself.
function WoWAI.SetCombatLog(on)
	if InCombatLockdown() or type(LoggingCombat) ~= "function" then return false end
	LoggingCombat(on)
	WoWAI.WatchCombatLog(true)
	if on then WoWAI.unloggedFight = false end
	WoWAI.UpdateLogButton()
	WoWAI.UpdateMini()
	return true
end

-- Combat log watch (backlog 83): the button once read "off" for a moment with no
-- click. Each change of LoggingCombat() is kept with its time (the last
-- LOG_CHANGES_KEPT, shown by /wow-ai diag), and a switch to off that was not the
-- player's click says so once in chat. Read-only: this only reads LoggingCombat().
-- Runs on the existing 2 s tick and on each button refresh, no polling of its own.
local LOG_CHANGES_KEPT = 10
local logWatch = { changes = {} }
function WoWAI.WatchCombatLog(clicked)
	if type(LoggingCombat) ~= "function" then return end
	local now = LoggingCombat() and true or false
	if logWatch.last == nil then logWatch.last = now return end
	if now == logWatch.last then return end
	logWatch.last = now
	local at = date("%H:%M:%S")
	table.insert(logWatch.changes, { at = at, on = now, clicked = clicked and true or false })
	while #logWatch.changes > LOG_CHANGES_KEPT do table.remove(logWatch.changes, 1) end
	if not now and not clicked then
		print("|cff7ec8ff[WoW AI]|r The combat log turned off at " .. at .. " without a click on the Combat log button. "
			.. "Something else switched it (another addon, a /combatlog command, or the game). /wow-ai diag lists each change.")
	end
end

-- One line per recorded change for /wow-ai diag, oldest first.
function WoWAI.CombatLogChanges()
	local out = {}
	for _, ch in ipairs(logWatch.changes) do
		out[#out + 1] = ch.at .. " " .. (ch.on and "on" or "off") .. (ch.clicked and " (your click)" or " (no click)")
	end
	return out
end

-- A click on [turn on combat log] (Forever_CombatLog.lua prints it).
function WoWAI.CombatLogLinkClicked()
	if InCombatLockdown() then
		print("|cff7ec8ff[WoW AI]|r The combat log can be switched on out of combat only.")
	elseif WoWAI.SetCombatLog(true) then
		print("|cff7ec8ff[WoW AI]|r Combat log on.")
	end
end

function WoWAI.UpdateLogButton()
	local b = ui.logBtn
	if not b then return end
	local known = type(LoggingCombat) == "function"
	WoWAI.WatchCombatLog()
	b:SetText("Combat log: " .. (known and (LoggingCombat() and "on" or "off") or "?"))
	if known and not InCombatLockdown() then b:Enable() else b:Disable() end
end

function WoWAI.Toggle(show)
	if not ui.frame then return end
	if show == nil then show = not ui.frame:IsShown() end
	if show then
		db.settings.minimized = false
		WindowUsed()
		local c = ActiveChat()
		if c then c.unread = 0 end
	end
	if ui.mini then ui.mini:Hide() end
	if not show then ui.quitting = true end
	ui.frame:SetShown(show)
	ui.quitting = nil
	db.settings.shown = show
	if show then
		WoWAI.Render()
		-- No auto-focus: the game keeps the keyboard until you click the box.
		-- No automatic hello either: if the bridge hasn't been seen, the panel
		-- shows Connect in place of Send and waits for a click.
	end
	WoWAI.UpdateMini()
end

function WoWAI.Minimize(mini)
	if not ui.frame then return end
	if mini == nil then mini = not db.settings.minimized end
	if mini then
		db.settings.minimized = true
		db.settings.shown = true
		ui.frame:Hide() -- OnHide shows the mini bar
		if ui.mini and not ui.mini:IsShown() then ui.mini:Show() end
		WoWAI.UpdateMini()
	else
		WoWAI.Toggle(true)
	end
end

---------------------------------------------------------------------------
-- Slash commands
---------------------------------------------------------------------------

local HELP = table.concat({
	"/wow-ai                        toggle the window (/ai, /wowai and the old /wow-claude are the same command)",
	"/wow-ai mini                   collapse to the small bar (click the bar to expand)",
	"/wow-ai hide                   hide the window completely",
	"/ai <text>                         send <text> to the current chat straight from the game chat box (/wow-ai <text> too). A message that starts with a command word is still sent when the rest of the line doesn't fit that command",
	"/r <text>                          replies to the agent when it was the last to message you (else normal whisper reply)",
	"/wow-ai echo summary|full|short|off|<chars>   how much of each reply to print in the game chat (summary = the agent's closing TL;DR lines)",
	"/wow-ai longchat on|off        let the game chat box take 4000 characters (for long /ai messages)",
	"/wow-ai new [name]             start a new chat (its own agent session, like a new terminal)",
	"/wow-ai chat <n|name>          switch chats (or click one in the left panel)",
	"/wow-ai rename [name]          rename the current chat (no name = dialog; right-clicking the chat in the left panel offers it too)",
	"/wow-ai delete                 delete the current chat",
	"/wow-ai cd <folder>            folder this chat's agent works in (relative to the bridge's folder; no folder = back to default). Right-clicking the chat in the left panel and picking Folder does the same",
	"/wow-ai agent [name [model]]   which AI (and model) this chat talks to (default = the bridge's). The AI button under the chat does the same with a click",
	"/wow-ai reset                  next message in this chat starts a fresh agent session",
	"/wow-ai context [on|off]       what the agent is told about your character and where you are (no argument = show it)",
	"/wow-ai guide [show|hide|next|prev|list|pick <n>]   the guide panel: current step and the next two of a guide the mentor wrote (no argument = show or hide it; hidden during fights)",
	"/wow-ai map [...]              map layers the agent drew, the route navigator and herb/ore nodes (no argument = status and subcommands; /aimap is the same)",
	"/wow-ai mode pixel             no-reload transport (default)",
	"/wow-ai mode reload            fallback transport: a /reload per step",
	"/wow-ai resend                 show the strip again if the bridge missed it",
	"/wow-ai reload                 reload now (also frees the slot pool)",
	"/wow-ai cancel                 stop waiting on this chat's reply",
	"/wow-ai copy                   open the last reply in a selectable box for Ctrl+C",
	"/wow-ai bind <key>             hotkey: checks for a reply while waiting, else toggles the window",
	"/wow-ai auto on|off            reload-mode only: auto-reload on your next keypress after the interval",
	"/wow-ai signal on|off          the cheap sound-file readiness check (off if it spams errors)",
	"/wow-ai slots                  how many reply slots are still free this session",
	"/wow-ai diag                   transport diagnostics (is the cheap sound-file channel working?)",
	"/wow-ai clear                  clear this chat's transcript",
}, "\n")

-- What each subcommand accepts, so that free text which happens to start with
-- one of these words ("delete the unused imports", "help me with this macro")
-- is sent as a message instead of run as a command. 0 = no arguments, 1 = at
-- most one word, a table = one of those words, a function decides, true = anything.
local function OnOffOrNumber(rest)
	return rest == "" or rest == "on" or rest == "off" or tonumber(rest) ~= nil
end

local function ChatArgument(rest)
	if rest == "" or tonumber(rest) or not rest:find("%s") then return true end
	for _, ch in ipairs(db.chats) do
		if ch.name:lower() == rest:lower() then return true end
	end
	return false
end

-- "/ai agent codex" or "/ai agent claude sonnet"; anything longer ("/ai agent
-- tell me ...") is a message.
local function AgentArgument(rest)
	local name, model = rest:match("^(%S*)%s*(.-)$")
	if model == "" then return true end
	if model:find("%s") then return false end
	return Contains(run.bridgeAgents or { "claude", "codex", "grok", "agy", "hermes" }, name:lower())
end

local COMMAND_ARGS = {
	mini = 0, min = 0, hide = 0, quit = 0, help = 0, clear = 0, delete = 0, reset = 0, copy = 0,
	cancel = 0, resend = 0, reload = 0, refresh = 0, slots = 0, diag = 0,
	context = { [""] = true, on = true, off = true }, ctx = { [""] = true, on = true, off = true },
	mode = { [""] = true, pixel = true, reload = true },
	signal = { [""] = true, on = true, off = true }, longchat = { [""] = true, on = true, off = true },
	auto = OnOffOrNumber,
	echo = function(rest) return rest == "" or rest == "summary" or rest == "full" or rest == "short" or rest == "off" or tonumber(rest) ~= nil end,
	bind = 1, agent = AgentArgument,
	chat = ChatArgument, chats = ChatArgument,
	cd = true, new = true, rename = true,
	map = true, -- /wow-ai map ...: Map.lua (layers, navigator, herb/ore nodes)
}

local function IsCommand(cmd, rest)
	for _, mod in ipairs(ForeverModules()) do if type(mod.commands) == "table" and type(mod.commands[cmd]) == "function" then return true end end
	local spec = COMMAND_ARGS[cmd]
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

local function ApplyLongChat()
	local box = ChatFrame1EditBox
	if not box or not box.SetMaxLetters then return end
	box:SetMaxLetters(db.settings.longchat and 4000 or 255)
end

SLASH_WOWAI1 = "/wow-ai"
SLASH_WOWAI2 = "/wowai"
SLASH_WOWAI3 = "/wow-claude" -- the project's old name, kept so old habits and macros still work
SLASH_WOWAI4 = "/ai" -- the short form: /ai <text> sends, /ai agent codex and the rest work too
SLASH_WOWAI5 = "/ask"
SlashCmdList["WOWAI"] = function(msg)
	msg = Trim(msg or "")
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	local s = db.settings
	local c = ActiveChat()
	if cmd == "help" and rest:lower() == "forever" then
		AddHistory(c, "system", "Forever: review, death, build, gear, bags, quest, brief <what>, drill, practice, recap, level, look [question], council <question>, phone, guide, off, on")
		WoWAI.Render()
		return
	end
	for _, mod in ipairs(ForeverModules()) do
		local handler = type(mod.commands) == "table" and mod.commands[cmd]
		if cmd ~= "" and type(handler) == "function" then pcall(handler, rest, c); return end
	end

	-- Anything that isn't a command, or a command word followed by something it
	-- doesn't take, is a message for the agent.
	if cmd ~= "" and not IsCommand(cmd, rest) then
		WoWAI.Send(msg)
		return
	end
	if cmd == "" then
		WoWAI.Toggle()
	elseif cmd == "mini" or cmd == "min" then
		WoWAI.Minimize(true)
	elseif cmd == "new" then
		WoWAI.NewChat(rest)
	elseif cmd == "chat" or cmd == "chats" then
		local n = tonumber(rest)
		local target = n and db.chats[n]
		if not target and rest ~= "" then
			for _, ch in ipairs(db.chats) do
				if ch.name:lower() == rest:lower() then target = ch end
			end
		end
		if target then
			WoWAI.SwitchChat(target.id)
		else
			local lines = {}
			for i, ch in ipairs(db.chats) do
				table.insert(lines, i .. ". " .. ch.name .. (ch.id == db.activeChat and "  (current)" or "") .. (ch.pendingId and "  working" or "") .. ((ch.unread or 0) > 0 and ("  " .. ch.unread .. " new") or ""))
			end
			AddHistory(c, "system", "Chats:\n" .. table.concat(lines, "\n"))
			WoWAI.Render()
		end
		WoWAI.Toggle(true)
	elseif cmd == "rename" then
		if rest ~= "" then
			c.name = rest:sub(1, 24)
			WoWAI.Render()
		else
			WoWAI.RenameActive()
		end
		WoWAI.Toggle(true)
	elseif cmd == "delete" then
		WoWAI.DeleteChat()
	elseif cmd == "cd" then
		WoWAI.SetFolder(rest, c)
		WoWAI.Toggle(true)
	elseif cmd == "map" then
		if WoWAIMap then WoWAIMap.Command(rest) else print("|cff66ccff[WoW AI]|r the map module did not load") end
	elseif cmd == "agent" then
		WoWAI.SetAgent(rest, c)
		WoWAI.Toggle(true)
	elseif cmd == "reset" then
		c.resetNext = true
		local where = ChatFolder(c)
		AddHistory(c, "system", "Next message starts a fresh " .. ChatAgentName(c) .. " session" .. (where ~= "" and (" in " .. where) or ""))
		WoWAI.Render()
		WoWAI.Toggle(true)
	elseif cmd == "context" or cmd == "ctx" then
		rest = rest:lower()
		if rest == "on" or rest == "off" then
			s.context = rest == "on"
			-- Make sure the next record carries the change, hello throttle or not.
			run.contextSent = nil
			run.lastHelloAt = nil
			if WoWAI.IsConnected() then WoWAI.SayHello() end
		end
		local ctx = WoWAI.GameContext()
		AddHistory(c, "system", (s.context
			and "Game context is ON: the agent is told this with each message (it goes into its system prompt, so unrelated projects are unaffected by anything but a few lines). /wow-ai context off to stop.\n\n"
			or "Game context is OFF: the agent is told nothing about the game. /wow-ai context on to send this:\n\n") .. ctx
			.. "\n\nTip: click the input box, then shift-click an item, spell or quest to link it into your message; the agent gets its tooltip.")
		WoWAI.Render()
		WoWAI.Toggle(true)
	elseif cmd == "mode" then
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			AddHistory(c, "system", "mode set to " .. rest)
		else
			AddHistory(c, "system", "mode is " .. s.mode .. " (pixel or reload)")
		end
		WoWAI.Render()
		WoWAI.Toggle(true)
	elseif cmd == "resend" then
		WoWAI.Resend()
	elseif cmd == "auto" then
		local n = tonumber(rest)
		if n then
			s.interval = math.max(5, math.floor(n))
			s.autoRefresh = true
		elseif rest == "on" then
			s.autoRefresh = true
		elseif rest == "off" then
			s.autoRefresh = false
		end
		WoWAI.UpdateStatus()
		WoWAI.ArmAutoRefresh()
	elseif cmd == "hide" or cmd == "quit" then
		WoWAI.Toggle(false)
	elseif cmd == "copy" then
		for i = #c.history, 1, -1 do
			if c.history[i].role == "assistant" then
				WoWAI.ShowCopy(c.history[i].text)
				break
			end
		end
	elseif cmd == "echo" then
		if rest == "summary" or rest == "full" or rest == "short" or rest == "off" then
			s.echo = rest
		elseif tonumber(rest) then
			s.echo = tostring(math.max(200, math.floor(tonumber(rest))))
		end
		AddHistory(c, "system", "replies in game chat: " .. s.echo .. " (summary = the agent's TL;DR lines, full = " .. ECHO_DEFAULT .. " chars, short, off, or a number of characters)")
		WoWAI.Render()
	elseif cmd == "longchat" then
		if rest == "on" then s.longchat = true elseif rest == "off" then s.longchat = false end
		ApplyLongChat()
		AddHistory(c, "system", "game chat box limit: " .. (s.longchat and "4000 characters (fine for /ai; real chat over 255 may be rejected by the server)" or "255 (default)"))
		WoWAI.Render()
	elseif cmd == "signal" then
		if rest == "on" then s.signal = true elseif rest == "off" then s.signal = false end
		AddHistory(c, "system", "signal check is " .. (s.signal and "on" or "off"))
		WoWAI.Render()
	elseif cmd == "slots" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		AddHistory(c, "system", free .. " of " .. SLOT_COUNT .. " reply slots free this session (a reload frees all)")
		WoWAI.Render()
		WoWAI.Toggle(true)
	elseif cmd == "refresh" or cmd == "reload" then
		SafeReload()
	elseif cmd == "bind" then
		local key = rest:upper()
		if key ~= "" and not InCombatLockdown() then
			SetBinding(key, "CLICK WoWAIRefreshButton:LeftButton")
			SaveBindings(GetCurrentBindingSet())
			AddHistory(c, "system", key .. " is now bound: checks for a reply while waiting, otherwise toggles this window")
		end
		WoWAI.Render()
		WoWAI.Toggle(true)
	elseif cmd == "diag" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		local lines = {
			"sound channel: " .. (signalAvailable and "usable" or "UNUSABLE") .. " (self-test: " .. tostring(signalStats.selftest) .. ")" .. (signalStats.error and (" error: " .. signalStats.error) or ""),
			"signal setting: " .. tostring(s.signal) .. ", marked unreliable this session: " .. tostring(run.signalUnreliable or false),
			"sound checks: " .. signalStats.checks .. ", valid hits: " .. signalStats.hits .. (signalStats.lastHit and (", last hit " .. FmtDur(GetTime() - signalStats.lastHit) .. " ago") or ""),
			SlotUsageLine() .. ", free slots: " .. free .. "/" .. SLOT_COUNT,
			"presence: head at " .. tostring(run.presence and run.presence.last or "?") .. ", beats seen: " .. tostring(run.presence and run.presence.beats or 0),
			select(5, WoWAI.BridgeState()),
			"mode: " .. s.mode .. ", session token: " .. tostring(db.session),
		}
		local logChanges = WoWAI.CombatLogChanges()
		table.insert(lines, "combat log now: " .. (type(LoggingCombat) == "function" and (LoggingCombat() and "on" or "off") or "?")
			.. ", changes this session: " .. (#logChanges == 0 and "none" or table.concat(logChanges, "; ")))
		for _, ch in ipairs(db.chats) do
			local a = run.act and run.act[ch.id]
			if ch.pendingId then
				table.insert(lines, ch.name .. ": pending #" .. ch.pendingId .. (a and (", heartbeat " .. (a.unreliable and "unreliable" or (a.count .. " beats"))) or ", no heartbeat state"))
			end
		end
		AddHistory(c, "system", "Diagnostics:\n" .. table.concat(lines, "\n"))
		WoWAI.Render()
		WoWAI.Toggle(true)
	elseif cmd == "cancel" then
		if c.pendingId then
			AddHistory(c, "system", "Gave up waiting for the reply")
			run.outbound[c.pendingId] = nil
			if run.act then run.act[c.id] = nil end
			c.pendingId = nil
			c.progress = nil
			RefreshStrip()
			if not AnyPending() and not WoWAI.reloadAfterCombat then keyCatcher:Hide() end
		end
		WoWAI.Render()
	elseif cmd == "clear" then
		wipe(c.history)
		WoWAI.Render()
	elseif cmd == "help" then
		AddHistory(c, "system", HELP)
		WoWAI.Render()
		WoWAI.Toggle(true)
	end
end

WoWAI.internal = { AddHistory = AddHistory, Finish = Finish, ActiveChat = ActiveChat, Render = WoWAI.Render, RefreshStrip = RefreshStrip, FindChat = FindChat, Chats = function() return db.chats end, SwitchChat = WoWAI.SwitchChat }

---------------------------------------------------------------------------
-- Events
---------------------------------------------------------------------------

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("PLAYER_REGEN_ENABLED")
ev:SetScript("OnEvent", function(self, event, arg1)
	if event == "ADDON_LOADED" then
		if arg1 == ADDON_NAME then
			InitDB()
		end
	elseif event == "PLAYER_LOGIN" then
		if not db then InitDB() end
		BuildUI()
		run = { outbound = {}, slotsUsed = {}, startedAt = GetTime() }
		SelfTestSignals()
		ProcessInbox()
		if AnyPending() then
			-- Still waiting after a reload: resume polling with a fresh slot pool.
			run.sentAt = GetTime()
			run.polls = 0
			run.act = {}
			for _, ch in ipairs(db.chats) do
				if ch.pendingId then
					-- Beats already written stay valid, so the counter catches up on its own.
					run.act[ch.id] = { next = 1, count = 0, startedAt = GetTime() }
				end
			end
			ScheduleNextPoll()
		end
		local c = ActiveChat()
		if c and c.draft and c.draft ~= "" then
			ui.input:SetText(c.draft)
			if not c.pendingId then c.draft = nil end
		end
		WoWAI.Render()
		if db.settings.shown then
			if db.settings.minimized then
				WoWAI.Minimize(true)
			else
				WoWAI.Toggle(true)
			end
		end
		WoWAI.ArmAutoRefresh()
		WoWAI.UpdateDot()
		if db.settings.longchat then ApplyLongChat() end
		C_Timer.NewTicker(TICK_SECONDS, Tick)
		C_Timer.After(3, WoWAI.SayHello)
	elseif event == "PLAYER_REGEN_ENABLED" then
		if WoWAI.reloadAfterCombat then
			-- ReloadUI() is blocked outside a keypress or click, and this event is
			-- neither: reload on the player's next keypress instead.
			ShowKeyCatcher()
		elseif db then
			WoWAI.ArmAutoRefresh()
		end
	end
end)
