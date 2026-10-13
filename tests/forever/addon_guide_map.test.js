// Guide step on the map (backlog 71): Forever_Guide.lua hands the current step's
// points to the real Map.lua as the `guide` layer, in a Lua VM with Runback.lua, the
// lockout module and a stub map. Pins and navigator follow the step, a radius or
// 12 yards ticks a point off, a bridge sync leaves the layer alone, combat hides
// guide text, and malformed points are dropped.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');

// Loch Modan (1432) is x .5-.6, y .4-.5 of Eastern Kingdoms (1415), 10000 x 15000
// yards, so the zone is 1000 yards wide and 1500 tall.
const MAP_STUB = `
Enum = { UIMapType = { Continent = 2, Zone = 3 } }
local MAPS = { [1432] = { mapType = 3, parentMapID = 1415 }, [1415] = { mapType = 2, parentMapID = 947 }, [947] = { mapType = 1, parentMapID = 0 } }
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return 1432 end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
function GetPlayerFacing() return 0 end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
WorldMapFrame.shown = true
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
`;

function vm(saved, inbox) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  let stub = fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8');
  stub += `
function Methods.CreateLine(self, name, layer) local l = NewObjectPublic("Line", name, self); table.insert(self.textures, l); return l end
function Methods.SetRotation(self, r) self.rotation = r end
function Methods.SetVertexColor(self, r, g, b, a) self.vcolor = { r, g, b, a } end
function Methods.SetScale(self, s) self.scale = s end
function Methods.SetAllPoints(self, rel) if rel then self.width, self.height = rel.width, rel.height end end
function Methods.GetFrameLevel(self) return self.level or 1 end
function Methods.SetFrameLevel(self, l) self.level = l end
`;
  stub = stub.replace('local function NewObject(', 'function NewObjectPublic(').replace(/NewObject\(/g, 'NewObjectPublic(');
  run(stub);
  run('unpack = table.unpack');
  run(MAP_STUB);
  if (saved) run(saved);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Map.lua', 'Guide.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Guide.lua']) run(read(file));
  if (inbox) run(`Runback_Inbox = ${inbox}`);
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}

// Shown world-map pins as "x,y,number,title".
function pins(v) {
  v.run(`
    local out = {}
    local overlay = WorldMapFrame:GetCanvas().children[#WorldMapFrame:GetCanvas().children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown then
        out[#out + 1] = string.format("%.0f,%.0f,%s,%s", c.x, -c.y, c.num and c.num.text or "", c.info and c.info.title or "")
      end
    end
    PINS = table.concat(out, ";")`);
  const s = v.get('PINS');
  return s ? s.split(';') : [];
}

const GUIDE = `{ epoch = 1, version = 1, list = { { id = "g", title = "G", steps = {
  { kind = "travel", text = "Walk to the camp.", points = { { m = 1432, x = 50, y = 40, radius = 5, label = "Camp" }, { m = 1432, x = 60, y = 50, label = "Well" } } },
  { kind = "do", text = "Kill rats.", points = { { m = 1432, x = 55, y = 70, label = "Rats" } } },
  { kind = "note", text = "Rest a while." },
} } } }`;

const seed = v => { v.run(`RunbackGuide.Sync(${GUIDE})`); v.run('SlashCmdList.RUNBACK("guide show")'); };
const nav = v => v.get('RunbackMapDB.nav and (RunbackMapDB.nav.layer .. " " .. RunbackMapDB.nav.index)');
const navText = v => v.get('RunbackNavigator.title.text');
const at = (v, x, y) => v.run(`STUB.posX, STUB.posY = ${x}, ${y}; RunbackMap.UpdateNavigator()`);

test('the current step shows as the guide layer; a step change replaces it; a step without points clears it', () => {
  const v = vm();
  v.run(`RunbackGuide.Sync(${GUIDE})`);
  assert.deepEqual(pins(v), [], 'nothing on the map while the panel is closed');
  v.run('SlashCmdList.RUNBACK("guide show")');
  assert.deepEqual(pins(v), ['500,280,1,Go: Walk to the camp.', '600,350,2,Go: Walk to the camp.']);
  assert.equal(nav(v), 'guide 1');
  assert.equal(v.get('RunbackNavigator.shown'), 'true');
  assert.equal(navText(v), '1/2  Camp');

  v.run('SlashCmdList.RUNBACK("guide next")');
  assert.deepEqual(pins(v), ['550,490,,Do: Kill rats.'], 'one point: no number, no line');
  assert.equal(nav(v), 'guide 1');
  assert.equal(navText(v), '1/1  Rats');

  v.run('SlashCmdList.RUNBACK("guide next")');
  assert.deepEqual(pins(v), []);
  assert.equal(nav(v), 'nil');
  assert.equal(v.get('RunbackNavigator.shown'), 'false');

  v.run('SlashCmdList.RUNBACK("guide prev"); SlashCmdList.RUNBACK("guide hide")');
  assert.deepEqual(pins(v), [], 'closing the panel takes the step off the map');
  assert.equal(nav(v), 'nil');
});

test('arriving inside a radius ticks the point off; a point without one needs 12 yards; the last point stops', () => {
  const v = vm();
  seed(v);
  at(v, 0.5, 0.44); // 60 yd south of Camp; radius 5% of 1000 yd = 50 yd
  assert.equal(nav(v), 'guide 1');
  at(v, 0.5, 0.43); // 45 yd: inside
  assert.equal(nav(v), 'guide 2', 'Camp ticked off, on to Well');
  at(v, 0.6, 0.53); // 45 yd from Well, which has no radius
  assert.equal(nav(v), 'guide 2');
  at(v, 0.6, 0.509); // 13.5 yd
  assert.equal(nav(v), 'guide 2');
  const printed = v.get('#STUB.prints');
  at(v, 0.6, 0.507); // 10.5 yd
  assert.equal(nav(v), 'nil', 'after the last point the navigator stops');
  assert.equal(v.get('#STUB.prints'), printed, 'no "route finished" line for a guide step');
  v.run('STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(nav(v), 'nil', 'the same step again does not restart it');
  assert.equal(v.get('RunbackGuideDB.panel.step.g'), 'nil', 'arrival never ticks the guide step itself');
});

test('a bridge sync does not wipe the guide layer, and a new bridge route takes the navigator', () => {
  const v = vm();
  seed(v);
  v.run(`RunbackMap.Sync({ epoch = "e", version = 1, layers = { { name = "herbs", title = "Herbs", ordered = true, loop = true,
    points = { { 1432, 52, 42, "Peacebloom", "herb" }, { 1432, 58, 48, "Silverleaf", "herb" } } } } })`);
  assert.equal(nav(v), 'herbs 1');
  assert.deepEqual(pins(v).map(p => p.split(',')[3]), ['Herbs', 'Herbs', 'Go: Walk to the camp.', 'Go: Walk to the camp.']);
  v.run('RunbackMap.Sync({ epoch = "e", version = 2, layers = {} })');
  assert.deepEqual(pins(v).map(p => p.split(',')[3]), ['Go: Walk to the camp.', 'Go: Walk to the camp.']);
  v.run('SlashCmdList.RUNBACKMAP("nav guide 2")');
  assert.equal(nav(v), 'guide 2');
  v.run('RunbackMap.Sync({ epoch = "e", version = 3, layers = {} })');
  assert.equal(nav(v), 'guide 2', 'a sync keeps navigation on the guide layer');
});

test('combat hides the guide pins and the navigator on the guide; both come back after', () => {
  const v = vm();
  seed(v);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.deepEqual(pins(v), []);
  assert.equal(v.get('RunbackNavigator.shown'), 'false');
  at(v, 0.5, 0.4);
  assert.equal(v.get('RunbackNavigator.shown'), 'false', 'the navigator stays hidden in combat');
  v.run('STUB.prints = {}; SlashCmdList.RUNBACKMAP("")');
  assert.equal(v.get('table.concat(STUB.prints, "\\n")').includes('guide'), false, 'map status names no guide step in combat');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(pins(v).length, 2);
  assert.equal(v.get('RunbackNavigator.shown'), 'true');
  assert.equal(navText(v), '1/2  Camp');
});

test('a bridge route keeps its navigator in combat', () => {
  const v = vm();
  seed(v);
  v.run(`RunbackMap.Sync({ epoch = "e", version = 1, layers = { { name = "r", title = "R", ordered = true,
    points = { { 1432, 52, 42, "A", "poi" }, { 1432, 58, 48, "B", "poi" } } } } })`);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(v.get('RunbackNavigator.shown'), 'true');
  assert.equal(navText(v), '1/2  A');
});

test('malformed and hostile points are dropped; radius and count are clamped', () => {
  const v = vm();
  v.run(`RunbackGuide.Sync({ epoch = 1, version = 1, list = { { id = "h", steps = {
    { kind = "do", text = "x", points = { "str", { m = "x" }, { m = 1432, x = 1/0, y = 5 }, { m = 1432, x = 0/0, y = 5 },
      { m = 1.5, x = 1, y = 1 }, { m = 1432, x = 200, y = 5 }, { m = 1432, x = 50, y = 40, radius = 1000, label = "a|cffff0000b|r" } } },
    { kind = "do", text = "y", points = "nope" },
    { kind = "do", text = "z", points = { { m = 1432, x = 1, y = 1 }, { m = 1432, x = 2, y = 2 }, { m = 1432, x = 3, y = 3 }, { m = 1432, x = 4, y = 4 },
      { m = 1432, x = 5, y = 5 }, { m = 1432, x = 6, y = 6 }, { m = 1432, x = 7, y = 7 }, { m = 1432, x = 8, y = 8 }, { m = 1432, x = 9, y = 9 } } },
  } } } })`);
  v.run('SlashCmdList.RUNBACK("guide show")');
  assert.deepEqual(pins(v), ['500,280,,Do: x']);
  assert.equal(navText(v), '1/1  acffff0000br', 'no escape code reaches the navigator');
  at(v, 0.5, 0.5); // 150 yd away; radius clamped to 25% of 1000 yd = 250 yd
  assert.equal(nav(v), 'nil', 'arrived inside the clamped radius');
  v.run('SlashCmdList.RUNBACK("guide next")');
  assert.deepEqual(pins(v), []);
  v.run('SlashCmdList.RUNBACK("guide next")');
  assert.equal(pins(v).length, 8, 'at most 8 points per step');
});

test('progress inside a step survives a reload, even when bridge layers arrive first', () => {
  const v = vm();
  seed(v);
  at(v, 0.5, 0.43);
  assert.equal(nav(v), 'guide 2');
  const key = v.get('RunbackMapDB.guideKey');
  const w = vm(`RunbackMapDB = { hidden = {}, nav = { layer = "guide", index = 2 }, guideKey = ${JSON.stringify(key)} }
    RunbackGuideDB = { guides = ${GUIDE}, panel = { shown = true } }`,
  '{ replies = {}, map = { epoch = "e", version = 1, layers = { { name = "marks", title = "Marks", points = { { 1432, 52, 42, "A", "poi" } } } } } }');
  assert.equal(w.get('RunbackMapDB.map.layers[1].name'), 'marks');
  assert.equal(nav(w), 'guide 2');
  assert.equal(navText(w), '2/2  Well');
});
