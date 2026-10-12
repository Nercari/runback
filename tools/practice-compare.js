#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

function rowsOf(notebook) {
  const section = notebook.match(/(?:^|\n)##\s+Scorecard\b([\s\S]*?)(?=\n##\s|\s*$)/i);
  const block = section && section[1].match(/```json\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (!block) return [];
  const rows = [];
  for (const raw of block[1].split(/\r?\n/)) {
    try {
      const row = JSON.parse(raw.trim());
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    } catch {}
  }
  return rows;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function dps(row) {
  const d = num(row.damage),
    s = num(row.durationS);
  return d !== null && s ? Math.round(d / s) : null;
}
function delta(a, b) {
  return a === null || b === null ? null : b - a;
}
// The latest two rows tagged "kind":"dummy", in file order (rows are appended).
function compare(notebook) {
  const dummy = rowsOf(notebook).filter((r) => r.kind === "dummy");
  if (dummy.length < 2) return { ok: false, reason: `need 2 dummy rows, found ${dummy.length}` };
  const [before, after] = dummy.slice(-2);
  return {
    ok: true,
    before,
    after,
    activeTimePct: { before: num(before.activeTimePct), after: num(after.activeTimePct), change: delta(num(before.activeTimePct), num(after.activeTimePct)) },
    damage: { before: num(before.damage), after: num(after.damage), change: delta(num(before.damage), num(after.damage)) },
    dps: { before: dps(before), after: dps(after), change: delta(dps(before), dps(after)) },
  };
}
function format(r) {
  if (!r.ok) return `practice: ${r.reason}`;
  const f = (m, unit = "") => {
    const x = r[m];
    if (x.before === null || x.after === null) return `${m}: not in both rows`;
    return `${m}: ${x.before}${unit} -> ${x.after}${unit} (${x.change >= 0 ? "+" : ""}${x.change}${unit})`;
  };
  return [`practice: ${r.before.date} ${r.before.fight} -> ${r.after.date} ${r.after.fight}`, f("activeTimePct", "%"), f("damage"), f("dps")].join("\n");
}
if (require.main === module) {
  const i = process.argv.indexOf("--notebook");
  if (i < 0 || !process.argv[i + 1]) {
    console.error("usage: node tools/practice-compare.js --notebook <characters/Realm-Name.md> [--json]");
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(process.argv[i + 1], "utf8");
  } catch (e) {
    console.error(`cannot read notebook: ${e.message}`);
    process.exit(2);
  }
  const r = compare(text);
  console.log(process.argv.includes("--json") ? JSON.stringify(r) : format(r));
  process.exitCode = r.ok ? 0 : 1;
}
module.exports = {
  compare,
  format,
  rowsOf,
};
