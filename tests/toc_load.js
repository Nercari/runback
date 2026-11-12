'use strict';
// Load Runback addon .lua files in Runback.toc order for VM tests.

const fs = require('node:fs');
const path = require('node:path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const DEFAULT_ADDON = path.join(__dirname, '..', 'addon', 'Runback');
const DEFAULT_STUB = path.join(__dirname, 'wow_stub.lua');

function parseToc(addonDir = DEFAULT_ADDON) {
  return fs.readFileSync(path.join(addonDir, 'Runback.toc'), 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.endsWith('.lua'));
}

function onlyFiles(names) {
  return new Set(names);
}

function orderedOnly(...names) {
  return names;
}

const MIGRATION_LOAD = orderedOnly('Codec.lua', 'Inbox.lua', 'Forever.lua', 'Runback.lua');
const SLOT_BUDGET_LOAD = orderedOnly('Codec.lua', 'Inbox.lua', 'Forever.lua', 'Runback.lua');

function selectTocFiles(toc, options = {}) {
  let files = toc;
  if (options.until) {
    const idx = files.indexOf(options.until);
    if (idx < 0) throw new Error(`until ${options.until} not in Runback.toc`);
    files = files.slice(0, idx + 1);
  }
  if (options.only) {
    const set = options.only instanceof Set ? options.only : new Set(options.only);
    files = files.filter(f => set.has(f));
  }
  if (options.skip) {
    const set = options.skip instanceof Set ? options.skip : new Set(options.skip);
    files = files.filter(f => !set.has(f));
  }
  return files;
}

function createAddonVM(options = {}) {
  const addonDir = options.addonDir || DEFAULT_ADDON;
  const stubPath = options.stubPath || DEFAULT_STUB;
  const toc = parseToc(addonDir);
  const files = options.files || selectTocFiles(toc, options);
  const chunkName = options.chunkName;
  const strict = options.strictLoad !== false;

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const assert = options.strictLoad ? require('node:assert/strict').assert : null;
  const run = (code, arg) => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    if (assert) {
      assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    } else if (loaded !== lua.LUA_OK) {
      throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
    let nargs = 0;
    if (arg !== undefined) {
      lua.lua_pushstring(L, to_luastring(arg));
      nargs = 1;
    }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(L, -1)) || 'Lua runtime error');
    }
  };

  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };

  const get = (expr) => {
    run(`RESULT = tostring(${expr})`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return value;
  };

  const num = (expr) => Number(evaluate(expr));

  const truthy = (expr) => {
    run(`RESULT = (${expr}) and 1 or 0`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = lua.lua_tointeger(L, -1);
    lua.lua_pop(L, 1);
    return value === 1;
  };

  let stub = options.stub;
  if (stub === undefined) {
    stub = fs.readFileSync(stubPath, 'utf8');
    if (options.stubExtra) stub += options.stubExtra;
    if (options.stubPatch) stub = options.stubPatch(stub);
  }
  run(stub);
  if (options.beforeLoad) run(options.beforeLoad);
  if (options.saved) run(options.saved);
  for (const f of files) {
    const src = fs.readFileSync(path.join(addonDir, f), 'utf8');
    run(src, chunkName);
  }
  if (options.afterLoad) run(options.afterLoad);

  return { run, evaluate, get, num, truthy, files, toc };
}

module.exports = {
  DEFAULT_ADDON,
  DEFAULT_STUB,
  parseToc,
  onlyFiles,
  orderedOnly,
  MIGRATION_LOAD,
  SLOT_BUDGET_LOAD,
  selectTocFiles,
  createAddonVM,
};
