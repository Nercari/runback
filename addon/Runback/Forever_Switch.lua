local off = false
local function SetOff(value)
	off = value
	RunbackForeverDB = RunbackForeverDB or {}
	RunbackForeverDB.off = off
	RunbackForever.Fire("SWITCH", off)
end

RunbackForever.Register({
	name = "switch",
	blocked = function() return off and "AI is off (/runback on)" or nil end,
	events = { PLAYER_LOGIN = true },
	init = function()
		RunbackForever.On("SWITCH", function(value)
			if Runback and type(Runback.Toggle) == "function" then Runback.Toggle(not value) end
		end)
		if RunbackForeverDB and RunbackForeverDB.off then
			off = true
			print("AI is off (/runback on)")
			RunbackForever.Fire("SWITCH", true)
		end
	end,
	commands = {
		off = function()
			Runback.Send("off", nil, { cmd = "off", force = true })
			SetOff(true)
		end,
		on = function()
			SetOff(false)
			Runback.Send("on", nil, { cmd = "on", force = true })
		end,
	},
})
