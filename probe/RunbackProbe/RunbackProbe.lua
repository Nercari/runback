local addonName, ns = ...

local EVENT_NAMES = {
	"PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "ENCOUNTER_START", "ENCOUNTER_END",
	"CHALLENGE_MODE_START", "CHALLENGE_MODE_COMPLETED", "QUEST_DETAIL", "SCREENSHOT_SUCCEEDED",
	"SCREENSHOT_FAILED", "ADDON_ACTION_BLOCKED", "ADDON_ACTION_FORBIDDEN", "PLAYER_DEAD",
}
local function now() return time() end
local function record(key, value, note)
	if not RunbackProbeDB then return end
	RunbackProbeDB.results = RunbackProbeDB.results or {}
	local v = tostring(value or "UNKNOWN")
	v = string.gsub(v, "[^%w%p ]", " ")
	if string.len(v) > 200 then v = string.sub(v, 1, 200) end
	local n = note and string.gsub(tostring(note), "[^%w%p ]", " ") or nil
	if n and string.len(n) > 200 then n = string.sub(n, 1, 200) end
	RunbackProbeDB.results[key] = { value = v, at = now(), note = n }
	local lines = {}
	for k, item in pairs(RunbackProbeDB.results) do lines[#lines + 1] = k .. "=" .. item.value end
	table.sort(lines)
	RunbackProbeDB.report = table.concat(lines, "\n")
end
local function protectedCall(key, fn, ...)
	if InCombatLockdown and InCombatLockdown() then record(key, "SKIPPED_COMBAT"); return end
	if type(fn) ~= "function" then record(key, "ABSENT"); return end
	local ok, a, b, c = pcall(fn, ...)
	if ok then record(key, "CALLED", a ~= nil and tostring(a) or nil)
	else record(key, "ERROR", a) end
end
local function apiSummary(value)
	if type(value) ~= "table" then return type(value) .. (value == nil and "" or ":" .. tostring(value)) end
	local keys, count = {}, 0
	for k in pairs(value) do count = count + 1; if type(k) == "string" and type(value[k]) == "function" then keys[#keys + 1] = k end end
	table.sort(keys)
	return "table size=" .. count .. " functions=" .. table.concat(keys, ",")
end
local function meterRead(key)
	if not C_DamageMeter then record(key, "ABSENT"); return end
	local names, getter = {}, nil
	for k, v in pairs(C_DamageMeter) do if type(v) == "function" then names[#names + 1] = k; if not getter then getter = v end end end
	table.sort(names)
	local ok, value = true, nil
	if getter then ok, value = pcall(getter) end
	local status = ok and "PASS" or "FAIL"
	local summary = "functions=" .. table.concat(names, ",") .. "; getter=" .. (getter and apiSummary(value) or "none")
	RunbackProbeDB.meter = RunbackProbeDB.meter or {}
	RunbackProbeDB.meter[key] = { value = status, summary = summary, at = now() }
	record(key, status, summary)
end
local function presence(key, value) record(key, type(value)) end
local function cvar(key, name)
	local value
	if type(GetCVar) == "function" then local ok, v = pcall(GetCVar, name); if ok then value = v end end
	record(key, value ~= nil and value or "ABSENT")
end
local function probePassive()
	local version, build, date, interface = GetBuildInfo()
	record("build", tostring(version) .. " build=" .. tostring(build) .. " date=" .. tostring(date))
	record("interface", interface or "UNKNOWN")
	presence("api_auctionhouse", C_AuctionHouse)
	presence("api_encounterjournal", C_EncounterJournal and C_EncounterJournal.GetEncounterInfo or EJ_GetEncounterInfo)
	presence("api_challengemode", C_ChallengeMode and C_ChallengeMode.GetActiveChallengeMapID)
	presence("api_damagemeter", C_DamageMeter)
	presence("api_speaktext", C_VoiceChat and C_VoiceChat.SpeakText)
	local voices = C_VoiceChat and C_VoiceChat.GetTtsVoices
	if type(voices) == "function" then
		local ok, list = pcall(voices)
		local out = {}
		if ok and type(list) == "table" then for _, voice in pairs(list) do out[#out + 1] = tostring(voice.name or voice.voiceName or voice.voiceID or voice.id or "?") end end
		table.sort(out); record("tts_voices", ok and (#out > 0 and table.concat(out, ",") or "EMPTY") or "ERROR", ok and nil or list)
	else record("tts_voices", "ABSENT") end
	presence("api_createmacro", CreateMacro); presence("api_loggingcombat", LoggingCombat)
	presence("api_traits", C_Traits or C_ClassTalents); presence("api_inventoryitemlink", GetInventoryItemLink)
	presence("api_questtext", GetQuestText or GetObjectiveText)
	presence("api_loadaddon", C_AddOns and C_AddOns.LoadAddOn); presence("api_screenshot", Screenshot)
	presence("api_copytoclipboard", CopyToClipboard); presence("api_partyinfo", C_PartyInfo)
	presence("api_incombatlockdown", InCombatLockdown)
	cvar("cvar_screenshotformat", "screenshotFormat"); cvar("cvar_advancedcombatlogging", "advancedCombatLogging"); cvar("cvar_screenshotquality", "screenshotQuality")
end
local function eventValue(event, ...)
	local args = { ... }
	RunbackProbeDB.events = RunbackProbeDB.events or {}
	local item = RunbackProbeDB.events[event] or { count = 0 }
	item.count = item.count + 1; item.time = now(); item.serverTime = GetServerTime()
	if event == "ENCOUNTER_START" or event == "ENCOUNTER_END" then item.name = tostring(args[2] or args[1] or ""); item.success = tostring(args[5] or args[3] or "") end
	if event == "ADDON_ACTION_BLOCKED" or event == "ADDON_ACTION_FORBIDDEN" then item.functionName = tostring(args[2] or args[1] or "") end
	RunbackProbeDB.events[event] = item
	if InCombatLockdown and InCombatLockdown() then return end
	if event == "PLAYER_REGEN_DISABLED" then record("ev_regen", "combat=" .. item.count)
		meterRead("meter_in_combat")
	elseif event == "PLAYER_REGEN_ENABLED" then record("ev_regen", "combat-end=" .. item.count); if not InCombatLockdown or not InCombatLockdown() then meterRead("meter_after_combat") end
	elseif event == "ENCOUNTER_START" or event == "ENCOUNTER_END" then record("ev_encounter", event .. "=" .. item.count .. " " .. tostring(item.name))
	elseif event == "CHALLENGE_MODE_START" or event == "CHALLENGE_MODE_COMPLETED" then record("ev_challenge", event .. "=" .. item.count)
	elseif event == "QUEST_DETAIL" then
		record("ev_questdetail", "count=" .. item.count)
		local ok, txt = false, nil
		if type(GetQuestText) == "function" then ok, txt = pcall(GetQuestText) elseif type(GetObjectiveText) == "function" then ok, txt = pcall(GetObjectiveText) end
		record("questtext_nonempty", ok and type(txt) == "string" and string.len(txt) > 0 and "PASS" or "FAIL", "length=" .. tostring(ok and type(txt) == "string" and string.len(txt) or 0))
	elseif event == "SCREENSHOT_SUCCEEDED" or event == "SCREENSHOT_FAILED" then
		local key = RunbackProbeDB.screenshotPending
		if key then
			record(key, event == "SCREENSHOT_SUCCEEDED" and "PASS" or "FAIL")
		end
	elseif event == "ADDON_ACTION_BLOCKED" or event == "ADDON_ACTION_FORBIDDEN" then
		local name = tostring(item.functionName)
		record("protected_event", event .. " " .. name)
		if string.find(name, "Screenshot", 1, true) then
			record("screenshot_hw", "BLOCKED")
			record("screenshot_no_hw", "BLOCKED")
		elseif string.find(name, "CopyToClipboard", 1, true) then
			record("clipboard", "BLOCKED")
		end
	end
end
local frame, rows, stripFrames = nil, {}, {}
local function buildUI()
	if frame then return end
	frame = CreateFrame("Frame", "RunbackProbeFrame", UIParent, "BackdropTemplate")
	frame:SetSize(430, 560); frame:SetPoint("CENTER"); frame:SetMovable(true); frame:EnableMouse(true); frame:RegisterForDrag("LeftButton")
	frame:SetScript("OnDragStart", frame.StartMoving); frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
	frame:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
	local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge"); title:SetPoint("TOP", 0, -12); title:SetText("Runback Probe")
	local specs = {
		{"Screenshot now", function() RunbackProbeDB.screenshotPending = "screenshot_hw"; protectedCall("screenshot_hw", Screenshot) end},
		{"Screenshot in 1s (no hw event)", function() C_Timer.After(1, function() RunbackProbeDB.screenshotPending = "screenshot_no_hw"; protectedCall("screenshot_no_hw", Screenshot) end) end},
		{"Set PNG", function() if InCombatLockdown and InCombatLockdown() then record("png_set", "SKIPPED_COMBAT"); return end; RunbackProbeDB.oldScreenshotFormat = GetCVar and GetCVar("screenshotFormat"); protectedCall("png_set", SetCVar, "screenshotFormat", "png") end},
		{"Restore format", function() if InCombatLockdown and InCombatLockdown() then record("png_set", "SKIPPED_COMBAT"); return end; protectedCall("png_set", SetCVar, "screenshotFormat", RunbackProbeDB.oldScreenshotFormat or "") end},
		{"Show test strip", function() if InCombatLockdown and InCombatLockdown() then record("strip_shown", "SKIPPED_COMBAT"); return end; for _, px in ipairs({8, 2}) do local f = CreateFrame("Frame", nil, UIParent); f:SetSize(px * 8, 8); f:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, -(#stripFrames * 10)); local colors = {{87/255,168/255,0.5},{65/255,190/255,0.5},{73/255,182/255,0.5},{80/255,175/255,0.5},{1,0,0},{0,1,0},{0,0,1},{1,1,1}}; for i,c in ipairs(colors) do local t=f:CreateTexture(nil,"OVERLAY"); t:SetColorTexture(c[1],c[2],c[3],1); t:SetSize(px,px); t:SetPoint("LEFT",f,"LEFT",(i-1)*px,0) end; stripFrames[#stripFrames+1]=f end; C_Timer.After(10,function() for _,f in ipairs(stripFrames) do f:Hide() end end); record("strip_shown", "PASS") end},
		{"Speak test", function() local v = C_VoiceChat and C_VoiceChat.GetTtsVoices; local first; if type(v)=="function" then local ok,list=pcall(v); if ok and type(list)=="table" then for _,voice in pairs(list) do first=voice.voiceID or voice.id; if first then break end end end end; if not first then record("speak", "NO_VOICE"); return end; protectedCall("speak", C_VoiceChat.SpeakText, first, "Runback probe", 0, 0, 100) end},
		{"CopyToClipboard test", function() protectedCall("clipboard", CopyToClipboard, "probe") end},
		{"CreateMacro test", function() if InCombatLockdown and InCombatLockdown() then record("createmacro", "SKIPPED_COMBAT"); return end; local found=false; if type(GetNumMacros)=="function" then local _,char=GetNumMacros(); for i=1,(char or 0) do local name=GetMacroInfo(i); if name=="WAIPROBE" then found=true end end end; if found then record("createmacro", "macro_name_taken"); return end; local ok,id=pcall(CreateMacro,"WAIPROBE","INV_Misc_QuestionMark","/say probe",nil); if not ok then record("createmacro","ERROR",id); return end; if type(DeleteMacro)=="function" then pcall(DeleteMacro,id) end; record("createmacro",id and "PASS" or "FAIL") end},
		{"LoggingCombat test", function() if InCombatLockdown and InCombatLockdown() then record("loggingcombat_call", "SKIPPED_COMBAT"); return end; local old=LoggingCombat and LoggingCombat(); RunbackProbeDB.loggingCombatOld=tostring(old); protectedCall("loggingcombat_call", LoggingCombat, true); local new=LoggingCombat and LoggingCombat(); record("loggingcombat_call", tostring(new), "old="..tostring(old).."; intentionally left enabled") end},
		{"LoadAddOn test", function() protectedCall("loadaddon_lod", C_AddOns and C_AddOns.LoadAddOn, "RunbackProbe_LOD"); record("loadaddon_lod", RunbackProbe_LOD_loaded and "PASS" or "FAIL") end},
	}
	for i,spec in ipairs(specs) do
		local y=-42-(i-1)*37
		local b=CreateFrame("Button",nil,frame,"UIPanelButtonTemplate"); b:SetSize(260,28); b:SetPoint("TOPLEFT",16,y); b:SetText(spec[1]); b:SetScript("OnClick",spec[2])
		local text=frame:CreateFontString(nil,"OVERLAY","GameFontNormalSmall"); text:SetPoint("LEFT",b,"RIGHT",8,0); text:SetText("UNKNOWN"); rows[#rows+1]={button=b,text=text,key=spec[1]}
	end
	local close=CreateFrame("Button",nil,frame,"UIPanelCloseButton"); close:SetPoint("TOPRIGHT",-4,-4); close:SetScript("OnClick",function() frame:Hide() end)
end
local function refresh()
	if not frame then return end
	for _,row in ipairs(rows) do local item=RunbackProbeDB.results and RunbackProbeDB.results[row.key]; row.text:SetText(item and item.value or "UNKNOWN") end
end
local eventFrame=CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED"); eventFrame:RegisterEvent("PLAYER_LOGIN")
for _,event in ipairs(EVENT_NAMES) do eventFrame:RegisterEvent(event) end
eventFrame:SetScript("OnEvent",function(_,event,...)
	if event=="ADDON_LOADED" then
		local name=...
		if name~=addonName then return end
		RunbackProbeDB=RunbackProbeDB or {}
		local prior=RunbackProbeDB.boot
		if prior then record("sv_readback","PASS","boot="..tostring(prior).." lastWrite="..tostring(RunbackProbeDB.lastWrite)) else record("sv_readback","UNKNOWN (first run)") end
		RunbackProbeDB.boot=(prior or 0)+1; RunbackProbeDB.lastWrite=now()
	elseif event=="PLAYER_LOGIN" then probePassive(); buildUI()
	else eventValue(event,...) end
end)
SLASH_RUNBACKPROBE1="/runbackprobe"
SlashCmdList.RUNBACKPROBE=function(msg)
	msg=msg or ""
	if string.lower(msg)=="report" then
		local lines=RunbackProbeDB and RunbackProbeDB.report or "No results"
		for line in string.gmatch(lines,"[^\n]+") do print("[WAIPROBE] "..line) end
	else buildUI(); if frame:IsShown() then frame:Hide() else frame:Show() end; refresh() end
end
