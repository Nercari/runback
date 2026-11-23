-- Build the Runback window and wire its controls.
local Runback = _G.Runback

---------------------------------------------------------------------------
-- UI
---------------------------------------------------------------------------

local function MakeButton(parent, label, width, onClick)
	local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local PANEL_W = 150

function Runback.BuildUI(ui, deps)
	local ActiveChat, FindChat, AddHistory = deps.ActiveChat, deps.FindChat, deps.AddHistory
	local ChatAgent, ChatModel, ChatEffort = deps.ChatAgent, deps.ChatModel, deps.ChatEffort
	local EffortsFor, DefaultEffortFor = deps.EffortsFor, deps.DefaultEffortFor
	local Display, SafeReload, WindowUsed = deps.Display, deps.SafeReload, deps.WindowUsed
	local BACKDROP, MAX_CHATS = deps.BACKDROP, deps.MAX_CHATS
	if ui.frame then return end
	local s = deps.GetDB().settings

	local f = CreateFrame("Frame", "RunbackFrame", UIParent, "BackdropTemplate")
	ui.frame = f
	f:HookScript("OnMouseDown", WindowUsed)
	f:SetSize(s.width, s.height)
	if s.point then
		f:SetPoint(s.point, UIParent, s.relPoint or s.point, s.x or 0, s.y or 0)
	else
		-- Top centre: clear of the game chat (bottom left) and the quest tracker (right).
		f:SetPoint("TOP", UIParent, "TOP", 0, -40)
	end
	f:SetFrameStrata("DIALOG")
	f:SetMovable(true)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(560, 300)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.point, s.relPoint, s.x, s.y = point, relPoint, x, y
	end)
	f:SetBackdrop(BACKDROP)
	f:SetBackdropColor(0.03, 0.03, 0.05, 1)
	f:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	f:Hide()
	tinsert(UISpecialFrames, "RunbackFrame")

	-- Status light: green = bridge seen recently, yellow = stale, red = gone.
	local function MakeDot(parent)
		local holder = CreateFrame("Frame", nil, parent)
		holder:SetSize(16, 16)
		local dot = holder:CreateTexture(nil, "OVERLAY")
		dot:SetAllPoints()
		dot:SetTexture("Interface\\FriendsFrame\\StatusIcon-Offline")
		holder:EnableMouse(true)
		holder:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(dot.tip or "Bridge status", 0.9, 0.9, 0.9, 1, true)
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end

	local dotHolder, dot = MakeDot(f)
	dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -16)
	ui.dot = dot

	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	title:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0)
	-- Stop short of the minimize button: a long chat name is cut, not drawn over the border.
	title:SetPoint("RIGHT", f, "TOPRIGHT", -60, -24)
	title:SetJustifyH("LEFT")
	title:SetWordWrap(false)
	title:SetText("Runback")
	ui.title = title

	local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -34)
	status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	status:SetJustifyH("LEFT")
	ui.status = status

	-- Stalled run (backlog 52): both are the player's own click.
	local askBtn = MakeButton(f, "Ask another agent", 144, function() Runback.AskOtherAgent() end)
	askBtn:SetPoint("TOPRIGHT", f, "TOPRIGHT", -34, -28)
	askBtn:Hide()
	ui.askBtn = askBtn
	local stopBtn = MakeButton(f, "Stop", 54, function() Runback.StopRun() end)
	stopBtn:SetPoint("RIGHT", askBtn, "LEFT", -4, 0)
	stopBtn:Hide()
	ui.stopBtn = stopBtn

	-- Minimize button in the corner where a close X would be: this window is never
	-- closed from here, only collapsed to the mini bar (Esc does the same, see OnHide).
	-- The mini bar's own X is the one that hides everything.
	local mini
	if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("RedButton-MiniCondense") then
		-- Blizzard's own minimize button: the close button's chrome with a "condense" glyph.
		local ok, b = pcall(CreateFrame, "Button", nil, f, "UIPanelHideButtonNoScripts")
		if ok and b then mini = b end
	end
	if not mini then
		-- Older art: draw a dash on a plain button.
		mini = CreateFrame("Button", nil, f)
		mini:SetSize(24, 24)
		local dash = mini:CreateTexture(nil, "ARTWORK")
		dash:SetSize(10, 2)
		dash:SetPoint("CENTER", mini, "CENTER", 0, -3)
		dash:SetColorTexture(0.9, 0.9, 0.9, 1)
		local hl = mini:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.15)
	end
	mini:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
	mini:SetScript("OnClick", function() Runback.Minimize(true) end)
	mini:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Minimize to the small bar  (Esc)")
		GameTooltip:AddLine("The agent keeps working; the bar shows when a reply lands.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	mini:SetScript("OnLeave", function() GameTooltip:Hide() end)

	-- Esc (via UISpecialFrames) just calls Hide(); treat that as a minimize unless
	-- we're hiding on purpose. Ignore hides caused by the whole UI going away.
	f:SetScript("OnHide", function()
		if ui.quitting then
			ui.quitting = nil
			return
		end
		local db = deps.GetDB()
		if not db or not db.settings.shown or not UIParent:IsShown() then return end
		db.settings.minimized = true
		if ui.mini then ui.mini:Show() end
		Runback.UpdateMini()
	end)

	-- Left panel: chat list
	local panel = CreateFrame("Frame", "RunbackChatPanel", f, "BackdropTemplate")
	ui.chatPanel = panel
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -52)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 50)
	panel:SetWidth(PANEL_W)
	panel:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	panel:SetBackdropColor(0, 0, 0, 0.4)
	panel:SetBackdropBorderColor(0.4, 0.4, 0.4, 1)

	local newBtn = MakeButton(panel, "+ New chat", PANEL_W - 16, function() Runback.NewChat() end)
	newBtn:SetPoint("TOP", panel, "TOP", 0, -8)

	-- Per-chat menu: Rename, Folder and Agent, opened by right-clicking a chat
	-- row. A plain frame of our own rather than a Blizzard dropdown, so it looks
	-- the same on every client.
	local menu = CreateFrame("Frame", "RunbackChatMenu", f, "BackdropTemplate")
	menu:SetSize(110, 4 * 20 + 12)
	menu:SetFrameStrata("TOOLTIP")
	menu:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	menu:SetBackdropColor(0.08, 0.08, 0.1, 1)
	menu:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	menu:EnableMouse(true)
	menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
	menu.title:SetPoint("RIGHT", menu, "RIGHT", -8, 0)
	menu.title:SetJustifyH("LEFT")
	menu.title:SetWordWrap(false)
	local function MenuItem(label, order, onClick)
		local it = CreateFrame("Button", nil, menu)
		it:SetSize(110 - 12, 20)
		it:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -6 - order * 20)
		local hl = it:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		it.label = it:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		it.label:SetPoint("LEFT", it, "LEFT", 6, 0)
		it.label:SetText(label)
		it:SetScript("OnClick", function()
			menu:Hide()
			onClick(menu.chatId, menu.owner)
		end)
		return it
	end
	MenuItem("Rename...", 1, Runback.RenamePrompt)
	MenuItem("Folder...", 2, Runback.FolderPrompt)
	MenuItem("AI / model...", 3, Runback.AgentPrompt)
	-- Close once the mouse has wandered away from the menu and the row it came from.
	menu:SetScript("OnUpdate", function(self, dt)
		if not MouseIsOver then return end
		if MouseIsOver(self) or (self.owner and MouseIsOver(self.owner)) then
			self.away = 0
		else
			self.away = (self.away or 0) + dt
			if self.away > 0.5 then self:Hide() end
		end
	end)
	menu:Hide()
	ui.chatMenu = menu

	-- AI picker: the agents installed on the bridge PC and their models, one
	-- click to switch the chat. Opened from the AI button under the chat or the
	-- chat row's menu. Same plain frame as the chat menu.
	local picker = CreateFrame("Frame", "RunbackPoolPicker", f, "BackdropTemplate")
	picker:SetFrameStrata("TOOLTIP")
	picker:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	picker:SetBackdropColor(0.08, 0.08, 0.1, 1)
	picker:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	picker:EnableMouse(true)
	picker.title = picker:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	picker.title:SetPoint("TOPLEFT", picker, "TOPLEFT", 10, -8)
	picker.title:SetJustifyH("LEFT")
	picker.rows = {}
	local PICK_W, PICK_ROW, PICK_MAX = 210, 18, 32
	local FillPicker
	local function PickerRow(i)
		local it = picker.rows[i]
		if it then return it end
		it = CreateFrame("Button", nil, picker)
		it:SetSize(PICK_W - 12, PICK_ROW)
		it:SetPoint("TOPLEFT", picker, "TOPLEFT", 6, -24 - (i - 1) * PICK_ROW)
		local hl = it:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		it.label = it:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		it.label:SetPoint("LEFT", it, "LEFT", 6, 0)
		it.label:SetJustifyH("LEFT")
		it:SetScript("OnClick", function(self)
			local c = FindChat(picker.chatId)
			if self.kind == "head" then return end
			if self.kind == "toggle" then
				picker.exact = not picker.exact
				if c then FillPicker(c) end
				return
			end
			picker:Hide()
			if self.blocked then
				-- Greyed: say the bridge's own reason, change nothing.
				if c then
					AddHistory(c, "system", Display(self.name):gsub("^%s+", "") .. " can't be picked: " .. Display(self.blocked))
					Runback.Render()
				end
				return
			end
			Runback.SetPool(c, self.agent, self.model)
		end)
		picker.rows[i] = it
		return it
	end
	-- The effort row (backlog 45): the levels of the chat's model as small buttons
	-- under the list, the default marked with *, the chosen one green. A click picks
	-- that level; clicking the chosen one goes back to the model's default.
	picker.effortLabel = picker:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	picker.effortLabel:SetJustifyH("LEFT")
	picker.levels = {}
	local function EffortButton(i)
		local b = picker.levels[i]
		if b then return b end
		b = CreateFrame("Button", nil, picker)
		b:SetHeight(PICK_ROW)
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		b.label:SetPoint("CENTER", b, "CENTER", 0, 0)
		b:SetScript("OnClick", function(self)
			picker:Hide()
			local c = FindChat(picker.chatId)
			if not c then return end
			Runback.SetPool(c, c.agent, ChatModel(c), self.effort == ChatEffort(c) and "" or self.effort)
		end)
		picker.levels[i] = b
		return b
	end
	picker:SetScript("OnUpdate", menu:GetScript("OnUpdate"))
	picker:Hide()
	ui.picker = picker

	-- Draw the rows and the effort buttons for chat c; the picker size follows.
	function FillPicker(c)
		local choices = Runback.PoolChoices(c, picker.exact)
		local n = math.min(#choices, PICK_MAX)
		for i = 1, n do
			local ch, it = choices[i], PickerRow(i)
			local current = not ch.blocked and ((ch.kind == "agent" and ch.agent == (c.agent or "") and ch.model == ChatModel(c))
				or ((ch.kind == "role" or ch.kind == "exact") and ch.model ~= "" and ch.agent == ChatAgent(c) and ch.model == ChatModel(c)))
			it.kind, it.agent, it.model, it.blocked, it.name = ch.kind, ch.agent, ch.model, ch.blocked, ch.label
			local color = current and "|cff55ff55> " or (ch.kind == "head" and "|cffaaaaaa" or (ch.blocked and "|cff808080  " or "|cffffffff  "))
			local why = ch.blocked and (ch.kind == "role" and " (not offered)" or " (can't run)") or ""
			it.label:SetText(color .. Display(ch.label) .. why .. "|r")
			it:Show()
		end
		for i = n + 1, #picker.rows do picker.rows[i]:Hide() end
		local model = ChatModel(c)
		local levels = (c.agent and c.agent ~= "" and model ~= "") and EffortsFor(c.agent, model) or {}
		local default, x, y = DefaultEffortFor(c.agent, model), 6, -24 - n * PICK_ROW
		picker.effortLabel:ClearAllPoints()
		picker.effortLabel:SetPoint("TOPLEFT", picker, "TOPLEFT", 10, y - 4)
		picker.effortLabel:SetText(#levels > 0 and ("Effort for " .. Display(model) .. ":") or "")
		local shown = 0
		for i, e in ipairs(levels) do
			local text = e .. (e == default and "*" or "")
			if x + 8 + 6 * #text > PICK_W - 6 then break end -- what does not fit stays typed-only
			shown = i
			local b = EffortButton(i)
			b.effort = e
			b.label:SetText((e == ChatEffort(c) and "|cff55ff55" or "|cffffffff") .. text .. "|r")
			b:SetWidth(8 + 6 * #text)
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", picker, "TOPLEFT", x, y - PICK_ROW)
			x = x + 8 + 6 * #text + 2
			b:Show()
		end
		for i = shown + 1, #picker.levels do picker.levels[i]:Hide() end
		picker.title:SetText(deps.GetBridgeAgents() and ("AI for " .. Display(c.name)) or "AI for this chat (connect to see what this PC has)")
		picker:SetSize(PICK_W, 30 + n * PICK_ROW + (#levels > 0 and 2 * PICK_ROW or 0))
	end

	function Runback.ShowPicker(chatId, anchor)
		local c = FindChat(chatId)
		if not c then return end
		if picker:IsShown() and picker.chatId == chatId then
			picker:Hide()
			return
		end
		-- Never in combat: it closes when a fight starts and waits for the end.
		if InCombatLockdown() then
			AddHistory(c, "system", "The AI picker opens after the fight.")
			Runback.Render()
			return
		end
		picker.exact = false
		FillPicker(c)
		picker.chatId = chatId
		picker.owner = anchor
		picker.away = 0
		picker:ClearAllPoints()
		if anchor and anchor ~= ui.pool then
			picker:SetPoint("TOPLEFT", anchor, "TOPRIGHT", 4, 0)
		else
			picker:SetPoint("BOTTOMLEFT", ui.pool or f, "TOPLEFT", 0, 4)
		end
		picker:Show()
	end

	function Runback.ShowChatMenu(chatId, anchor)
		local c = FindChat(chatId)
		if not c then return end
		if menu:IsShown() and menu.chatId == chatId then
			menu:Hide()
			return
		end
		menu.chatId = chatId
		menu.owner = anchor
		menu.away = 0
		menu.title:SetText(Display(c.name))
		menu:ClearAllPoints()
		menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 8, 2)
		menu:Show()
	end

	-- The list shows only the rows that fit the panel (see RenderChatList); the
	-- wheel moves the window over the chats, and a resize re-fits it.
	ui.chatOffset = 0
	panel:EnableMouseWheel(true)
	panel:SetScript("OnMouseWheel", function(_, delta)
		ui.chatOffset = (ui.chatOffset or 0) - (delta > 0 and 1 or -1)
		Runback.RenderChatList()
	end)
	panel:HookScript("OnSizeChanged", function()
		ui.chatSeenActive = nil -- re-fit around the active chat
		Runback.RenderChatList()
	end)

	ui.chatButtons = {}
	for i = 1, MAX_CHATS do
		local b = CreateFrame("Button", nil, panel)
		b:SetSize(PANEL_W - 16, 20)
		b:SetPoint("TOP", newBtn, "BOTTOM", 0, -6 - (i - 1) * 21)
		b.selected = b:CreateTexture(nil, "BACKGROUND")
		b.selected:SetAllPoints()
		b.selected:SetColorTexture(1, 1, 1, 0.12)
		b.selected:Hide()
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.08)

		-- Trash can: delete this chat (asks first). Blizzard's red delete button
		-- where the client has it, a plain X elsewhere.
		b.del = CreateFrame("Button", nil, b)
		b.del:SetSize(16, 16)
		b.del:SetPoint("RIGHT", b, "RIGHT", -2, 0)
		if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("128-RedButton-Delete") then
			b.del:SetNormalAtlas("128-RedButton-Delete")
			b.del:SetPushedAtlas("128-RedButton-Delete-Pressed")
			b.del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
		else
			b.del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
			b.del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
		end
		b.del:SetAlpha(0.6)
		b.del:SetScript("OnClick", function() Runback.ConfirmDelete(b.chatId) end)
		b.del:SetScript("OnEnter", function(self)
			self:SetAlpha(1)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText("Delete this chat")
			GameTooltip:Show()
		end)
		b.del:SetScript("OnLeave", function(self)
			self:SetAlpha(0.6)
			GameTooltip:Hide()
		end)

		b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		b.label:SetPoint("LEFT", b, "LEFT", 6, 0)
		b.label:SetPoint("RIGHT", b.del, "LEFT", -4, 0)
		b.label:SetJustifyH("LEFT")
		b.label:SetWordWrap(false)
		-- Left-click switches to the chat; right-click opens its menu (Rename,
		-- Folder, Agent). A second right-click on the same row closes the menu again.
		b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		b:SetScript("OnClick", function(self, button)
			if button == "RightButton" then
				Runback.ShowChatMenu(self.chatId, self)
			else
				Runback.SwitchChat(self.chatId)
			end
		end)
		b:SetScript("OnDoubleClick", function(self)
			Runback.SwitchChat(self.chatId)
			Runback.RenamePrompt(self.chatId)
		end)
		b:Hide()
		ui.chatButtons[i] = b
		if RunbackForever and RunbackForever.Fire then RunbackForever.Fire("CHAT_ROW_BUILT", b) end
	end

	-- Transcript: a scrolling stack of message bubbles
	local scroll = CreateFrame("ScrollFrame", "RunbackScroll", f, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", panel, "TOPRIGHT", 8, 0)
	scroll:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -32, 110)
	ui.scroll = scroll

	local content = CreateFrame("Frame", "RunbackContent", scroll)
	content:SetSize(500, 1)
	scroll:SetScrollChild(content)
	ui.content = content
	ui.bubbles = {}
	-- Remember whether the player sits at the bottom (the new-message default).
	scroll:HookScript("OnVerticalScroll", function(self, offset)
		ui.scrollStick = self:GetVerticalScrollRange() - (offset or 0) <= 4
	end)
	scroll:HookScript("OnSizeChanged", function(self, w, h)
		if ui.frame:IsShown() then Runback.Render() end
	end)

	-- Input box, with Send docked at its right end like a messaging app.
	local SEND_W = 84
	local inputBg = CreateFrame("Frame", nil, f, "BackdropTemplate")
	inputBg:SetPoint("BOTTOMLEFT", panel, "BOTTOMRIGHT", 8, 0)
	inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -14 - SEND_W - 6, 50)
	inputBg:SetHeight(54)
	inputBg:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	inputBg:SetBackdropColor(0, 0, 0, 0.6)
	inputBg:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)

	local inScroll = CreateFrame("ScrollFrame", "RunbackInputScroll", inputBg, "UIPanelScrollFrameTemplate")
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 8, -6)
	inScroll:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -24, 6)

	local input = CreateFrame("EditBox", "RunbackInput", inScroll)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(500, 40)
	input:SetScript("OnEnterPressed", function() Runback.SendFromInput() end)
	input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	input:HookScript("OnTextChanged", function(self, userInput) if userInput then WindowUsed() end end)
	input:HookScript("OnEditFocusGained", WindowUsed)
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(self, w, h)
		input:SetWidth(w)
	end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input

	-- Send sits to the right of the input box, vertically centred on it.
	local send = MakeButton(f, "Send", SEND_W, Runback.SendFromInput)
	send:SetHeight(30)
	send:SetPoint("LEFT", inputBg, "RIGHT", 6, 0)
	ui.send = send

	-- Connect stands in for Send until the bridge has been seen (see UpdateConnect).
	local connect = MakeButton(f, "Connect", SEND_W, Runback.Connect)
	connect:SetHeight(30)
	connect:SetPoint("LEFT", inputBg, "RIGHT", 6, 0)
	connect:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Connect to the bridge")
		GameTooltip:AddLine("The bridge must be running on this PC (npm start in runback, or runback in your project). The light turns green once it answers.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	connect:SetScript("OnLeave", function() GameTooltip:Hide() end)
	connect:Hide()
	ui.connect = connect

	-- Reload is the fallback transport's button; it only shows when a reload
	-- would do something (see UpdateStatus), in Resend's place on the bottom row.
	local refresh = MakeButton(f, "Reload", 70, function() SafeReload() end)
	refresh:Hide()
	ui.refresh = refresh

	-- Bottom row: Clear, plus Resend while a message is in flight. Rename, Folder
	-- and Delete live on each chat row in the left panel.
	-- Two clicks: the first arms the button ("Sure?") for a few seconds, the
	-- second wipes the chat it was armed for.
	local clear
	local armed
	clear = MakeButton(f, "Clear", 60, function()
		local c = ActiveChat()
		if armed and c and armed == c.id then
			armed, clear.armToken = nil, nil
			clear:SetText("Clear")
			wipe(c.history)
			Runback.Render()
		elseif c then
			local token = {}
			armed = c.id
			clear.armToken = token
			clear:SetText("Sure?")
			C_Timer.After(3, function()
				if clear.armToken == token then
					armed = nil
					clear:SetText("Clear")
				end
			end)
		end
	end)
	clear:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 26)
	clear:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Clear this chat")
		GameTooltip:AddLine("Erases this chat's messages from the window. Click twice to confirm.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	clear:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.clear = clear

	-- The chat's AI and model; a click opens the picker above it.
	local pool = CreateFrame("Button", "RunbackPoolButton", f, "UIPanelButtonTemplate")
	pool:SetSize(150, 22)
	pool:SetText("AI")
	pool:SetScript("OnClick", function(self) Runback.AgentPrompt(nil, self) end)
	pool:SetPoint("LEFT", clear, "RIGHT", 6, 0)
	pool:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Switch AI")
		GameTooltip:AddLine("Pick which AI and model answers this chat, from the ones installed on your PC. A different AI starts a fresh conversation; a different model of the same AI carries on.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	pool:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.pool = pool

	-- Same as typing /ai review: the command attaches the last fight's start and
	-- end times, which a plain "review my fight" message does not carry.
	local review = MakeButton(f, "Review last fight", 112, function() SlashCmdList["RUNBACK"]("review") end)
	review:SetPoint("LEFT", pool, "RIGHT", 6, 0)
	review:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Review last fight")
		GameTooltip:AddLine("Asks the mentor to review your last fight from the combat log (same as /ai review). Out of combat only; the combat log must be on.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	review:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.review = review

	-- Same as typing /ai death: the command attaches the recent deaths.
	local death = MakeButton(f, "Why did I die?", 100, function() SlashCmdList["RUNBACK"]("death") end)
	death:SetPoint("LEFT", review, "RIGHT", 6, 0)
	death:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Why did I die?")
		GameTooltip:AddLine("Asks the mentor about your last death (same as /ai death). Out of combat only.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	death:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.death = death

	-- Shows whether the game is writing the combat log and switches it on or off.
	local logBtn = MakeButton(f, "Combat log: ?", 130, function()
		if type(LoggingCombat) == "function" then Runback.SetCombatLog(not LoggingCombat()) end
	end)
	logBtn:SetPoint("LEFT", death, "RIGHT", 6, 0)
	logBtn:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Combat log")
		GameTooltip:AddLine("Reviews read the game's combat log, which must be on during the fight. Click to switch it on or off (out of combat only).", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	logBtn:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.logBtn = logBtn

	local resend = MakeButton(f, "Resend", 70, Runback.Resend)
	resend:SetPoint("LEFT", logBtn, "RIGHT", 6, 0)
	resend:Hide()
	ui.resend = resend
	-- Same place as Resend; UpdateStatus never shows both (backlog 82).
	refresh:SetPoint("LEFT", logBtn, "RIGHT", 6, 0)

	-- A named, always-present button so a keybinding can click it (see /runback bind).
	local hotkey = CreateFrame("Button", "RunbackRefreshButton", UIParent)
	hotkey:SetSize(1, 1)
	hotkey:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -10, 10)
	local function RefreshAction()
		local c = ActiveChat()
		if c and c.pendingId then
			Runback.Send("")
		else
			Runback.Toggle()
		end
	end
	hotkey:SetScript("OnClick", RefreshAction)
	Runback.refreshAction = RefreshAction

	local cwd = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	-- Sits above the frame border, not on it: the default skin's dialog border
	-- takes the bottom 11 px (the plain one 4).
	cwd:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 16, 13)
	cwd:SetPoint("RIGHT", f, "RIGHT", -30, 0)
	cwd:SetJustifyH("LEFT")
	cwd:SetWordWrap(false)
	ui.cwd = cwd

	-- Resize grip
	local grip = CreateFrame("Button", nil, f)
	grip:SetSize(16, 16)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -5, 5)
	grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
	grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
	grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
	grip:SetScript("OnMouseDown", function() f:StartSizing("BOTTOMRIGHT") end)
	grip:SetScript("OnMouseUp", function()
		f:StopMovingOrSizing()
		s.width, s.height = f:GetSize()
	end)

	-- Mini bar: what the window collapses into. Click it to expand, drag to move.
	local m = CreateFrame("Frame", "RunbackMini", UIParent, "BackdropTemplate")
	ui.mini = m
	m:SetSize(250, 30)
	if s.miniPoint then
		m:SetPoint(s.miniPoint, UIParent, s.miniRelPoint or s.miniPoint, s.miniX or 0, s.miniY or 0)
	else
		m:SetPoint("TOP", UIParent, "TOP", 0, -40)
	end
	m:SetFrameStrata("DIALOG")
	m:SetMovable(true)
	m:SetClampedToScreen(true)
	m:EnableMouse(true)
	m:RegisterForDrag("LeftButton")
	m:SetScript("OnDragStart", function(self)
		self.dragging = true
		self:StartMoving()
	end)
	m:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = point, relPoint, x, y
		C_Timer.After(0, function() self.dragging = nil end)
	end)
	m:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and not self.dragging then
			Runback.Minimize(false)
		end
	end)
	m:SetBackdrop(BACKDROP)
	m:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
	m:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	m:Hide()

	local miniDotHolder, miniDot = MakeDot(m)
	miniDotHolder:SetPoint("LEFT", m, "LEFT", 9, 0)
	ui.miniDot = miniDot

	local mlabel = m:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	mlabel:SetPoint("LEFT", miniDotHolder, "RIGHT", 6, 0)
	mlabel:SetText("Runback")

	local badge = m:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	badge:SetPoint("LEFT", mlabel, "RIGHT", 8, 0)
	badge:SetPoint("RIGHT", m, "RIGHT", -26, 0)
	badge:SetJustifyH("LEFT")
	badge:SetWordWrap(false)
	ui.miniBadge = badge

	local ok, pulse = pcall(function()
		local g = badge:CreateAnimationGroup()
		local a1 = g:CreateAnimation("Alpha")
		a1:SetFromAlpha(1)
		a1:SetToAlpha(0.25)
		a1:SetDuration(0.6)
		a1:SetOrder(1)
		local a2 = g:CreateAnimation("Alpha")
		a2:SetFromAlpha(0.25)
		a2:SetToAlpha(1)
		a2:SetDuration(0.6)
		a2:SetOrder(2)
		g:SetLooping("REPEAT")
		return g
	end)
	if ok then ui.miniPulse = pulse end

	local mclose = CreateFrame("Button", nil, m, "UIPanelCloseButton")
	mclose:SetSize(24, 24)
	mclose:SetPoint("RIGHT", m, "RIGHT", -2, 0)
	mclose:SetScript("OnClick", function() Runback.Toggle(false) end)
	mclose:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Quit: hide completely (/runback brings it back)")
		GameTooltip:Show()
	end)
	mclose:SetScript("OnLeave", function() GameTooltip:Hide() end)
	if RunbackForever and RunbackForever.Fire then
		RunbackForever.Fire("UI_BUILT", { frame = f, title = title, status = status, panel = panel,
			menu = menu, scroll = scroll, inputBg = inputBg, input = input, cwd = cwd, grip = grip,
			mini = m, chatButtons = ui.chatButtons })
	end
end
