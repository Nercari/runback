#!/usr/bin/env node
"use strict";
/* Scenario: class, level, role, stats, gear, weapon {min,max,speed,offhand?,normalizedSpeed?},
 * target {level,armor,resist,player?,defense?,dodgePct?,parryPct?}, abilities
 * [{name,kind,hand?,baseMin?,baseMax?,weaponPct?,flat?,coeff?,castTime?,cooldown?,cost?,normalized?}],
 * mods [{name,damagePct?,critPct?,critDamagePct?,hitPct?,spellHitPct?,spellCritPct?,apFlat?,apPct?,strPct?,agiPct?,
 * hastePct?,spFlat?,uptime?,appliesTo?}], fromFront, dualWield, hp, resourcePerSecond, data overrides. Percents are points. */
const DEFAULT_DATA = require("./theorycraft-data.json").coefficients;
function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
function stat(scenario, key) {
  return Number(scenario.stats?.[key] || 0) + Number(scenario.gear?.[key] || 0);
}
function context(scenario) {
  const data = { ...DEFAULT_DATA, ...scenario.data };
  const used = new Set();
  function get(key) {
    const entry = data[key];
    if (!entry || typeof entry.source !== "string" ||
      !["verified", "reported", "unknown"].includes(entry.status) || !("value" in entry)) {
      throw new Error(`invalid data entry: ${key}`);
    }
    used.add(key);
    return entry.value;
  }
  return { get, used, data };
}
function modTotal(mods, key, types) {
  return mods.reduce((total, mod) => {
    if (mod.appliesTo && !mod.appliesTo.some(type => types.includes(type))) return total;
    return total + Number(mod[key] || 0) * (mod.uptime ?? 1);
  }, 0);
}
function values(scenario, ctx, types = ["all"]) {
  const mods = scenario.mods || [];
  const str = stat(scenario, "str") * (1 + modTotal(mods, "strPct", types) / 100);
  const agi = stat(scenario, "agi") * (1 + modTotal(mods, "agiPct", types) / 100);
  const cls = String(scenario.class || "").toLowerCase();
  const ranged = scenario.role === "ranged";
  const formula = ranged ? ctx.get("rangedApFormulas")[cls] : ctx.get("meleeApFormulas")[cls];
  if (!formula) throw new Error(`unsupported class for ${scenario.role || "melee"} AP: ${scenario.class}`);
  const baseAp = ranged
    ? formula[0] * scenario.level + formula[1] * agi + formula[2] + stat(scenario, "rap")
    : formula[0] * scenario.level + formula[1] * str + formula[2] * agi + formula[3];
  const ap = (baseAp + stat(scenario, "ap") + modTotal(mods, "apFlat", types)) *
    (1 + modTotal(mods, "apPct", types) / 100);
  return { str, agi, ap, sp: stat(scenario, "sp") + modTotal(mods, "spFlat", types) };
}
function armorReduction(armor, level, ctx = context({})) {
  const formula = ctx.get(level < 60 ? "armorLow" : "armorHigh");
  const denominator = level * formula.perLevel + formula.base;
  return clamp(armor / (armor + denominator), 0, ctx.get("armorCapPct") / 100);
}
function attackTable(scenario, ctx, kind, critPct = 0, hitPct = 0) {
  const target = scenario.target || {};
  const targetLevel = target.level ?? scenario.level;
  const defense = target.defense ?? targetLevel * 5;
  const skill = stat(scenario, "weaponSkill") || scenario.level * 5;
  const d = defense - skill;
  const delta = Math.max(0, targetLevel - scenario.level);
  let miss;
  let dodge;
  let parry = 0;
  if (target.player) {
    miss = ctx.get("meleeMiss").base + d * ctx.get("pvpMissPerPoint");
    dodge = target.dodgePct ?? ctx.get("dodge").base;
    if (scenario.fromFront) parry = target.parryPct ?? ctx.get("dodge").base;
  } else {
    const missRule = ctx.get("meleeMiss");
    miss = missRule.base + d * (d <= 10 ? missRule.perSkillLow : missRule.perSkillHigh);
    const dodgeRule = ctx.get("dodge");
    dodge = dodgeRule.base + d * dodgeRule.perSkill;
    if (scenario.fromFront) {
      parry = delta >= 3 ? ctx.get("parryPlus3Pct") : missRule.base + d * ctx.get("parryPerSkill");
    }
  }
  if (kind === "white" && (scenario.dualWield || scenario.weapon?.offhand)) miss += ctx.get("dualWieldWhiteMissPct");
  const suppression = !target.player && d > 10 ? (d - 10) * ctx.get("hitSuppressionPerSkill") : 0;
  miss = clamp(miss - Math.max(0, hitPct - suppression), 0, 100);
  dodge = clamp(dodge, 0, 100);
  parry = clamp(parry, 0, 100);
  let glance = 0;
  let glanceMult = 1;
  if (kind === "white" && !target.player) {
    const rule = ctx.get("glance");
    glance = clamp(rule.base + (defense - Math.min(scenario.level * 5, skill)) * rule.perSkill, 0, 100);
    const low = ctx.get("glanceLow");
    const high = ctx.get("glanceHigh");
    glanceMult = (Math.min(low.base - low.perSkill * d, low.cap) +
      Math.min(Math.max(high.base - high.perSkill * d, high.floor), high.cap)) / 2;
  }
  let crit = critPct - delta * ctx.get("critSuppressionPerLevel");
  if (delta >= 3) crit -= ctx.get("critAuraSuppressionPlus3");
  crit = clamp(crit, 0, 100);
  const missP = miss / 100;
  const dodgeP = Math.min(dodge / 100, 1 - missP);
  const parryP = Math.min(parry / 100, 1 - missP - dodgeP);
  const landed = 1 - missP - dodgeP - parryP;
  const glanceP = Math.min(glance / 100, landed);
  const critP = Math.min(crit / 100, landed - glanceP);
  return { miss: missP, dodge: dodgeP, parry: parryP, landed, glance: glanceP,
    glanceMult, crit: critP, critChance: crit / 100, hit: landed - glanceP - critP };
}
function tankResult(scenario, ctx) {
  const targetLevel = scenario.target?.level ?? 63;
  const gap = Math.max(0, targetLevel * 5 - scenario.level * 5);
  const perPoint = ctx.get("defensePerPoint");
  const defense = stat(scenario, "defense") || scenario.level * 5;
  const penalty = gap * perPoint;
  const miss = clamp(ctx.get("meleeMiss").base + (defense - scenario.level * 5) * perPoint - penalty, 0, 100);
  const dodge = clamp(stat(scenario, "dodgePct") - penalty, 0, 100);
  const parry = stat(scenario, "parryPct") > 0 ? clamp(stat(scenario, "parryPct") - penalty, 0, 100) : 0;
  const block = stat(scenario, "blockPct") > 0 ? clamp(stat(scenario, "blockPct") - penalty, 0, 100) : 0;
  const avoidancePct = miss + dodge + parry + block;
  const critOnTankPct = Math.max(0, ctx.get("bossCritBase") + (targetLevel * 5 - defense) * perPoint);
  const crushChancePct = targetLevel - scenario.level >= 3 ? ctx.get("crushPlus3Pct") : 0;
  const hp = scenario.hp || 0;
  ctx.get("hpPerSta");
  const effectiveHealth = hp / (1 - armorReduction(stat(scenario, "armor"), targetLevel, ctx));
  return { effectiveHealth, avoidancePct, critOnTankPct, crushChancePct,
    crushingCovered: avoidancePct >= 100, sheetTotalNeededPct: 100 + 4 * penalty,
    incomingTable: { miss, dodge, parry, block } };
}

function evaluate(scenario, options = {}) {
  if (!scenario || !Number.isFinite(scenario.level) || !Array.isArray(scenario.abilities)) {
    throw new Error("scenario requires level and abilities[]");
  }
  const ctx = context(scenario);
  const mods = scenario.mods || [];
  const abilities = [];
  let totalDps = 0;
  for (const ability of scenario.abilities) {
    if (!ability.name || !["white", "yellow", "spell", "dot"].includes(ability.kind))
      throw new Error("each ability needs a name and valid kind");
    const spell = ability.kind === "spell" || ability.kind === "dot";
    const types = spell ? ["spell", ability.kind] : [ability.kind, ...(ability.hand === "off" ? ["offhand"] : [])];
    const mod = key => modTotal(mods, key, types);
    const player = values(scenario, ctx, types);
    const critBonus = ctx.get(spell ? "spellCritBonus" : "meleeCritBonus");
    const critMult = 1 + critBonus * (1 + mod("critDamagePct") / 100);
    const haste = 1 + (stat(scenario, "hastePct") + mod("hastePct")) / 100;
    if (haste <= 0) throw new Error("haste must leave positive attack speed");
    const weapon = ability.weapon || (ability.hand === "off" ? scenario.weapon?.offhand : scenario.weapon) || {};
    const speed = ability.speed || weapon.speed || 2;
    const interval = ability.kind === "white"
      ? speed / haste : Math.max(ability.cooldown || 0, (ability.castTime || 0) / haste, ctx.get("gcdSeconds"));
    let castsPerMinute = 60 / interval;
    let averageDamagePerCast;
    if (spell) {
      const delta = Math.max(0, (scenario.target?.level ?? scenario.level) - scenario.level);
      const misses = ctx.get("spellMissByDelta");
      const baseMiss = misses[Math.min(delta, 3)] +
        (delta > 3 ? (delta - 3) * ctx.get("spellMissBeyond3PerLevel") : 0);
      const miss = clamp(baseMiss - stat(scenario, "spellHitPct") - mod("spellHitPct"),
        ctx.get("spellMissFloorPct"), 100) / 100;
      const crit = clamp(stat(scenario, "spellCritPct") + mod("spellCritPct") + mod("critPct"), 0, 100) / 100;
      const base = ((ability.baseMin || 0) + (ability.baseMax ?? ability.baseMin ?? 0)) / 2 +
        (ability.coeff || 0) * player.sp + (ability.flat || 0);
      const resistCap = ctx.get("averageResist");
      const resist = clamp(resistCap * (scenario.target?.resist || 0) / (5 * scenario.level), 0, resistCap);
      averageDamagePerCast = base * (1 - miss) * (1 + crit * (critMult - 1)) * (1 - resist);
    } else {
      const table = attackTable(scenario, ctx, ability.kind,
        stat(scenario, "critPct") + mod("critPct"), stat(scenario, "hitPct") + mod("hitPct"));
      const apSpeed = ability.kind === "yellow" && ability.normalized
        ? weapon.normalizedSpeed || scenario.weapon?.normalizedSpeed || speed : speed;
      const weaponDamage = ((weapon.min || 0) + (weapon.max ?? weapon.min ?? 0)) / 2 +
        player.ap / ctx.get("apPerDps") * apSpeed;
      const base = ability.baseMin !== undefined
        ? (ability.baseMin + (ability.baseMax ?? ability.baseMin)) / 2 + (ability.flat || 0)
        : weaponDamage * (ability.weaponPct ?? 1) + (ability.flat || 0);
      let multiplier = table.hit + table.glance * table.glanceMult + table.crit * critMult;
      if (ability.kind === "yellow" && ctx.get("yellowTwoRoll")) {
        multiplier = table.landed * (1 + table.critChance * (critMult - 1));
      }
      const hand = ability.hand === "off" ? ctx.get("offhandDamagePct") / 100 : 1;
      averageDamagePerCast = base * multiplier * hand *
        (1 - armorReduction(scenario.target?.armor || 0, scenario.level, ctx));
    }
    averageDamagePerCast *= 1 + mod("damagePct") / 100;
    const dps = averageDamagePerCast * castsPerMinute / 60;
    totalDps += dps;
    abilities.push({ name: ability.name, castsPerMinute, averageDamagePerCast, dps });
  }
  if (scenario.resourcePerSecond !== undefined) {
    const spend = abilities.reduce((sum, ability, index) =>
      sum + ability.castsPerMinute * (scenario.abilities[index].cost || 0) / 60, 0);
    const factor = spend ? clamp(scenario.resourcePerSecond / spend, 0, 1) : 1;
    totalDps = 0;
    for (let i = 0; i < abilities.length; i++) {
      if (scenario.abilities[i].cost) {
        abilities[i].castsPerMinute *= factor;
        abilities[i].dps *= factor;
      }
      totalDps += abilities[i].dps;
    }
  }
  const tank = scenario.role === "tank" ? tankResult(scenario, ctx) : null;
  if (options.weights) {
    if (scenario.role === "tank") ctx.get("agiPerDodgePct");
    else if (scenario.role === "caster") ctx.get("intPerSpellCritPct");
    else ctx.get("agiPerCritPct");
  }
  const warnings = [...ctx.used].filter(key => ctx.data[key].status !== "verified")
    .map(key => `${key} (${ctx.data[key].status})`);
  return { totalDps, abilities, effectiveHealth: tank?.effectiveHealth ?? null,
    avoidancePct: tank?.avoidancePct ?? null, crushingCovered: tank?.crushingCovered ?? null,
    critOnTankPct: tank?.critOnTankPct ?? null, crushChancePct: tank?.crushChancePct ?? null,
    sheetTotalNeededPct: tank?.sheetTotalNeededPct ?? null, incomingTable: tank?.incomingTable ?? null, warnings };
}
function weights(scenario) {
  const base = evaluate(scenario, { weights: true });
  const tank = scenario.role === "tank";
  const stats = tank ? ["armor", "sta", "defense", "agi"]
    : ["str", "agi", "ap", "hitPct", "critPct", "sp", "spellHitPct", "spellCritPct", "int", "weaponSkill"];
  const out = {};
  for (const key of stats) {
    const changed = structuredClone(scenario);
    changed.gear = { ...changed.gear, [key]: (changed.gear?.[key] || 0) + 1 };
    if (tank && key === "sta") {
      changed.hp = (changed.hp || 0) + context(scenario).get("hpPerSta");
    }
    const ratioKey = tank ? "agiPerDodgePct" : scenario.role === "caster" ? "intPerSpellCritPct" : "agiPerCritPct";
    const ratioStat = tank || scenario.role !== "caster" ? "agi" : "int";
    if (key === ratioStat) {
      const ratio = context(scenario).get(ratioKey);
      if (ratio != null) {
        const critKey = tank ? "dodgePct" : scenario.role === "caster" ? "spellCritPct" : "critPct";
        changed.gear[critKey] = (changed.gear[critKey] || 0) + 1 / ratio;
      }
    }
    const next = evaluate(changed);
    out[key] = tank
      ? { effectiveHealth: next.effectiveHealth - base.effectiveHealth,
        avoidancePct: next.avoidancePct - base.avoidancePct }
      : next.totalDps - base.totalDps;
  }
  if (!tank) {
    const main = out[scenario.role === "caster" ? "sp" : "ap"];
    for (const key of stats) out[key] = main ? out[key] / main : 0;
  }
  return out;
}
module.exports = {
  evaluate,
  weights,
  armorReduction,
  attackTable,
  values,
};
const { cli, report } = require("./theorycraft-cli");
module.exports.cli = cli;
module.exports.report = report;
if (require.main === module) process.exitCode = cli();
