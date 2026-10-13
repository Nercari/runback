local jobsFrame = nil
local rowPool = {}
local prevStatuses = {}
local workingStarted = {}

local function GetChatStatus(c)
	if not c then return "idle" end
	if c.pendingId then
		return "working"
	end
	local history = c.history or {}
	local last = history[#history]
	if last then
		if type(last.denied) == "table" and #last.denied > 0 then
			return "needs approval"
		end
		if last.role == "system" and type(last.text) == "string" and last.text:find("^Bridge error:") then
			return "error"
		end
		if last.role == "assistant" then
			return "done"
		end
	end
	return "idle"
end

local function GetChats()
	if RunbackForever and type(RunbackForever.GetChats) == "function" then
		return RunbackForever.GetChats()
	end
	return (RunbackDB and RunbackDB.chats) or {}
end

local function CheckTransitions()
	local chats = GetChats()
	local now = GetTime()
	for _, c in ipairs(chats) do
		local st = GetChatStatus(c)
		local prev = prevStatuses[c.id]
		if prev == "working" and (st == "done" or st == "error") then
			local sound = (SOUNDKIT and SOUNDKIT.IG_QUEST_LOG_OPEN) or 850
			pcall(PlaySound, sound)
			if RunbackForeverDB and RunbackForeverDB.speech and RunbackForeverDB.speech.enabled then
				if RunbackForever and type(RunbackForever.Speak) == "function" then
					RunbackForever.Speak(c.name .. " done")
				end
			end
		end
		if st == "working" and prev ~= "working" then
			workingStarted[c.id] = now
		elseif st ~= "working" then
			workingStarted[c.id] = nil
		end
		prevStatuses[c.id] = st
	end
end

local function EnsureJobsFrame()
	if jobsFrame then return jobsFrame end
	local f = CreateFrame("Frame", "RunbackJobsFrame", UIParent, "BackdropTemplate")
	f:SetSize(460, 220)
	f:SetPoint("CENTER", UIParent, "CENTER", 0, 50)
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
			f:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
		end
	end
	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOPLEFT", f, "TOPLEFT", 12, -10)
	title:SetText("AI jobs")
	f.title = title

	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -2, -2)
	close:SetScript("OnClick", function() f:Hide() end)

	f:Hide()
	jobsFrame = f
	return f
end

local function UpdateJobsUI()
	CheckTransitions()
	if not jobsFrame or not jobsFrame:IsShown() then return end
	local chats = GetChats()
	local now = GetTime()
	for _, row in ipairs(rowPool) do
		row:Hide()
	end
	local y = 32
	for i, c in ipairs(chats) do
		local row = rowPool[i]
		if not row then
			row = jobsFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
			row:SetJustifyH("LEFT")
			rowPool[i] = row
		end
		row:ClearAllPoints()
		row:SetPoint("TOPLEFT", jobsFrame, "TOPLEFT", 12, -y)
		row:SetPoint("RIGHT", jobsFrame, "RIGHT", -12, 0)
		local st = GetChatStatus(c)
		local agent = (c.agent and c.agent ~= "") and c.agent or "AI"
		local text = string.format("%s  [%s]  -  %s", c.name, agent, st)
		if st == "working" then
			local started = workingStarted[c.id] or now
			local elapsed = math.max(0, math.floor(now - started))
			text = text .. " (" .. elapsed .. "s)"
		end
		row:SetText(text)
		row:Show()
		y = y + 18
	end
	jobsFrame:SetHeight(math.max(80, y + 12))
end

local function ToggleJobs()
	local f = EnsureJobsFrame()
	if f:IsShown() then
		f:Hide()
	else
		f:Show()
		UpdateJobsUI()
	end
end

local function OnReply(chat, rec)
	CheckTransitions()
	if jobsFrame and jobsFrame:IsShown() then
		UpdateJobsUI()
	end
end

local function Init()
	EnsureJobsFrame()
	CheckTransitions()
	if C_Timer and type(C_Timer.NewTicker) == "function" then
		C_Timer.NewTicker(1, function()
			if jobsFrame and jobsFrame:IsShown() then
				UpdateJobsUI()
			else
				CheckTransitions()
			end
		end)
	end
end

RunbackForever.Register({
	name = "jobs",
	init = Init,
	onReply = OnReply,
	commands = {
		jobs = ToggleJobs,
	},
})
