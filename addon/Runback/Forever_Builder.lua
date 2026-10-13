local function Send(cmd, name)
	name = (name or ""):match("^%s*(.-)%s*$")
	if name == "" then print("Usage: /ai " .. cmd .. " <Name>"); return end
	Runback.Send(name, nil, { cmd = cmd })
end

local frame
local function ShowLoad(slot, name)
	if frame then frame:Hide() end
	frame = CreateFrame("Frame", nil, UIParent, "BackdropTemplate")
	frame:SetSize(190, 42)
	frame:SetPoint("CENTER", UIParent, "CENTER", 0, 180)
	frame:SetFrameStrata("DIALOG")
	local button = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	button:SetSize(170, 26)
	button:SetPoint("CENTER")
	button:SetText("Load " .. name)
	button:SetScript("OnClick", function()
		if InCombatLockdown() or (RunbackForever.Locked and RunbackForever.Locked()) then
			print("[Runback] Load blocked while locked or in combat")
			return
		end
		local loader = C_AddOns and C_AddOns.LoadAddOn or LoadAddOn
		local ok, result = pcall(loader, slot)
		if ok and result ~= false then print("[Runback] Loaded " .. name)
		else print("[Runback] Could not load " .. name .. ": " .. tostring(result)) end
		frame:Hide()
	end)
	frame:Show()
end

RunbackForever.Register({
	name = "builder",
	commands = {
		try = function(rest) Send("try", rest) end,
		promote = function(rest) Send("promote", rest) end,
		builder = function(rest)
			if rest:lower() == "reset" then Runback.Send("reset builder slots", nil, { cmd = "builder-reset" })
			else print("Usage: /ai builder reset") end
		end,
	},
	onReply = function(chat, rec)
		local slot, name = tostring(rec.text or ""):match("%[builder%] slot=(Runback_U%d%d) name=([A-Za-z][A-Za-z0-9_]*)")
		if slot and name then ShowLoad(slot, name) end
	end,
})
