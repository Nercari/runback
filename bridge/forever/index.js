'use strict';

const fs = require('fs');
const path = require('path');

const modules = [];
let ctx = null;

function logError(mod, hook, err) {
  if (ctx && typeof ctx.log === 'function') ctx.log(`forever module ${mod.__name} ${hook} failed:`, err && err.stack ? err.stack : err);
}
function invoke(mod, hook, args) {
  if (typeof mod[hook] !== 'function') return undefined;
  try { return mod[hook](...args); } catch (err) { logError(mod, hook, err); return undefined; }
}
function register(mod, name) {
  if (!mod || typeof mod !== 'object') throw new TypeError('forever module must be an object');
  mod.__name = name || mod.name || `module-${modules.length + 1}`;
  modules.push(mod);
  return mod;
}
function load(directory, disabled = []) {
  if (!fs.existsSync(directory)) return;
  const skip = new Set(disabled);
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.js')).sort()) {
    const name = path.basename(file, '.js');
    if (!skip.has(name)) {
      try { register(require(path.join(directory, file)), name); }
      catch (err) { if (ctx) ctx.log(`forever module ${name} load failed:`, err.stack || err); }
    }
  }
}
function init(context) { ctx = context; for (const mod of modules) invoke(mod, 'init', [ctx]); }
function intercept(job) {
  const visit = index => {
    for (let i = index; i < modules.length; i++) {
      const mod = modules[i];
    if (typeof mod.intercept !== 'function') continue;
    let result;
    try { result = mod.intercept(job, ctx); } catch (err) { logError(mod, 'intercept', err); continue; }
      if (result && typeof result.then === 'function') return result.then(value => value ? true : visit(i + 1));
      if (result) return true;
    }
    return false;
  };
  return visit(0);
}
function augment(job, runInfo) { for (const mod of modules) invoke(mod, 'augment', [job, runInfo, ctx]); }
function onRun(info) { for (const mod of modules) invoke(mod, 'onRun', [info, ctx]); }
function onSavedVariables(src) { for (const mod of modules) invoke(mod, 'onSavedVariables', [src, ctx]); }
function onFinish(job, status, text) { for (const mod of modules) invoke(mod, 'onFinish', [job, status, text, ctx]); }
function stop() { for (const mod of modules) invoke(mod, 'stop', []); }
module.exports = {
  modules,
  register,
  load,
  init,
  intercept,
  augment,
  onRun,
  onSavedVariables,
  onFinish,
  stop,
};
