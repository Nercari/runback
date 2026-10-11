-- Combat log reminder (backlog 58). Reviews read the game's combat log, and it is
-- easy to log in with it off and fight for minutes unlogged. At login, if the log
-- is off, one chat line offers [turn on combat log]; after a fight that ended with
-- the log off, the mini bar says "This fight wasn't logged". Nothing here switches
-- the log: only the player's click on the link (WoWAI.CombatLogLinkClicked) or on
-- the Combat log button does, out of combat. Quiet while the AI is off.
local reminded = false

local function LogOff()
	return type(LoggingCombat) == "function" and not LoggingCombat()
end

WoWAIForever.Register({
	name = "combatlog",
	events = { PLAYER_REGEN_ENABLED = true },
	-- init runs once per PLAYER_LOGIN, which the game fires once per UI session.
	init = function()
		if reminded or not LogOff() then return end
		if WoWAIForeverDB and WoWAIForeverDB.off then return end
		reminded = true
		-- Same |Hwowai:...|h link route as the [reply] / [recap this session] links:
		-- the click reaches the addon through its hooksecurefunc on SetItemRef.
		print("|cff7ec8ff[WoW AI]|r The combat log is off, so fights can't be reviewed. "
			.. "|Hwowai:combatlog|h|cff55ff55[turn on combat log]|r|h")
	end,
	onEvent = function()
		WoWAI.unloggedFight = LogOff()
		WoWAI.UpdateMini()
	end,
})
