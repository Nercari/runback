local fights, deaths = {}, {}
local current, encounterName, quest, loginAt = nil, nil, nil, time()
local xpGained, xpStart = 0, UnitXP and UnitXP("player") or 0
local meter, playedTotal, playedLevel

local function AddFight(started, stopped)
	local f = { start = started or time(), stop = stopped }
	fights[#fights + 1] = f
	while #fights > 5 do table.remove(fights, 1) end
	return f
end

local function Gear()
	local parts = {}
	for slot = 1, 19 do
		local link = type(GetInventoryItemLink) == "function" and GetInventoryItemLink("player", slot)
		local fields = link and link:match("|Hitem:([^|]+)|h")
		local id, ench, g1, g2 = fields and fields:match("^(%d*):?(%d*):?(%d*):?(%d*)")
		parts[#parts + 1] = slot .. ":" .. (id or "") .. ":" .. (ench or "") .. ":" .. (g1 or "") .. ":" .. (g2 or "")
	end
	local s = table.concat(parts, " ")
	return s
end

local FIGHT_WINDOW = 600 -- seconds after a fight or death that plain messages still carry it

local function Summary(kind)
	local lines = {}
	local last = fights[#fights]
	local function fightLine()
		if not last then return nil end
		local s = "lastFight=start=" .. date("%Y-%m-%dT%H:%M:%S", last.start)
		if last.stop then s = s .. ",end=" .. date("%Y-%m-%dT%H:%M:%S", last.stop) end
		if last.enc then s = s .. ",enc=" .. last.enc end
		if last.ok ~= nil then s = s .. ",ok=" .. (last.ok and "1" or "0") end
		return s
	end
	local function deathsLine()
		local d = {}
		for _, v in ipairs(deaths) do
			if not last or not last.stop or v.t >= last.stop - 600 then
				d[#d + 1] = date("%Y-%m-%dT%H:%M:%S", v.t) .. "@" .. v.zone
			end
		end
		return #d > 0 and "deaths=" .. table.concat(d, ";") or nil
	end
	-- Backlog 51: for 10 minutes after a fight ends or after a death, every message
	-- carries the fight and death lines, so "what did I do wrong?" can be answered
	-- without the Review button. Never while a fight is running.
	local function recent()
		if current then return false end
		local now = time()
		if last and last.stop and now - last.stop <= FIGHT_WINDOW then return true end
		for _, v in ipairs(deaths) do
			if now - v.t <= FIGHT_WINDOW then return true end
		end
		return false
	end
	if kind == "review" or kind == "death" then
		local dl = deathsLine()
		if dl then lines[#lines + 1] = dl end
		local f = fightLine()
		if f then lines[#lines + 1] = f end
		if kind == "review" and meter and not WoWAIForever.Locked() then lines[#lines + 1] = meter end
		local logging = type(LoggingCombat) == "function" and LoggingCombat() or false
		lines[#lines + 1] = "logging=" .. tostring(logging)
		if kind == "review" then lines[#lines + 1] = "advLogging=" .. tostring(GetCVar and GetCVar("advancedCombatLogging") == "1" or false) end
	else
		if kind == "gear" or kind == "build" or kind == "bags" then
			lines[#lines + 1] = "gear=" .. Gear()
		elseif kind == "quest" and quest then
			lines[#lines + 1] = "questDetail=" .. quest
		elseif kind == "level" then
			local cur, max = UnitXP("player"), UnitXPMax("player")
			local elapsed = math.max(1, time() - loginAt)
			lines[#lines + 1] = "xp=" .. cur .. "/" .. max .. " lvl " .. UnitLevel("player") .. ", xph=" .. math.floor(xpGained * 3600 / elapsed)
			if playedTotal ~= nil then lines[#lines + 1] = "played=" .. playedTotal .. "," .. tostring(playedLevel or 0) end
		end
		if recent() then
			local dl, f = deathsLine(), fightLine()
			if dl then lines[#lines + 1] = dl end
			if f then lines[#lines + 1] = f end
		end
	end
	return table.concat(lines, "\n")
end

WoWAIForever.Register({
	name = "context",
	events = { PLAYER_REGEN_DISABLED = true, PLAYER_REGEN_ENABLED = true, ENCOUNTER_START = true,
		ENCOUNTER_END = true, PLAYER_DEAD = true, QUEST_DETAIL = true, PLAYER_XP_UPDATE = true,
		PLAYER_LEVEL_UP = true, TIME_PLAYED_MSG = true },
	context = Summary,
	onEvent = function(event, ...)
		if event == "PLAYER_REGEN_DISABLED" then current = AddFight(time()) end
		if event == "PLAYER_REGEN_ENABLED" and current then
			current.stop = time()
			current = nil
		end
		if event == "ENCOUNTER_START" then
			local _, name = ...
			encounterName = name
			if not current then current = AddFight(time()) end
			current.enc = name
		end
		if event == "ENCOUNTER_END" then
			local _, name, _, _, success = ...
			if current then current.enc = name or encounterName; current.ok = success == 1 or success == true end
			encounterName = nil
		end
		if event == "PLAYER_DEAD" then
			deaths[#deaths + 1] = { t = time(), zone = GetZoneText() or "unknown", enc = encounterName }
			while #deaths > 3 do table.remove(deaths, 1) end
		end
		if event == "QUEST_DETAIL" then quest = tostring(GetQuestID and GetQuestID() or "") .. " " .. tostring(GetTitleText and GetTitleText() or "") end
		if event == "PLAYER_XP_UPDATE" then
			local now = UnitXP("player") or 0
			if now >= xpStart then xpGained = xpGained + now - xpStart end
			xpStart = now
		end
		if event == "PLAYER_LEVEL_UP" then xpStart = 0 end
		if event == "TIME_PLAYED_MSG" then playedTotal, playedLevel = ... end
	end,
	init = function()
		WoWAIForever.On("LOCKOUT_CHANGED", function(locked)
			if locked or type(C_DamageMeter) ~= "table" then return end
			for _, name in ipairs({ "GetCombatSessionSummary", "GetCombatSessionDuration", "GetCurrentCombatSessionDuration" }) do
				local fn = C_DamageMeter[name]
				if type(fn) == "function" then
					local ok, value = pcall(fn)
					if ok and type(value) == "table" then
						local dps, damage, duration = tonumber(value.dps), tonumber(value.damage), tonumber(value.duration)
						local parts = {}
						if dps then parts[#parts + 1] = "dps " .. math.floor(dps) end
						if damage then parts[#parts + 1] = "dmg " .. math.floor(damage) end
						if duration then parts[#parts + 1] = math.floor(duration) .. "s" end
						if #parts > 0 then meter = "meter=" .. table.concat(parts, ", "):sub(1, 194); return end
					elseif ok and type(value) == "number" then
						meter = "meter=" .. math.floor(value)
						return
					elseif ok and type(value) == "string" and #value <= 190 then
						meter = "meter=" .. value
						return
					end
				end
			end
		end)
	end,
})
