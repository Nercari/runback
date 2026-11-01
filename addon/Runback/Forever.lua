-- Extension registry. Modules are deliberately featureless in this package.
RunbackForever = RunbackForever or { modules = {} }
RunbackForever.modules = RunbackForever.modules or {}
RunbackForever.listeners = RunbackForever.listeners or {}
RunbackForever.skippedEvents = RunbackForever.skippedEvents or {}
function RunbackForever.On(name, fn)
	if type(name) ~= "string" or type(fn) ~= "function" then return end
	local list = RunbackForever.listeners[name] or {}
	RunbackForever.listeners[name] = list
	table.insert(list, fn)
end
function RunbackForever.Fire(name, ...)
	for _, fn in ipairs(RunbackForever.listeners[name] or {}) do pcall(fn, ...) end
end
function RunbackForever.GetChats()
	return (RunbackDB and RunbackDB.chats) or {}
end
-- The dialog and tooltip backdrop textures are see-through whatever their
-- colour: one opaque fill, inside the art border, keeps text off the map.
-- Made once per frame; a re-skin only moves it (UI API only, no hooks replaced).
function RunbackForever.SolidFill(win, inset)
	if type(win) ~= "table" then return end
	inset = tonumber(inset) or 4
	local fill = win.runbackSolidFill
	if not fill then
		fill = win:CreateTexture(nil, "BACKGROUND")
		fill:SetColorTexture(0.03, 0.03, 0.05, 1)
		win.runbackSolidFill = fill
	end
	fill:ClearAllPoints()
	fill:SetPoint("TOPLEFT", win, "TOPLEFT", inset, -inset)
	fill:SetPoint("BOTTOMRIGHT", win, "BOTTOMRIGHT", -inset, inset)
	return fill
end
local frame = CreateFrame("Frame")
local function WantsEvent(events, event)
	if type(events) ~= "table" then return false end
	if events[event] then return true end
	for _, name in ipairs(events) do if name == event then return true end end
	return false
end
function RunbackForever.Register(mod)
	if type(mod) ~= "table" then return end
	table.insert(RunbackForever.modules, mod)
	-- An event this client lacks (retail-only AH events on Forever) errors in RegisterEvent; skip it, keep the rest.
	for key, value in pairs(mod.events or {}) do
		local event = type(key) == "number" and value or key
		if not pcall(frame.RegisterEvent, frame, event) then RunbackForever.skippedEvents[event] = true end
	end
end
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function(_, event, ...)
	local args = { ... }
	local function dispatch()
		for _, mod in ipairs(RunbackForever.modules) do
			if event == "PLAYER_LOGIN" and type(mod.init) == "function" then pcall(mod.init) end
			if WantsEvent(mod.events, event) and type(mod.onEvent) == "function" then pcall(mod.onEvent, event, unpack(args)) end
		end
	end
	if event == "PLAYER_LOGIN" and C_Timer and C_Timer.After then C_Timer.After(0, dispatch) else dispatch() end
end)
