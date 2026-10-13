-- Session recap offer: once a fight has ended and the player has stayed out of
-- combat for a while, one chat line offers "recap this session". Clicking it puts
-- the question in the box; the player still presses Enter. At most one offer per
-- hour, only after a fight, never in combat, and not while the AI is off. Using
-- the Runback window (open, type, send, click, a reply arriving in it) restarts
-- the quiet spell: no offer within WAIT seconds of the last use.
local WAIT, GAP = 300, 3600
local fights, offeredFights, lastOffer, lastUse, token = 0, 0, nil, nil, 0

local function Now() return type(GetTime) == "function" and GetTime() or 0 end

local Offer
Offer = function(mine)
	if mine ~= token then return end
	if fights == offeredFights then return end
	local wait = lastUse and WAIT - (Now() - lastUse)
	if wait and wait > 0 then
		if C_Timer and C_Timer.After then C_Timer.After(wait, function() Offer(mine) end) end
		return
	end
	if RunbackForever.Locked and RunbackForever.Locked() then return end
	if RunbackForeverDB and RunbackForeverDB.off then return end
	local now = Now()
	if lastOffer and now - lastOffer < GAP then return end
	local c = Runback and Runback.internal and Runback.internal.ActiveChat()
	if not c then return end
	offeredFights, lastOffer = fights, now
	Runback.askText = "Give me a short recap of this session."
	print("|cff7ec8ff[Runback]|r Done for now? |Hrunback:ask:" .. c.id .. "|h|cff55ff55[recap this session]|r|h")
end

RunbackForever.On("LOCKOUT_CHANGED", function(locked)
	token = token + 1
	if locked then fights = fights + 1; return end
	local mine = token
	if C_Timer and C_Timer.After then C_Timer.After(WAIT, function() Offer(mine) end) end
end)

RunbackForever.On("WINDOW_USED", function() lastUse = Now() end)
