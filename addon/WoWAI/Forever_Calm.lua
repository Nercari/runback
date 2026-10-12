-- No AI advice on screen during a fight: when the lockout starts (combat,
-- encounter, challenge run) an open window folds into the small bar, and it
-- opens again when the lockout ends. Only the window's own show/hide is used.
-- If the player opens or closes it by hand meanwhile, that choice wins, but the
-- reply area then shows one "Replies are hidden during combat" line (backlog 79):
-- each lockout change re-renders it, and the copy box closes when a fight starts.
local folded = false

WoWAIForever.On("LOCKOUT_CHANGED", function(locked)
	local w = WoWAI
	local db = WoWAIDB
	if not (w and db and db.settings) then return end
	if locked then
		if db.settings.shown and not db.settings.minimized then
			folded = true
			w.Minimize(true)
		end
	elseif folded then
		folded = false
		if db.settings.shown and db.settings.minimized then w.Minimize(false) end
	end
	if locked and WoWAICopy then WoWAICopy:Hide() end
	w.Render()
end)
