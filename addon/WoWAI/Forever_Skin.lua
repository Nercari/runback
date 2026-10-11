local function DB()
	WoWAIForeverDB = WoWAIForeverDB or {}
	WoWAIForeverDB.skin = WoWAIForeverDB.skin or {}
	local s = WoWAIForeverDB.skin
	if s.enabled == nil then s.enabled = true end
	if s.sounds == nil then s.sounds = true end
	if s.minimap == nil then s.minimap = true end
	return s
end

local function Texture(obj, path)
	local ok, loaded = pcall(obj.SetTexture, obj, path)
	if ok and loaded ~= false then return true end
	obj:SetColorTexture(1, 1, 1, 1)
	return false
end

local function Sound(id)
	if type(PlaySound) == "function" and type(id) == "number" then pcall(PlaySound, id) end
end

local function Dialog(frame)
	frame:SetBackdrop({ bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
		edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border", tile = true, tileSize = 32,
		edgeSize = 32, insets = { left = 11, right = 11, top = 11, bottom = 11 } })
	frame:SetBackdropColor(1, 1, 1, 0.95)
	frame:SetBackdropBorderColor(1, 1, 1, 1)
	-- UI-DialogBox-Background is see-through: a solid dark fill, inside the 11px
	-- border, keeps the map and grass from showing through the reply text.
	-- Made once per frame; a re-skin only moves it (UI API only, no hooks replaced).
	local fill = frame.wowaiSolidFill
	if not fill then
		fill = frame:CreateTexture(nil, "BACKGROUND")
		fill:SetColorTexture(0.03, 0.03, 0.05, 1)
		frame.wowaiSolidFill = fill
	end
	fill:ClearAllPoints()
	fill:SetPoint("TOPLEFT", frame, "TOPLEFT", 11, -11)
	fill:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", -11, 11)
end

local function Tooltip(frame)
	frame:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16,
		edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
	frame:SetBackdropColor(0, 0, 0, 0.55)
	frame:SetBackdropBorderColor(0.8, 0.8, 0.8, 0.9)
end

local function StyleHeader(parts)
	if not parts.title then return end
	local plaque = parts.frame:CreateTexture(nil, "ARTWORK")
	plaque:SetSize(256, 64)
	plaque:SetPoint("TOP", parts.frame, "TOP", 0, 12)
	Texture(plaque, "Interface\\DialogFrame\\UI-DialogBox-Header")
	parts.title:ClearAllPoints()
	parts.title:SetPoint("TOP", plaque, "TOP", 0, -14)
	-- Keep a long chat name inside the plaque instead of running over its border.
	parts.title:SetWidth(150)
	parts.title:SetJustifyH("CENTER")
	parts.title:SetFontObject("GameFontNormal")
	parts.header = plaque
end

local function ChatTitle()
	local c = WoWAI and WoWAI.internal and WoWAI.internal.ActiveChat()
	return c and c.name or "WoW AI"
end

local function BlockReason()
	if WoWAIForeverDB and WoWAIForeverDB.off then return "AI is off" end
	for _, mod in ipairs(WoWAIForever.modules or {}) do
		if type(mod.blocked) == "function" then
			local ok, reason = pcall(mod.blocked)
			if ok and reason then return tostring(reason) end
		end
	end
end

local function Skin(parts)
	if not DB().enabled or not parts or not parts.frame then return end
	Dialog(parts.frame)
	if parts.mini then Dialog(parts.mini) end
	for _, key in ipairs({ "panel", "menu", "inputBg" }) do if parts[key] then Tooltip(parts[key]) end end
	StyleHeader(parts)
	parts.title:SetText(ChatTitle())
	parts.title:SetTextColor(1, 0.82, 0)
end

local function ColorSpeaker(b)
	if b.who.skinColoring then return end
	b.who.skinColoring = true
	local role = tostring(b.who:GetText() or "")
	if role == "You" then
		local class
		if type(UnitClass) == "function" then local ignored; ignored, class = UnitClass("player") end
		local colors = type(RAID_CLASS_COLORS) == "table" and RAID_CLASS_COLORS
		local color = colors and colors[class]
		if color then b.who:SetTextColor(color.r or color[1], color.g or color[2], color.b or color[3]) end
	elseif role == "System" then
		b.who:SetTextColor(1, 1, 0)
	else
		local color = type(NORMAL_FONT_COLOR) == "table" and NORMAL_FONT_COLOR
		if color then
			b.who:SetTextColor(color.r or color[1], color.g or color[2], color.b or color[3])
		else
			b.who:SetTextColor(1, 0.82, 0)
		end
	end
	b.who.skinColoring = nil
end

local function SkinBubble(b)
	if not DB().enabled or not b then return end
	if b.bg then b.bg:SetAlpha(0) end
	if b.accent then b.accent:SetAlpha(0) end
	if b.who and not b.who.skinHooked and type(hooksecurefunc) == "function" then
		hooksecurefunc(b.who, "SetTextColor", function() ColorSpeaker(b) end)
		b.who.skinHooked = true
	end
	if b.who then ColorSpeaker(b) end
	if not b.divider then
		b.divider = b:CreateTexture(nil, "BORDER")
		b.divider:SetHeight(1); b.divider:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 0)
		b.divider:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", 0, 0)
		if not Texture(b.divider, "Interface\\Common\\UI-TooltipDivider-Transparent") then
			b.divider:SetColorTexture(1, 1, 1, 0.08)
		end
	end
end

local minimapButton
local function PositionButton()
	local angle = math.rad(DB().minimapAngle or 200)
	-- On the rim whatever the minimap's size (a 140px minimap gives the old 80).
	local width = type(Minimap.GetWidth) == "function" and Minimap:GetWidth() or 0
	-- The minimap can report no size yet at login; fall back to the default 140.
	if width < 50 then width = 140 end
	local radius = width / 2 + 10
	minimapButton:ClearAllPoints()
	minimapButton:SetPoint("CENTER", Minimap, "CENTER",
		math.cos(angle) * radius, math.sin(angle) * radius)
end

local function Angle(y, x)
	if type(math.atan2) == "function" then return math.atan2(y, x) end
	if x > 0 then return math.atan(y / x) end
	if x < 0 then return math.atan(y / x) + (y >= 0 and math.pi or -math.pi) end
	return y > 0 and math.pi / 2 or (y < 0 and -math.pi / 2 or 0)
end

local function MakeMinimap()
	local s = DB()
	if minimapButton then
		minimapButton:SetShown(s.enabled and s.minimap)
		return
	end
	if not s.enabled or not s.minimap or type(Minimap) ~= "table" then return end
	local b = CreateFrame("Button", "WoWAIForeverMinimap", Minimap)
	minimapButton = b
	b:SetSize(31, 31)
	b:SetFrameLevel((Minimap.GetFrameLevel and Minimap:GetFrameLevel() or 1) + 2)
	local bg = b:CreateTexture(nil, "BACKGROUND")
	bg:SetSize(20, 20); bg:SetPoint("CENTER")
	Texture(bg, "Interface\\Minimap\\UI-Minimap-Background")
	local icon = b:CreateTexture(nil, "ARTWORK")
	icon:SetSize(20, 20); icon:SetPoint("CENTER")
	Texture(icon, "Interface\\Icons\\INV_Misc_Book_09")
	local border = b:CreateTexture(nil, "OVERLAY")
	border:SetSize(53, 53); border:SetPoint("TOPLEFT", b, "TOPLEFT")
	Texture(border, "Interface\\Minimap\\MiniMap-TrackingBorder")
	local hi = b:CreateTexture(nil, "HIGHLIGHT")
	hi:SetAllPoints()
	Texture(hi, "Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
	local dot = b:CreateTexture(nil, "OVERLAY")
	dot:SetSize(8, 8); dot:SetPoint("TOPRIGHT", b, "TOPRIGHT", -2, -2)
	Texture(dot, "Interface\\COMMON\\Indicator-Yellow")
	b.unreadDot = dot
	dot:Hide()
	b:SetMovable(true)
	b:EnableMouse(true)
	b:RegisterForDrag("LeftButton")
	b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	b:SetScript("OnClick", function(_, button)
		if button == "RightButton" then
			local chats = WoWAI.internal.Chats(); local target
			for _, c in ipairs(chats) do if c.name:lower() == "mentor" then target = c; break end end
			if target then WoWAI.internal.SwitchChat(target.id) end
			WoWAI.Toggle(true)
			if WoWAIInput then WoWAIInput:SetFocus() end
		else WoWAI.Toggle() end
	end)
	b:SetScript("OnDragStart", function(self) self:StartMoving() end)
	b:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local x, y = self:GetCenter()
		local cx, cy = Minimap:GetCenter()
		if x and y and cx and cy then s.minimapAngle = math.deg(Angle(y - cy, x - cx)) end
		PositionButton()
	end)
	b:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("WoW AI", 1, 0.82, 0)
		GameTooltip:AddLine("Left-click: open or close")
		GameTooltip:AddLine("Right-click: mentor chat")
		GameTooltip:AddLine("Drag: move")
		local reason = BlockReason()
		if reason then GameTooltip:AddLine(tostring(reason), 1, 0.2, 0.2) end
		GameTooltip:Show()
	end)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b:SetScript("OnShow", PositionButton) -- the minimap may have been resized while it was hidden
	PositionButton()
end

local function Command(rest, command)
	local on = rest == "on"
	if rest ~= "on" and rest ~= "off" then
		print("Usage: /ai " .. command .. " on|off")
		return
	end
	local settings = DB()
	if command == "skin" then
		settings.enabled = on
		print("Reload to apply")
	else
		settings.minimap = on
		MakeMinimap()
		print("Minimap button " .. (on and "enabled" or "disabled"))
	end
end

WoWAIForever.Register({ name = "skin", commands = { skin = function(rest) Command(rest, "skin") end,
	minimap = function(rest) Command(rest, "minimap") end },
	onReply = function(_, rec)
		if DB().sounds and rec.status == "done" and WoWAIFrame and not WoWAIFrame:IsShown() then
			if type(SOUNDKIT) == "table" and type(SOUNDKIT.TELL_MESSAGE) == "number" then
				Sound(SOUNDKIT.TELL_MESSAGE)
			end
			if minimapButton and minimapButton.unreadDot then minimapButton.unreadDot:Show() end
		end
	end })
WoWAIForever.On("UI_BUILT", function(parts)
	Skin(parts); MakeMinimap()
	if not parts.frame.skinSounds then
		parts.frame:HookScript("OnShow", function()
			if DB().sounds and type(SOUNDKIT) == "table" and type(SOUNDKIT.IG_CHARACTER_INFO_OPEN) == "number" then
				Sound(SOUNDKIT.IG_CHARACTER_INFO_OPEN)
			end
		end)
		parts.frame:HookScript("OnHide", function()
			if DB().sounds and type(SOUNDKIT) == "table" and type(SOUNDKIT.IG_CHARACTER_INFO_CLOSE) == "number" then
				Sound(SOUNDKIT.IG_CHARACTER_INFO_CLOSE)
			end
		end)
		parts.frame.skinSounds = true
	end
	if type(hooksecurefunc) == "function" and WoWAI then
		hooksecurefunc(WoWAI, "Toggle", function(show)
			if WoWAIFrame and WoWAIFrame:IsShown() and minimapButton and minimapButton.unreadDot then
				minimapButton.unreadDot:Hide()
			end
		end)
		hooksecurefunc(WoWAI, "SwitchChat", function()
			if parts.title then parts.title:SetText(ChatTitle()) end
		end)
		hooksecurefunc(WoWAI, "RenderChatList", function()
			local color = type(NORMAL_FONT_COLOR) == "table" and NORMAL_FONT_COLOR
			for _, row in ipairs(parts.chatButtons or {}) do
				if row.label then
					if row.selected and row.selected:IsShown() and color then
						row.label:SetTextColor(color.r or color[1], color.g or color[2], color.b or color[3])
					else
						row.label:SetFontObject("GameFontHighlightSmall")
						row.label:SetTextColor(1, 1, 1)
					end
				end
			end
		end)
	end
end)
WoWAIForever.On("BUBBLE_BUILT", SkinBubble)
WoWAIForever.On("CHAT_ROW_BUILT", function(row)
	if not DB().enabled then return end
	if row.label then row.label:SetFontObject("GameFontHighlightSmall") end
	if row.selected then
		Texture(row.selected, "Interface\\QuestFrame\\UI-QuestTitleHighlight")
		row.selected:SetBlendMode("ADD"); row.selected:SetVertexColor(1, 0.82, 0)
	end
	local hi = row:CreateTexture(nil, "HIGHLIGHT"); hi:SetAllPoints()
	Texture(hi, "Interface\\QuestFrame\\UI-QuestTitleHighlight"); hi:SetBlendMode("ADD")
end)
WoWAIForever.On("COPY_BUILT", function(frame)
	if not DB().enabled then return end
	-- The copy box already has its own solid fill: Dialog() reuses it and pulls it
	-- inside the wider dialog border.
	if WoWAICopyFill then frame.wowaiSolidFill = WoWAICopyFill end
	Dialog(frame)
end)
