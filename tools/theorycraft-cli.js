"use strict";
const fs = require("node:fs");
const { evaluate, weights } = require("./theorycraft");

function report(scenario, result, statWeights) {
  const lines = [`${scenario.class} level ${scenario.level} ${scenario.role}: ${result.totalDps.toFixed(2)} DPS`];
  for (const ability of result.abilities) {
    lines.push(`  ${ability.name}: ${ability.castsPerMinute.toFixed(2)} casts/min, ` +
      `${ability.averageDamagePerCast.toFixed(2)} damage/cast, ${ability.dps.toFixed(2)} DPS`);
  }
  if (result.effectiveHealth !== null) {
    lines.push(`Effective health: ${result.effectiveHealth.toFixed(2)}; avoidance ` +
      `${result.avoidancePct.toFixed(2)}%; crushing blows ${result.crushingCovered ? "covered" : "not covered"}; ` +
      `sheet total needed ${result.sheetTotalNeededPct.toFixed(2)}%`);
  }
  if (statWeights) lines.push(`Weights: ${JSON.stringify(statWeights)}`);
  if (result.warnings.length) {
    lines.push(`Warning: ${result.warnings.join(", ")}. Forever may differ: override from ` +
      "mentor/forever-facts/ when a Forever value is known");
  }
  if (scenario.resourcePerSecond !== undefined) {
    lines.push("ponytail: Resource limits scale casts proportionally; this is not a rotation sim. " +
      "On-next-swing abilities and rage are not modeled.");
  }
  return lines.join("\n");
}

function cli(argv = process.argv.slice(2)) {
  try {
    const positional = [];
    let wantWeights = false;
    let json = false;
    let compare;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--weights") wantWeights = true;
      else if (argv[i] === "--json") json = true;
      else if (argv[i] === "--compare") compare = argv[++i];
      else positional.push(argv[i]);
    }
    if (!positional[0]) throw new Error("usage: node tools/theorycraft.js <scenario.json> [--weights] [--compare <other.json>] [--json]");
    const scenario = JSON.parse(fs.readFileSync(positional[0], "utf8"));
    const result = evaluate(scenario, { weights: wantWeights });
    const statWeights = wantWeights ? weights(scenario) : null;
    let comparison = null;
    if (compare) {
      const other = JSON.parse(fs.readFileSync(compare, "utf8"));
      const next = evaluate(other);
      const first = scenario.role === "tank" ? result.effectiveHealth : result.totalDps;
      const second = other.role === "tank" ? next.effectiveHealth : next.totalDps;
      comparison = { first, second, deltaPct: first ? (second / first - 1) * 100 : 0 };
    }
    if (json) console.log(JSON.stringify({ result, weights: statWeights, comparison }, null, 2));
    else {
      console.log(report(scenario, result, statWeights));
      if (comparison) console.log(`Compare: ${comparison.first.toFixed(2)} vs ${comparison.second.toFixed(2)}; ` +
        `delta ${comparison.deltaPct >= 0 ? "+" : ""}${comparison.deltaPct.toFixed(2)}%`);
    }
    return 0;
  } catch (error) {
    console.error(`theorycraft: ${error.message}`);
    return 2;
  }
}


module.exports = {
  cli,
  report,
};
