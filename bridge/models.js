'use strict';
// The models and reasoning levels each agent's own CLI offers, built in because
// no CLI gives a machine-readable list for the account (see docs/model-picker-spec.md).
// An entry is { id, label, efforts, defaultEffort }: efforts are the levels the CLI
// accepts for that model (empty: none), defaultEffort the one it uses unasked.
// Only models the CLI lists in its own picker are here; checked 2026-10-09.
// agents.<id>.models in config.json replaces a catalog list.
const EFFORT_TOKEN = /^[a-z]{1,16}$/;
const { validModel } = require('./protocol');

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_ULTRA = [...CODEX_MAX, 'ultra'];
const entry = (id, efforts, defaultEffort) => ({ id, label: id, efforts, defaultEffort: defaultEffort || '' });

const CATALOG = {
  // https://code.claude.com/docs/en/model-config ; `claude --help`. `ultracode` is never offered.
  // The [1m] aliases and opusplan depend on the account, so they are left to config.json.
  claude: [
    entry('fable', FIVE, 'high'),
    entry('opus', FIVE, 'medium'),
    entry('sonnet', FIVE, 'medium'),
    entry('haiku', [], ''),
  ],
  // codex-rs/models-manager/models.json, entries with visibility "list", in the CLI's order.
  codex: [
    entry('gpt-6-astra', CODEX_ULTRA, 'low'),
    entry('gpt-6.1-sol', CODEX_ULTRA, 'low'),
    entry('gpt-6-sol', CODEX_ULTRA, 'medium'),
    entry('gpt-6-luna', CODEX_MAX, 'medium'),
    entry('gpt-5.6-sol', CODEX_ULTRA, 'low'),
    entry('gpt-5.6-terra', CODEX_ULTRA, 'medium'),
    entry('gpt-5.6-luna', CODEX_MAX, 'medium'),
    entry('gpt-5.5', ['low', 'medium', 'high', 'xhigh'], 'medium'),
  ],
  // https://docs.x.ai/llms-full.txt names only grok-build. Its effort levels are unverified
  // (backlog 41), so none are offered until they are confirmed.
  grok: [entry('grok-build', [], '')],
  // agy puts the level in the model id, and the real ids are not confirmed yet (backlog 41, 46).
  agy: [],
  // OpenCode lists its models as `provider/model` (opencode models, 2.2.5) and keeps
  // each model's reasoning variants off that list, so both come from config.json.
  opencode: [],
  // Hermes uses whatever the player configured: list it in agents.hermes.models.
  hermes: [],
};

// Five picker roles the bridge publishes (addon unit 4 shows them; unit 3 only
// builds the table and ships it on the slot file). agents.<id>.roles overrides
// a row; empty model means this agent does not offer that role on its list.
const ROLE_IDS = ['chat', 'quick', 'coach', 'deep', 'translate'];
const ROLE_LABELS = {
  chat: 'Chat',
  quick: 'Quick answer',
  coach: 'Coach note',
  deep: 'Deep review',
  translate: 'Translate',
};
const TOOL_FREE_AGENTS = new Set(['claude', 'grok']);
const path = require('path');

// Built-in deep-review row: a capable default on each agent that names one.
const DEEP = { claude: 'opus', codex: 'gpt-6-sol', grok: 'grok-build' };

// The cheap model a coach note (a fight review) runs on by default, one per pull,
// so its cost rounds to nothing. Only Claude's docs name one (haiku, the small fast
// model); the other lists here name no cheaper model the bridge can rely on, so
// those agents keep their normal model. agents.<id>.coachModel changes it.
const CHEAP = { claude: 'haiku' };
// The Quick answer tier for short questions (roles, not names, in the addon).
const QUICK = { ...CHEAP };

function validEffort(e) { return typeof e === 'string' && EFFORT_TOKEN.test(e); }

// A config.json models item: a plain string (no levels) or { id, efforts, defaultEffort }.
function fromConfig(item) {
  if (typeof item === 'string') return validModel(item) ? entry(item, [], '') : null;
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !validModel(item.id)) return null;
  const efforts = (Array.isArray(item.efforts) ? item.efforts : []).filter(validEffort).filter((e, i, a) => a.indexOf(e) === i);
  const def = efforts.includes(item.defaultEffort) ? item.defaultEffort : '';
  return { id: item.id, label: typeof item.label === 'string' && item.label ? item.label.slice(0, 40) : item.id, efforts, defaultEffort: def };
}

// The entries a chat can pick for this agent: agents.<id>.models when it is an
// array (even an empty one), else the catalog; agents.<id>.model comes first.
function entries(acfg, id) {
  const base = Array.isArray(acfg && acfg.models)
    ? acfg.models.map(fromConfig).filter(Boolean)
    : (CATALOG[id] || []).map(e => ({ ...e, efforts: [...e.efforts] }));
  const first = fromConfig(acfg && acfg.model);
  const out = [];
  for (const e of [first, ...base]) {
    if (!e || out.some(o => o.id === e.id)) continue;
    // The configured default model keeps the levels the list gives it.
    out.push(e === first ? (base.find(b => b.id === e.id) || e) : e);
  }
  return out;
}

// The model a coach note runs on, or '' for the agent's normal one: agents.<id>.coachModel
// when this agent offers it, else the built-in cheap model when its list offers that.
// A player whose list names no cheap model gets the normal model, never an error.
function coachModel(acfg, id) {
  const list = entries(acfg, id);
  const own = acfg && typeof acfg.coachModel === 'string' ? acfg.coachModel : '';
  if (own && list.some(e => e.id === own)) return own;
  const cheap = CHEAP[id] || '';
  return cheap && list.some(e => e.id === cheap) ? cheap : '';
}

// Quick answer tier: agents.<id>.quickModel when set, else the built-in QUICK row.
function quickModel(acfg, id) {
  const list = entries(acfg, id);
  const own = acfg && typeof acfg.quickModel === 'string' ? acfg.quickModel : '';
  if (own && list.some(e => e.id === own)) return own;
  const quick = QUICK[id] || '';
  return quick && list.some(e => e.id === quick) ? quick : '';
}

function chatModel(acfg, id) {
  const list = entries(acfg, id);
  const cfgRoles = acfg && acfg.roles && typeof acfg.roles === 'object' ? acfg.roles : {};
  const own = typeof cfgRoles.chat === 'string' ? cfgRoles.chat : '';
  if (own && list.some(e => e.id === own)) return own;
  const picked = fromConfig(acfg && acfg.model);
  if (picked && list.some(e => e.id === picked.id)) return picked.id;
  return list[0] ? list[0].id : '';
}

function deepModel(acfg, id) {
  const list = entries(acfg, id);
  const cfgRoles = acfg && acfg.roles && typeof acfg.roles === 'object' ? acfg.roles : {};
  const own = typeof cfgRoles.deep === 'string' ? cfgRoles.deep : '';
  if (own && list.some(e => e.id === own)) return own;
  const built = DEEP[id] || '';
  if (built && list.some(e => e.id === built)) return built;
  const capable = list.find(e => e.efforts && e.efforts.length);
  if (capable) return capable.id;
  return list[0] ? list[0].id : '';
}

function translateModel(acfg, id) {
  if (!TOOL_FREE_AGENTS.has(id)) return '';
  const cfgRoles = acfg && acfg.roles && typeof acfg.roles === 'object' ? acfg.roles : {};
  const own = typeof cfgRoles.translate === 'string' ? cfgRoles.translate : '';
  const list = entries(acfg, id);
  if (own && list.some(e => e.id === own)) return own;
  return chatModel(acfg, id);
}

function roleOverride(acfg, role) {
  const cfgRoles = acfg && acfg.roles && typeof acfg.roles === 'object' ? acfg.roles : {};
  return typeof cfgRoles[role] === 'string' ? cfgRoles[role] : '';
}

function roleRows(acfg, id) {
  const list = entries(acfg, id);
  const onList = m => m && list.some(e => e.id === m);
  const row = (role, model, blocked) => ({
    model: model || '',
    label: ROLE_LABELS[role] || role,
    blocked: blocked || '',
  });
  const chat = roleOverride(acfg, 'chat') || chatModel(acfg, id);
  const quick = roleOverride(acfg, 'quick') || quickModel(acfg, id);
  const coach = roleOverride(acfg, 'coach') || coachModel(acfg, id);
  const deep = roleOverride(acfg, 'deep') || deepModel(acfg, id);
  let translate = roleOverride(acfg, 'translate') || translateModel(acfg, id);
  let translateBlock = '';
  if (!TOOL_FREE_AGENTS.has(id)) {
    translate = '';
    translateBlock = `${id} cannot run the translator: its tools cannot all be turned off.`;
  }
  return {
    chat: row('chat', onList(chat) ? chat : '', chat && !onList(chat) ? 'Model not on this agent list.' : ''),
    quick: row('quick', onList(quick) ? quick : '', quick && !onList(quick) ? 'Model not on this agent list.' : ''),
    coach: row('coach', onList(coach) ? coach : '', coach && !onList(coach) ? 'Model not on this agent list.' : ''),
    deep: row('deep', onList(deep) ? deep : '', deep && !onList(deep) ? 'Model not on this agent list.' : ''),
    translate: row('translate', onList(translate) ? translate : '', translateBlock),
  };
}

function roleMap(acfg, id) {
  const rows = roleRows(acfg, id);
  const out = {};
  for (const r of ROLE_IDS) out[r] = rows[r].model || '';
  return out;
}

function roleBlocks(acfg, id) {
  const rows = roleRows(acfg, id);
  const out = {};
  for (const r of ROLE_IDS) {
    const b = rows[r].blocked;
    if (b) out[r] = b;
  }
  return out;
}

function agentCannotRun(id) {
  try {
    const MentorGuard = require('./forever/modules/05-mentor-guard');
    const root = path.join(__dirname, '..', 'mentor');
    return MentorGuard.refusal(id, root, root);
  } catch {
    return '';
  }
}

module.exports = {
  CATALOG,
  CHEAP,
  QUICK,
  ROLE_IDS,
  ROLE_LABELS,
  entries,
  coachModel,
  quickModel,
  chatModel,
  deepModel,
  translateModel,
  roleRows,
  roleMap,
  roleBlocks,
  agentCannotRun,
  validEffort,
};
