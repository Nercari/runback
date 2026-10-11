-- WoWAI guide store: leveling guides the agent wrote, synced from the bridge.
--
-- Guides arrive in slot files as { epoch, version, list = { { id, title, minLevel,
-- maxLevel, faction, source, steps = { { kind, text, quest, questId, points,
-- level, class, race, faction, optional, sticky, completewith }, ... } }, ... } }
-- (format: docs/GUIDE.md). The bridge owns and validates them; a newer version (or
-- another epoch) replaces our copy wholesale. This module only stores and hands
-- out data for the guide panel (backlog 69). It shows nothing, reads no game
-- state and calls no game action, so there is nothing to hide in combat.

local M = {}
WoWAIGuide = M

local gdb -- WoWAIGuideDB: { guides = { epoch, version, list } }

local function DB()
	if not gdb then
		WoWAIGuideDB = WoWAIGuideDB or {}
		gdb = WoWAIGuideDB
	end
	return gdb
end

-- Keep only what the panel can use; the bridge already cleaned it, but saved
-- variables and slot files are data from outside this file.
local function CleanStep(s)
	if type(s) ~= "table" or type(s.kind) ~= "string" or type(s.text) ~= "string" then return nil end
	return s
end

local function CleanGuide(g)
	if type(g) ~= "table" or type(g.id) ~= "string" or type(g.steps) ~= "table" then return nil end
	local steps = {}
	for _, s in ipairs(g.steps) do
		local c = CleanStep(s)
		if c then steps[#steps + 1] = c end
	end
	if #steps == 0 then return nil end
	g.steps = steps
	return g
end

-- Replace our copy when the bridge's is newer, or from another epoch (its state
-- was reset). Returns true when the stored guides changed.
function M.Sync(m)
	if type(m) ~= "table" or type(m.list) ~= "table" then return false end
	local cur = DB().guides
	if cur and cur.epoch == m.epoch and (tonumber(m.version) or 0) <= (tonumber(cur.version) or 0) then return false end
	local list = {}
	for _, g in ipairs(m.list) do
		local c = CleanGuide(g)
		if c then list[#list + 1] = c end
	end
	gdb.guides = { epoch = m.epoch, version = tonumber(m.version) or 0, list = list }
	return true
end

-- The stored guides, oldest first.
function M.List()
	local g = DB().guides
	return g and g.list or {}
end

function M.Find(id)
	for _, g in ipairs(M.List()) do
		if g.id == id then return g end
	end
end

function M.Version()
	local g = DB().guides
	return g and tonumber(g.version) or 0
end
