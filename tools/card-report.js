#!/usr/bin/env node
"use strict";
// The card's own numbers for #143: the addon's button counts, its per-fight log
// with the "Used the last note?" answers, and the 20-fight
// table of what each note said and what it cost. Rows come from state.json,
// written by the bridge after every fight the card looks at; the counts come
// from the addon's SavedVariables, which is where the buttons write. Nothing
// here reads the game, sends input or changes a file.
const fs = require("node:fs");
const path = require("node:path");

const MAX_COST = 0.01;
const KEEP_SHARE = 0.9;

// One saved row per fight: the addon can ask twice, so the last row wins.
function rowsOf(cards) {
  const byKey = new Map();
  for (const row of Array.isArray(cards) ? cards : []) {
    if (!row || typeof row !== "object" || typeof row.key !== "string") continue;
    byKey.set(row.key, row);
  }
  return [...byKey.values()];
}

// The three counts from the card table in SavedVariables. Null when the file
// has no card table, so the caller prints nothing instead of three zeros.
function savedCounts(text) {
  const at = String(text || "").search(/\["card"\]/);
  if (at < 0) return null;
  const block = String(text).slice(at, at + 4000);
  const table = /\["counts"\]\s*=\s*\{([\s\S]*?)\}/.exec(block);
  if (!table) return null;
  const n = (k) => {
    const m = new RegExp(`\\["${k}"\\]\\s*=\\s*(\\d+)`).exec(table[1]);
    return m ? Number(m[1]) : 0;
  };
  return { got: n("got"), why: n("why"), no: n("no") };
}

// The per-fight log from the card table: rows { key, shown, answer, why, used }.
// Rows hold flat fields only, so each row is the text between one brace pair.
// Null when the file has no card log (an older addon), so the caller can say so.
function savedLog(text) {
  const src = String(text || "");
  const card = src.search(/\["card"\]/);
  if (card < 0) return null;
  const at = src.slice(card).search(/\["log"\]\s*=\s*\{/);
  if (at < 0) return null;
  let i = src.indexOf("{", card + at);
  let depth = 0;
  let start = -1;
  const rows = [];
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      depth++;
      if (depth === 2) start = i;
    } else if (ch === "}") {
      if (depth === 2) rows.push(rowOfLua(src.slice(start + 1, i)));
      if (--depth === 0) break;
    }
  }
  return rows.filter((r) => r.key);
}

function rowOfLua(body) {
  const str = (k) => (new RegExp(`\\["${k}"\\]\\s*=\\s*"([^"]*)"`).exec(body) || [])[1];
  const bool = (k) => {
    const m = new RegExp(`\\["${k}"\\]\\s*=\\s*(true|false)`).exec(body);
    return m ? m[1] === "true" : undefined;
  };
  return { key: str("key"), answer: str("answer"), shown: bool("shown"), why: bool("why"), used: bool("used") };
}

function money(n) {
  return "$" + n.toFixed(5);
}

function state(ok) {
  return ok ? "PASS" : "FAIL";
}

// The two acceptance numbers (#143): notes that kept their counted facts and
// the cost of one note, plus the pull counts the addon holds.
function summarise(cards, saved, log) {
  const rows = rowsOf(cards);
  const noted = rows.filter((r) => r.check);
  const kept = noted.filter((r) => r.source === "model").length;
  const known = noted.filter((r) => typeof r.cost === "number");
  const spent = known.reduce((sum, r) => sum + r.cost, 0);
  const per = known.length ? spent / known.length : 0;
  const dearest = known.reduce((m, r) => Math.max(m, r.cost), 0);

  const keepState = rows.length < 20 || !noted.length
    ? "PENDING"
    : state(kept / noted.length >= KEEP_SHARE);
  const costState = !noted.length || known.length < noted.length
    ? "PENDING"
    : state(dearest < MAX_COST); // "under $0.01 each": the dearest note decides, not the mean
  // "Used the last note?" answers (Yes / No), one per note after the first; the
  // verdict is the share of Yes, at 3 of 5 answers (#143).
  const used = new Map((log || []).filter((r) => typeof r.used === "boolean").map((r) => [r.key, r.used]));
  const asked = used.size;
  const yes = [...used.values()].filter(Boolean).length;
  const uses = asked < 5 ? "PENDING" : state(yes >= 3);

  const lines = [
    "CARD MEASURE",
    `Fights: ${rows.length} (notes ${noted.length}, quiet ${rows.length - noted.length})`,
    `Kept: ${kept} of ${noted.length}` +
      (noted.length ? ` (${Math.round((100 * kept) / noted.length)}%) ` : " ") +
      `${keepState} (${KEEP_SHARE * 100}% of the notes)`,
    `Cost: ${money(spent)} over ${known.length} of ${noted.length} notes, ` +
      `${known.length ? money(per) : "$?"} a note, dearest ${money(dearest)} ${costState} (each under ${money(MAX_COST)})`,
  ];
  if (saved) {
    lines.push(`Card counts: got ${saved.got}, why ${saved.why}, no ${saved.no}`);
  } else {
    lines.push("Card counts: not read (give --saved <Runback.lua>)");
  }
  lines.push(
    `Used the last note: yes ${yes} of ${asked} answers ${uses} (at 3 of 5)` +
      (log ? "" : " (no per-fight log read: give --saved <Runback.lua> from an addon that keeps it)"),
  );
  lines.push(
    "| # | fight | s | hits | casts | int | deaths | gap | burst | check | note | cost | used |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---|",
  );
  rows.forEach((r, i) => {
    const c = r.counts || {};
    lines.push(
      `| ${i + 1} | ${String(r.key).split("/")[0]} | ${c.duration_s ?? "-"} | ${c.hits ?? "-"} | ` +
        `${c.enemyCasts ?? "-"} | ${c.interrupts ?? "-"} | ${c.deaths ?? "-"} | ${c.idle_s ?? "-"} | ` +
        `${c.burst_hits ?? "-"} | ${r.check || "none"} | ${r.source || "-"} | ` +
        `${typeof r.cost === "number" ? money(r.cost) : "-"} | ${used.has(r.key) ? (used.get(r.key) ? "yes" : "no") : "-"} |`,
    );
  });
  const failed = [keepState, costState, uses].includes("FAIL");
  return { lines, failed };
}

function argsOf(argv) {
  const o = { state: path.join(__dirname, "..", "bridge", "state.json") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help") return null;
    if (!["--state", "--saved"].includes(k) || !argv[i + 1])
      throw new Error("usage: node tools/card-report.js [--state bridge/state.json] [--saved <Runback.lua>]");
    o[k.slice(2)] = argv[++i];
  }
  return o;
}

function main(o) {
  let cards = [];
  try {
    const s = JSON.parse(fs.readFileSync(o.state, "utf8"));
    cards = (s.forever && s.forever.cards) || [];
  } catch (e) {
    console.error(`cannot read ${o.state}: ${e.message}`);
    return 2;
  }
  let saved = null;
  let log = null;
  if (o.saved) {
    try {
      const text = fs.readFileSync(o.saved, "utf8");
      saved = savedCounts(text);
      log = savedLog(text);
      if (!saved) console.error(`no card counts in ${o.saved}`);
    } catch (e) {
      console.error(`cannot read ${o.saved}: ${e.message}`);
      return 2;
    }
  }
  const r = summarise(cards, saved, log);
  console.log(r.lines.join("\n"));
  return r.failed ? 1 : 0;
}

if (require.main === module) {
  try {
    const o = argsOf(process.argv.slice(2));
    if (!o) {
      console.log("Usage: node tools/card-report.js [--state bridge/state.json] [--saved <Runback.lua>]");
      process.exit(0);
    }
    process.exitCode = main(o);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}

module.exports = {
  rowsOf,
  savedCounts,
  savedLog,
  summarise,
};
