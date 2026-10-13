local macroFrame = nil
local macroButtons = {}

StaticPopupDialogs["RUNBACK_OVERWRITE_MACRO"] = {
	text = "Overwrite macro %s?",
	button1 = OKAY or "Okay",
	button2 = CANCEL or "Cancel",
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if InCombatLockdown and InCombatLockdown() then
			print("Can't create macros in combat")
			return
		end
		if type(EditMacro) ~= "function" then
			print("Macro API not available")
			return
		end
		local ok, err = pcall(EditMacro, data.index, data.name, data.icon, data.body)
		if ok then
			print("Macro " .. tostring(data.name) .. " updated")
		else
			print("Failed to update macro: " .. tostring(err))
		end
	end,
}

local function HasForbiddenCommand(body)
	local lower = body:lower()
	for _, cmd in ipairs({ "/run", "/script", "/console", "/dump" }) do
		if lower:find(cmd, 1, true) then
			return cmd
		end
	end
	return nil
end

local function SaveMacro(name, icon, body)
	if InCombatLockdown and InCombatLockdown() then
		print("Can't create macros in combat")
		return
	end
	if #body > 255 then
		print("Macro body exceeds 255 characters (" .. #body .. ")")
		return
	end
	local forbidden = HasForbiddenCommand(body)
	if forbidden then
		print("Macro rejected: contains " .. forbidden)
		return
	end
	local index = 0
	if type(GetMacroIndexByName) == "function" then
		local ok, idx = pcall(GetMacroIndexByName, name)
		if ok and type(idx) == "number" then
			index = idx
		end
	end
	if index > 0 then
		if type(StaticPopup_Show) == "function" then
			StaticPopup_Show("RUNBACK_OVERWRITE_MACRO", name, nil, {
				index = index,
				name = name,
				icon = icon,
				body = body,
			})
		end
	else
		if type(CreateMacro) ~= "function" then
			print("Macro API not available")
			return
		end
		local ok, res = pcall(CreateMacro, name, icon or "INV_Misc_QuestionMark", body, nil)
		if ok and res then
			print("Created macro " .. tostring(name))
		else
			print("Failed to create macro: " .. tostring(res))
		end
	end
end

local function ParseMacroHeader(header)
	local name = header:match('name="([^"]+)"') or header:match("name=(%S+)")
	local icon = header:match('icon="([^"]+)"') or header:match("icon=(%S+)")
	return name, icon
end

local function FindBlocks(text)
	local blocks = {}
	if type(text) ~= "string" then return blocks end
	local inBlock = false
	local header = nil
	local lines = {}
	for line in (text .. "\n"):gmatch("(.-)\r?\n") do
		if not inBlock then
			local h = line:match("^```%s*macro%s*(.-)$")
			if h then
				inBlock = true
				header = h
				lines = {}
			end
		else
			if line:match("^```%s*$") then
				inBlock = false
				local name, icon = ParseMacroHeader(header or "")
				if name and name ~= "" then
					table.insert(blocks, {
						name = name,
						icon = icon,
						body = table.concat(lines, "\n"),
					})
				end
				header = nil
				lines = {}
			else
				table.insert(lines, line)
			end
		end
	end
	return blocks
end

local function EnsureMacroFrame()
	if macroFrame then return macroFrame end
	local parent = RunbackFrame or UIParent
	macroFrame = CreateFrame("Frame", "RunbackMacroFrame", parent)
	macroFrame:SetSize(220, 30)
	macroFrame:SetPoint("TOPLEFT", parent, "BOTTOMLEFT", 0, -4)
	return macroFrame
end

local function ShowMacroButtons(blocks)
	local mf = EnsureMacroFrame()
	for _, btn in ipairs(macroButtons) do
		btn:Hide()
	end
	if #blocks == 0 then
		mf:Hide()
		return
	end
	local y = 0
	for i, b in ipairs(blocks) do
		local btn = macroButtons[i]
		if not btn then
			btn = CreateFrame("Button", nil, mf, "UIPanelButtonTemplate")
			macroButtons[i] = btn
		end
		btn:SetHeight(24)
		btn:SetText("Create macro " .. b.name)
		local fs = btn:GetFontString()
		local textW = fs and fs:GetStringWidth() or 100
		btn:SetWidth(math.max(140, textW + 20))
		btn:ClearAllPoints()
		btn:SetPoint("TOPLEFT", mf, "TOPLEFT", 0, -y)
		local blockName, blockIcon, blockBody = b.name, b.icon, b.body
		btn:SetScript("OnClick", function()
			SaveMacro(blockName, blockIcon, blockBody)
		end)
		btn:Show()
		y = y + 26
	end
	mf:SetHeight(math.max(30, y))
	mf:Show()
end

local function OnReply(chat, rec)
	if not rec or type(rec.text) ~= "string" then return end
	local blocks = FindBlocks(rec.text)
	ShowMacroButtons(blocks)
end

RunbackForever.Register({
	name = "macro",
	onReply = OnReply,
})
