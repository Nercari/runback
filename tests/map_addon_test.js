// Runs the real Map.lua (with Runback.lua) in a Lua VM: syncing layers from the
// bridge, drawing pins on the world map (zone and continent), the navigator's
// distance/bearing and arrival, herb/ore nodes filtered by skill, and /runback map.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'Runback');

// Map-specific client stubs: Loch Modan (1432) sits at x .5-.6, y .4-.5 of
// Eastern Kingdoms (1415), which is 10000 x 15000 yards.
const MAP_STUB = `
Enum = { UIMapType = { Continent = 2, Zone = 3 } }
local MAPS = { [1432] = { name = "Loch Modan", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 }, [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 } }
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return STUB.playerMap or 1432 end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
function GetPlayerFacing() return STUB.facing or 0 end
function Methods_CreateLine() end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
WorldMapFrame.shown = true
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return STUB.shownMap or 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
local T = getmetatable(canvas).__index
MINING, HERBALISM = "Mining", "Herbalism"
`;

function newVM(saved = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  let stub = fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8');
  // Lines are frames too (Frame:CreateLine), and textures can rotate.
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
  run(MAP_STUB);
  run(saved); // saved variables a previous session left (a reload)
  for (const f of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Map.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'Runback');
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

// Shown pins on the world map overlay: "x,y,label" (label = the numbered text).
function shownPins(vm) {
  vm.run(`
    local out = {}
    local canvas = WorldMapFrame:GetCanvas()
    local overlay = canvas.children[#canvas.children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown then
        local label = c.num and c.num.text or ""
        out[#out + 1] = string.format("%.0f,%.0f,%s,%s", c.x, -c.y, label, c.info and c.info.title or "")
      end
    end
    RESULT = table.concat(out, ";")`);
  const s = vm.evaluate('RESULT');
  return s ? s.split(';') : [];
}

const LAYER = `{ epoch = "e1", version = 1, layers = { { name = "mining", title = "Copper loop", ordered = true, loop = true, points = {
  { 1432, 50, 40, "1. Copper Vein", "ore" }, { 1432, 60, 50, "2. Copper Vein", "ore" }, { 1432, 55, 70, "3. Tin Vein", "ore" } } } } }`;

test('Sync applies a new version once, starts navigation, ignores stale versions', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('RunbackMapDB.map.version'), '1');
  assert.equal(vm.evaluate('RunbackMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('RunbackMapDB.nav.index'), '1');
  const prints = () => vm.num('#STUB.prints');
  // One plain chat line, no addon tag, layer name or "point(s)" (backlog 54).
  assert.equal(vm.evaluate('#STUB.prints'), '1');
  assert.equal(vm.evaluate('STUB.prints[1]'), 'I marked 3 places on your map: open it with M.');
  const before = prints();
  vm.run(`RunbackMap.Sync(${LAYER})`); // same version: nothing
  assert.equal(prints(), before);
  vm.run(`RunbackMap.Sync({ epoch = "e1", version = 0, layers = {} })`); // older: ignored
  assert.equal(vm.num('#RunbackMapDB.map.layers'), 1);
  // A new epoch (bridge state reset) replaces, even with a lower version; same content stays quiet.
  vm.run(`local m = ${LAYER}; m.epoch = "e2"; RunbackMap.Sync(m)`);
  assert.equal(vm.evaluate('RunbackMapDB.map.epoch'), 'e2');
  assert.equal(prints(), before);
  vm.run(`RunbackMap.Sync({ epoch = "e2", version = 5, layers = {} })`);
  assert.equal(vm.num('#RunbackMapDB.map.layers'), 0);
  assert.equal(vm.evaluate('RunbackMapDB.nav'), null);
});

test('a new route does not take over a route the player is already following', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.RUNBACKMAP("nav mining 2")');
  vm.run(`local m = ${LAYER}; m.version = 2; m.layers[2] = { name = "quests", title = "Westfall", ordered = true, loop = false,
    points = { { 1432, 10, 10, "1. Talk", "quest" }, { 1432, 20, 20, "2. Kill", "kill" } } }; RunbackMap.Sync(m)`);
  assert.equal(vm.evaluate('RunbackMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('RunbackMapDB.nav.index'), '2');
  // With nothing being followed, the next route starts by itself.
  vm.run('SlashCmdList.RUNBACKMAP("stop")');
  vm.run(`local m = ${LAYER}; m.version = 3; m.layers[1].points[1][4] = "1. Rich Copper"; RunbackMap.Sync(m)`);
  assert.equal(vm.evaluate('RunbackMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('RunbackMapDB.nav.index'), '1');
});

test('slot data carrying a map reaches the map module', () => {
  const vm = newVM();
  vm.run(`Runback_Inbox = { replies = {}, map = ${LAYER} }; STUB.FireEvent("PLAYER_LOGIN")`);
  assert.equal(vm.evaluate('RunbackMapDB.map.layers[1].title'), 'Copper loop');
});

test('pins land where the points are, on the zone map and on the continent', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  vm.run('RunbackMap.Refresh()');
  let pins = shownPins(vm);
  assert.deepEqual(pins, ['500,280,1,Copper loop', '600,350,2,Copper loop', '550,490,3,Copper loop']);
  vm.run('STUB.shownMap = 1415; RunbackMap.Refresh()');
  pins = shownPins(vm);
  // 1432 (50,40) -> 1415 (0.55, 0.44) on a 1000x700 canvas.
  assert.equal(pins[0], '550,308,1,Copper loop');
  vm.run('STUB.shownMap = 947; RunbackMap.Refresh()'); // no rect: nothing drawn
  assert.deepEqual(shownPins(vm), []);
});

test('navigator shows yards and bearing, and advances on arrival', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  // Player at Loch Modan 50,50 -> continent (0.55, 0.45); stop 1 (50,40) is 150 yd due north.
  vm.run('STUB.posX, STUB.posY = 0.5, 0.5; RunbackMap.UpdateNavigator()');
  assert.match(vm.evaluate('RunbackNavigator.text.text'), /^150 yd/);
  assert.ok(Math.abs(vm.num('RunbackNavigator.arrow.rotation')) < 1e-9, 'north is straight up');
  vm.run('STUB.facing = math.pi / 2; RunbackMap.UpdateNavigator()'); // facing west: target is to the right
  assert.ok(Math.abs(vm.num('RunbackNavigator.arrow.rotation') + Math.PI / 2) < 1e-9);
  // Walk onto stop 1: it advances to stop 2 (60,50: 100 yd east and 150 yd south).
  vm.run('STUB.facing = 0; STUB.posX, STUB.posY = 0.5, 0.4; RunbackMap.UpdateNavigator()');
  assert.equal(vm.evaluate('RunbackMapDB.nav.index'), '2');
  vm.run('RunbackMap.UpdateNavigator()');
  assert.match(vm.evaluate('RunbackNavigator.text.text'), /^180 yd/);
  // South-east: a clockwise turn between a quarter and a half.
  assert.ok(Math.abs(vm.num('RunbackNavigator.arrow.rotation') - Math.atan2(-100, -150)) < 1e-9);
  // Due east from the same spot's latitude: exactly a clockwise quarter turn.
  vm.run('STUB.posX, STUB.posY = 0.5, 0.5; RunbackMap.UpdateNavigator()');
  assert.match(vm.evaluate('RunbackNavigator.text.text'), /^100 yd/);
  assert.ok(Math.abs(vm.num('RunbackNavigator.arrow.rotation') + Math.PI / 2) < 1e-9, 'east is a clockwise quarter turn');
  // Loop: after the last stop it wraps to the first.
  vm.run('RunbackMap.Step(1); RunbackMap.Step(1)');
  assert.equal(vm.evaluate('RunbackMapDB.nav.index'), '1');
  // Elsewhere with no position: says so instead of pointing.
  vm.run('STUB.playerMap = 999; RunbackMap.UpdateNavigator()');
  assert.equal(vm.evaluate('RunbackNavigator.text.text'), 'no position here');
});

test('the navigator is clamped to the screen so a drag cannot lose it', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('RunbackNavigator.clamped'), 'true');
});

test('herb/ore nodes toggle and follow the gathering skill', () => {
  const vm = newVM();
  vm.run(`WoWAINodes = { kinds = { { "Copper Vein", "mining", 1 }, { "Tin Vein", "mining", 65 }, { "Peacebloom", "herbalism", 1 } },
    maps = { [1432] = { [1] = "100200300400", [2] = "500500", [3] = "999999" } } }`);
  vm.run('RunbackMap.Refresh()');
  assert.equal(shownPins(vm).length, 0, 'off by default');
  vm.run('SlashCmdList.RUNBACKMAP("ore on")');
  // No Mining skill line in the stub: every ore shows, flagged as not learned.
  assert.deepEqual(shownPins(vm).map(p => p.split(',').slice(0, 2).join(',') + ',' + p.split(',')[3]), ['100,140,Copper Vein', '300,280,Copper Vein', '500,350,Tin Vein']);
  // With Mining 50 (Forever's C_SkillInfo: one table per line), Tin (65) is filtered out until "filter all".
  // Forever also lists child lines (parentSkillLineID ~= 0) that repeat the parent.
  vm.run(`C_SkillInfo = { GetNumSkillLines = function() return 3 end, GetSkillLineInfo = function(i)
    if i == 1 then return { name = "Professions", isHeader = true, rank = 0, maxRank = 0, skillID = 0, parentSkillLineID = 0 } end
    if i == 3 then return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 2572, parentSkillLineID = 186 } end
    return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 186, parentSkillLineID = 0 } end }
    RunbackMap.Refresh()`);
  assert.equal(shownPins(vm).length, 2);
  vm.run('SlashCmdList.RUNBACKMAP("filter all")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.RUNBACKMAP("herb on")');
  assert.equal(shownPins(vm).length, 4);
  vm.run('SlashCmdList.RUNBACKMAP("ore off"); SlashCmdList.RUNBACKMAP("herb off")');
  assert.equal(shownPins(vm).length, 0);
  // The game context reads professions from the same API.
  assert.match(vm.evaluate('Runback.GameContext()'), /Professions: Bergbau 50\/75(\n|$)/);
});

test('/runback map hide, show, nav and stop', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.RUNBACKMAP("hide mining")');
  assert.equal(shownPins(vm).length, 0);
  vm.run('SlashCmdList.RUNBACKMAP("show mining")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.RUNBACKMAP("nav mining 3")');
  assert.equal(vm.evaluate('RunbackMapDB.nav.index'), '3');
  vm.run('SlashCmdList.RUNBACKMAP("stop")');
  assert.equal(vm.evaluate('RunbackMapDB.nav'), null);
  assert.equal(vm.evaluate('RunbackNavigator.shown'), 'false');
  vm.run('SlashCmdList.RUNBACKMAP("")'); // status never errors
});

// Backlog 89: pin kinds that two colourblind viewers could not tell apart. Colours
// are sRGB; they go through linear RGB, the Machado 2009 severity 1.0 matrices
// (deuteranopia, protanopia), then CIE76 deltaE in Lab (D65). Below MIN_DE two
// kinds collapse. Measured on the classic palette before the safe one existed.
const KINDS = ['ore', 'herb', 'quest', 'turnin', 'kill', 'loot', 'object', 'explore', 'npc', 'trainer', 'vendor', 'dungeon', 'flight', 'poi'];
const MIN_DE = 10;
const SIM = {
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
};
function lab(rgb, m) {
  const lin = rgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const s = m.map(r => Math.min(1, Math.max(0, r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2])));
  const xyz = [0.4124 * s[0] + 0.3576 * s[1] + 0.1805 * s[2], 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2], 0.0193 * s[0] + 0.1192 * s[1] + 0.9505 * s[2]];
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(xyz[0] / 0.9505), f(xyz[1]), f(xyz[2] / 1.089)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function collapsing(vm) {
  const col = Object.fromEntries(KINDS.map(k => [k, vm.evaluate(`table.concat(RunbackMap.Color("${k}"), ",")`).split(',').map(Number)]));
  const out = [];
  for (let i = 0; i < KINDS.length; i++) for (let j = i + 1; j < KINDS.length; j++) {
    const worst = Math.min(...Object.values(SIM).map(m => Math.hypot(...lab(col[KINDS[i]], m).map((v, n) => v - lab(col[KINDS[j]], m)[n]))));
    if (worst < MIN_DE) out.push(KINDS[i] + '/' + KINDS[j]);
  }
  return out;
}

test('safe pin colours keep every kind apart for deuteranopia and protanopia; classic collapses some', () => {
  const vm = newVM();
  assert.deepEqual(collapsing(vm), [], 'safe is the default');
  vm.run('SlashCmdList.RUNBACKMAP("colors classic")');
  const before = collapsing(vm);
  console.log(`# classic palette: ${before.length} of 91 kind pairs collapse (deltaE < ${MIN_DE}): ${before.join(' ')}`);
  assert.ok(before.length > 0);
  vm.run('SlashCmdList.RUNBACKMAP("colors safe")');
  assert.deepEqual(collapsing(vm), []);
});

test('/runback map colors switches the pin colours, and the choice survives a reload', () => {
  const vm = newVM();
  vm.run(`RunbackMap.Sync(${LAYER})`);
  const dot = () => vm.evaluate('(function() local o = WorldMapFrame:GetCanvas().children; o = o[#o]; for _, c in ipairs(o.children) do if c.kind == "Button" and c.shown then return table.concat(c.dot.vcolor, ",", 1, 3) end end end)()');
  assert.equal(dot(), vm.evaluate('table.concat(RunbackMap.Color("ore"), ",")'));
  const safe = dot();
  vm.run('SlashCmdList.RUNBACKMAP("colors classic")');
  assert.equal(vm.evaluate('RunbackMapDB.colors'), 'classic');
  assert.equal(dot(), '0.95,0.6,0.25');
  assert.notEqual(dot(), safe);
  const reloaded = newVM('RunbackMapDB = { colors = "classic" }');
  assert.equal(reloaded.evaluate('RunbackMap.Color("ore")[1]'), '0.95');
});
