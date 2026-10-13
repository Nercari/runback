local queue = {}

local function GetSettings()
	RunbackForeverDB = RunbackForeverDB or {}
	RunbackForeverDB.speech = RunbackForeverDB.speech or {}
	local s = RunbackForeverDB.speech
	if s.enabled == nil then s.enabled = false end
	if s.rate == nil then s.rate = 0 end
	if s.volume == nil then s.volume = 100 end
	if s.narrate == nil then s.narrate = false end
	return s
end

local function GetVoices()
	if type(C_VoiceChat) ~= "table" or type(C_VoiceChat.GetTtsVoices) ~= "function" then
		return {}
	end
	local ok, list = pcall(C_VoiceChat.GetTtsVoices)
	return (ok and type(list) == "table") and list or {}
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

local function PlayTTS(text)
	if type(C_VoiceChat) ~= "table" or type(C_VoiceChat.SpeakText) ~= "function" then
		return
	end
	local voices = GetVoices()
	if #voices == 0 then
		return
	end
	local s = GetSettings()
	local voiceID = s.voice
	if not voiceID then
		local first = voices[1]
		voiceID = first and (first.voiceID or first.id) or 0
	end
	local dest = 1
	if type(Enum) == "table" and type(Enum.VoiceTtsDestination) == "table" and Enum.VoiceTtsDestination.LocalPlayback then
		dest = Enum.VoiceTtsDestination.LocalPlayback
	end
	local rate = s.rate or 0
	local volume = s.volume or 100
	pcall(C_VoiceChat.SpeakText, voiceID, text, dest, rate, volume)
end

local function QueueSpeech(text)
	table.insert(queue, { text = text, t = time() })
	while #queue > 3 do
		table.remove(queue, 1)
	end
end

local function FlushQueue()
	if IsBlocked() then
		return
	end
	local now = time()
	local valid = {}
	for _, item in ipairs(queue) do
		if now - item.t <= 300 then
			table.insert(valid, item)
		end
	end
	queue = {}
	for _, item in ipairs(valid) do
		PlayTTS(item.text)
	end
end

local function Speak(text)
	if type(text) ~= "string" or text == "" then
		return
	end
	if IsBlocked() then
		QueueSpeech(text)
		return
	end
	PlayTTS(text)
end

RunbackForever.Speak = Speak

local function ExtractTLDR(text)
	text = tostring(text or "")
	local lower = text:lower()
	local lastPos = nil
	local start = 1
	while true do
		local s, e = lower:find("tl;dr:", start, true)
		if not s then break end
		lastPos = e + 1
		start = e + 1
	end
	if lastPos then
		local sub = text:sub(lastPos)
		local trimmed = sub:match("^%s*(.-)%s*$")
		return trimmed ~= "" and trimmed or text:sub(1, 200)
	end
	return text:sub(1, 200)
end

local function OnReply(chat, rec)
	local s = GetSettings()
	if not s.enabled then
		return
	end
	if not rec or rec.status ~= "done" then
		return
	end
	local text = ExtractTLDR(rec.text)
	if text ~= "" then
		Speak(text)
	end
end

local function OnEvent(event)
	if event == "QUEST_DETAIL" then
		local s = GetSettings()
		if not s.narrate or IsBlocked() then
			return
		end
		if type(GetQuestText) == "function" then
			local qtext = GetQuestText()
			if type(qtext) == "string" and qtext ~= "" then
				Speak(qtext:sub(1, 600))
			end
		end
	end
end

local function HandleSpeak(rest)
	local voices = GetVoices()
	if #voices == 0 then
		print("No text-to-speech voices on this client; replies stay text only.")
		return
	end
	local s = GetSettings()
	local sub, arg = (rest or ""):match("^(%S+)%s*(.-)$")
	sub = sub and sub:lower() or ""
	if sub == "on" then
		s.enabled = true
		print("AI speech is on")
	elseif sub == "off" then
		s.enabled = false
		print("AI speech is off")
	elseif sub == "voices" then
		for _, v in ipairs(voices) do
			local id = v.voiceID or v.id or 0
			local name = v.name or ("Voice " .. id)
			print(id .. ": " .. name)
		end
	elseif sub == "voice" then
		local id = tonumber(arg)
		if id then
			s.voice = id
			print("Speech voice set to " .. id)
		else
			print("Usage: /ai speak voice <id>")
		end
	elseif sub == "rate" then
		local r = tonumber(arg)
		if r and r >= -10 and r <= 10 then
			s.rate = r
			print("Speech rate set to " .. r)
		else
			print("Usage: /ai speak rate <-10..10>")
		end
	else
		print("Usage: /ai speak on|off|voices|voice <id>|rate <-10..10>")
	end
end

local function HandleNarrate(rest)
	local voices = GetVoices()
	if #voices == 0 then
		print("No text-to-speech voices on this client; replies stay text only.")
		return
	end
	local s = GetSettings()
	local val = (rest or ""):lower():match("^%S+") or ""
	if val == "on" then
		s.narrate = true
		print("Quest narration is on")
	elseif val == "off" then
		s.narrate = false
		print("Quest narration is off")
	else
		print("Usage: /ai narrate on|off")
	end
end

local function Init()
	GetSettings()
	RunbackForever.On("LOCKOUT_CHANGED", function(locked)
		if not locked then
			FlushQueue()
		end
	end)
	RunbackForever.On("SWITCH", function(off)
		if not off then
			FlushQueue()
		end
	end)
end

RunbackForever.Register({
	name = "speech",
	init = Init,
	events = { QUEST_DETAIL = true },
	onEvent = OnEvent,
	onReply = OnReply,
	commands = {
		speak = HandleSpeak,
		narrate = HandleNarrate,
	},
})
