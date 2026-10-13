local banner = nil

local function EnsureBanner()
	if banner then return banner end
	banner = CreateFrame("Frame", "RunbackPolicyBanner", UIParent, "BackdropTemplate")
	banner:SetSize(520, 60)
	-- Below the mini bar (TOP -40, 30 tall) so the two never overlap.
	banner:SetPoint("TOP", UIParent, "TOP", 0, -90)
	banner:SetFrameStrata("HIGH")
	banner:SetClampedToScreen(true)
	if type(UISpecialFrames) == "table" then tinsert(UISpecialFrames, "RunbackPolicyBanner") end -- Esc closes it
	if type(banner.SetBackdrop) == "function" then
		banner:SetBackdrop({
			bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 16,
			insets = { left = 4, right = 4, top = 4, bottom = 4 },
		})
		if type(banner.SetBackdropColor) == "function" then
			banner:SetBackdropColor(0.12, 0.04, 0.04, 0.95)
		end
		if type(banner.SetBackdropBorderColor) == "function" then
			banner:SetBackdropBorderColor(0.8, 0.2, 0.2, 1)
		end
	end
	local text = banner:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	text:SetPoint("TOPLEFT", banner, "TOPLEFT", 12, -10)
	text:SetPoint("BOTTOMRIGHT", banner, "BOTTOMRIGHT", -90, 10)
	text:SetJustifyH("LEFT")
	text:SetWordWrap(true)
	banner.msgText = text

	local dismiss = CreateFrame("Button", nil, banner, "UIPanelButtonTemplate")
	dismiss:SetSize(70, 24)
	dismiss:SetPoint("RIGHT", banner, "RIGHT", -10, 0)
	dismiss:SetText("Dismiss")
	dismiss:SetScript("OnClick", function() banner:Hide() end)
	banner.dismiss = dismiss

	banner:Hide()
	return banner
end

local function OnReply(chat, rec)
	if not rec or type(rec.text) ~= "string" then return end
	if rec.text:sub(1, 9) == "[policy] " then
		print(rec.text)
		local b = EnsureBanner()
		if b.msgText then
			b.msgText:SetText(rec.text)
		end
		b:Show()
	end
end

RunbackForever.Register({
	name = "banner",
	onReply = OnReply,
})
