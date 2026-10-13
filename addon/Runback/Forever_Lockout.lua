local encounter, challenge, combat, wasLocked = false, false, false, false

local function ChallengeActive()
	local api = C_ChallengeMode
	if type(api) ~= "table" or type(api.GetActiveChallengeMapID) ~= "function" then return false end
	local ok, id = pcall(api.GetActiveChallengeMapID)
	return ok and id ~= nil
end

local function Reason()
	if combat or InCombatLockdown() then return "AI paused in combat" end
	if encounter then return "AI paused during the encounter" end
	if challenge or ChallengeActive() then return "AI paused during the challenge run" end
end

local function Update()
	local reason = Reason()
	local locked = reason ~= nil
	if locked ~= wasLocked then
		wasLocked = locked
		RunbackForever.Fire("LOCKOUT_CHANGED", locked)
	end
end

RunbackForever.Locked = Reason
RunbackForever.Register({
	name = "lockout",
	init = Update,
	events = {
		PLAYER_REGEN_DISABLED = true, PLAYER_REGEN_ENABLED = true,
		ENCOUNTER_START = true, ENCOUNTER_END = true,
		CHALLENGE_MODE_START = true, CHALLENGE_MODE_COMPLETED = true, CHALLENGE_MODE_RESET = true,
	},
	blocked = Reason,
	onEvent = function(event)
		if event == "PLAYER_REGEN_DISABLED" then combat = true end
		if event == "PLAYER_REGEN_ENABLED" then combat = false end
		if event == "ENCOUNTER_START" then encounter = true end
		if event == "ENCOUNTER_END" then encounter = false end
		if event == "CHALLENGE_MODE_START" then challenge = true end
		if event == "CHALLENGE_MODE_COMPLETED" or event == "CHALLENGE_MODE_RESET" then challenge = false end
		Update()
	end,
})
