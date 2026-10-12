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
  // Hermes uses whatever the player configured: list it in agents.hermes.models.
  hermes: [],
};

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

module.exports = {
  CATALOG,
  entries,
  validEffort,
};
