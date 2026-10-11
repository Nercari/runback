local defaults = {
	review = "Review my last fight.", death = "Why did I die?",
	build = "Suggest a talent build for my level and goal.",
	gear = "Audit my gear and find upgrades.", quest = "Explain this quest (no spoilers).",
	level = "Plan my leveling route.", drill = "What should I practice today?", phone = "phone",
	practice = "Compare my last two target-dummy sessions.",
	recap = "Give me a short recap of this session.",
	bags = "What can I sell or drop?",
}

local function TargetChat()
	local internal = WoWAI.internal
	local active = internal.ActiveChat()
	for _, chat in ipairs(WoWAIDB.chats or {}) do
		if type(chat.name) == "string" and chat.name:lower() == "mentor" then return chat, active end
	end
	return active, active
end

local function Send(cmd, rest)
	if cmd == "level" and type(RequestTimePlayed) == "function" then RequestTimePlayed() end
	local text = rest ~= "" and rest or defaults[cmd]
	if not text then
		print("Usage: /ai " .. cmd .. " <text>")
		return
	end
	local chat = TargetChat()
	if not chat then return end
	WoWAI.Send(text, nil, { cmd = cmd, chat = chat.id })
end

local commands = { "review", "death", "build", "gear", "quest", "brief", "drill", "level", "look", "council", "phone", "practice", "recap", "bags" }
local handlers = {}
for _, cmd in ipairs(commands) do
	handlers[cmd] = function(rest)
		if (cmd == "look" or cmd == "council" or cmd == "brief") and rest == "" then
			print("Usage: /ai " .. cmd .. " <text>")
			return
		end
		Send(cmd, rest)
	end
end
WoWAIForever.Register({ name = "commands", commands = handlers })

