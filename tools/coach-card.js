#!/usr/bin/env node
"use strict";
// Between-pull coach card (launch 10, #140): the checks are counted here, in code,
// from the game's own combat log file. The model only writes the one sentence, and
// its numbers are checked against these counts before the card can show.
// Nothing here reads the game, sends input or plays for the player.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { stamp, firstLast, seekAt } = require("./slice-fight");

// "Character: Brakka on Testrealm, level 12 Warrior (Alliance)" -> "Brakka-Testrealm",
// the name the log writes. A missing character line gives no player, and no card.
function playerName(ctxText) {
  const m = /(?:^|\n)Character:\s*([^,\s]+)(?:\s+on\s+([^,]+))?/.exec(
    String(ctxText || ""),
  );
  if (!m) return "";
  const realm = (m[2] || "").trim().replace(/\s+/g, "-");
  return realm ? `${m[1]}-${realm}` : m[1];
}

// "lastFight=start=2026-09-25T20:00:10,end=2026-09-25T20:00:43" in the addon's context.
function fightWindow(ctxText) {
  const m =
    /(?:^|\n)lastFight=[^\n]*?\bstart=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)[^\n]*?\bend=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(
      String(ctxText || ""),
    );
  if (!m) return null;
  const start = Date.parse(m[1]),
    end = Date.parse(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, startISO: m[1], endISO: m[2] };
}

// Lines of every log file that overlaps the window, with the time in each line.
// Null when there is no folder or no log: the caller then shows no card.
async function readWindow(dir, start, end) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return null;
  }
  names = names.filter((n) =>
    /^WoWCombatLog(?:-\d{6}_\d{6})?\.txt$/i.test(n),
  );
  const files = [];
  for (const n of names) {
    const p = path.join(dir, n);
    const range = await firstLast(p).catch(() => null);
    if (range && range.first <= end && range.last >= start)
      files.push({ p, first: range.first });
  }
  files.sort((a, b) => a.first - b.first);
  const out = [];
  for (const file of files) {
    const offset = start <= file.first ? 0 : await seekAt(file.p, start);
    const input = fs.createReadStream(file.p, { start: offset });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const t = stamp(line);
      if (!Number.isFinite(t)) continue;
      if (t > end) break;
      if (t >= start) out.push(line);
    }
  }
  return out;
}

// Event name, source and destination, as every log layout shares them
// (the advanced block only comes after these fields).
function fields(event) {
  const out = [];
  let cur = "",
    quoted = false;
  for (const ch of event) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// What the file can prove about one fight. Every number the card may use is here.
function count(lines, o) {
  const start = o.start,
    end = o.end;
  let deaths = 0,
    enemyCasts = 0,
    interrupts = 0,
    hits = 0;
  const own = [],
    hitTimes = [];
  for (const line of lines || []) {
    const t = stamp(line);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    const event = line.slice(line.indexOf("  ") + 2);
    const f = fields(event);
    const name = f[0],
      src = f[2],
      dst = f[6];
    if (name === "UNIT_DIED") {
      if (dst === o.player) deaths++;
      continue;
    }
    if (name === "SPELL_CAST_START") {
      if (src !== o.player) enemyCasts++;
      continue;
    }
    if (name === "SPELL_INTERRUPT") {
      if (src === o.player) interrupts++;
      continue;
    }
    if (!/_DAMAGE$/.test(name)) {
      if (name === "SPELL_CAST_SUCCESS" && src === o.player) own.push(t);
      continue;
    }
    if (src === o.player) own.push(t);
    else if (dst === o.player) {
      hits++;
      hitTimes.push(t);
    }
  }
  own.sort((a, b) => a - b);
  let idle = 0;
  for (let i = 1; i < own.length; i++)
    idle = Math.max(idle, Math.floor((own[i] - own[i - 1]) / 1000));
  hitTimes.sort((a, b) => a - b);
  let burst = 0,
    burstS = 0;
  for (let i = 0; i < hitTimes.length; i++) {
    let j = i;
    while (j + 1 < hitTimes.length && hitTimes[j + 1] - hitTimes[i] <= 3000) j++;
    if (j - i + 1 > burst) {
      burst = j - i + 1;
      burstS = Math.max(0, Math.floor((hitTimes[j] - hitTimes[i]) / 1000));
    }
  }
  return {
    duration_s: Math.max(0, Math.round((end - start) / 1000)),
    deaths,
    enemyCasts,
    interrupts,
    hits,
    idle_s: idle,
    burst_hits: burst,
    burst_s: burstS,
  };
}

// The one check worth a note, most actionable first. Null means say nothing.
function pick(c) {
  if (c.enemyCasts >= 2 && c.interrupts === 0)
    return { rule: "interrupt", n: c.enemyCasts };
  if (c.burst_hits >= 4) return { rule: "burst", n: c.burst_hits, s: c.burst_s };
  if (c.idle_s >= 5) return { rule: "idle", n: c.idle_s };
  if (c.deaths >= 1) return { rule: "death", n: c.deaths };
  return null;
}

// The sentence used when the model fails or invents a number.
function change(check) {
  if (check.rule === "interrupt") return "interrupt the caster's next cast.";
  if (check.rule === "burst") return "step out or use a cooldown when several hits land at once.";
  if (check.rule === "idle") return "keep attacking; the gaps cost you damage.";
  return "wait for full health before the next pull.";
}

// The "Why" line: always written here, so it can never hold an invented number.
function reason(check, c) {
  if (check.rule === "interrupt")
    return `${c.enemyCasts} enemy casts went off and ${c.interrupts === 0 ? "none were" : c.interrupts + " were"} interrupted.`;
  if (check.rule === "burst")
    return `${c.burst_hits} hits landed on you within ${c.burst_s} s.`;
  if (check.rule === "idle")
    return `you did nothing for ${c.idle_s} s of the ${c.duration_s} s pull.`;
  return `you died ${c.deaths} ${c.deaths === 1 ? "time" : "times"} in ${c.duration_s} s.`;
}

// What the "Why?" button adds: the counts behind the card, as they came from the file.
function countsLine(c) {
  return `${c.duration_s} s pull, ${c.hits} hits taken, ${c.enemyCasts} enemy casts, ${c.interrupts} interrupted, ${c.deaths} deaths, ${c.idle_s} s longest gap.`;
}

// The numbers a sentence may use: exactly the counts above.
function allowedNumbers(c) {
  return new Set(Object.values(c).filter((v) => typeof v === "number"));
}

// True when every number in the sentence is one of the counts. The model writes
// the sentence, so this is what keeps an invented number off the card.
function numbersOk(text, c) {
  const s = String(text || "").trim();
  if (!s || s.length > 160 || /[\r\n]/.test(s)) return false;
  const allowed = allowedNumbers(c);
  for (const m of s.matchAll(/\d+/g)) if (!allowed.has(Number(m[0]))) return false;
  return true;
}

function modelPrompt(c, check) {
  return [
    "You are the after-fight coach in a fantasy online game. One fight has ended.",
    "The numbers below were counted from the game's combat log by code. Use them as the only facts.",
    `Counts: ${JSON.stringify(c)}`,
    `The check to speak about: ${check.rule}.`,
    "Write ONE sentence of at most 15 words that names the single change for the next pull.",
    "Use only numbers from the counts above, and only if the sentence needs one; no other number.",
    "Advice only: never a command, macro, script or in-game action for the player.",
    "Reply with the sentence alone, no quotes, no heading.",
  ].join("\n");
}

function argsOf(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help") return null;
    if (!["--logs", "--start", "--end", "--player"].includes(k) || !argv[i + 1])
      throw new Error(
        "usage: node tools/coach-card.js --logs <dir> --start <iso> --end <iso> --player <Name-Realm>",
      );
    o[k.slice(2)] = argv[++i];
  }
  for (const k of ["logs", "start", "end", "player"])
    if (!o[k]) throw new Error(`missing --${k}`);
  for (const k of ["start", "end"])
    if (!Number.isFinite(Date.parse(o[k]))) throw new Error(`invalid --${k} ISO date`);
  return o;
}

async function main(o) {
  const start = Date.parse(o.start),
    end = Date.parse(o.end);
  const lines = await readWindow(o.logs, start - 3000, end + 3000);
  if (!lines || !lines.length) {
    console.error("No usable combat log for that fight: no card.");
    return 3;
  }
  const c = count(lines, { player: o.player, start, end });
  const check = pick(c);
  console.log(`# counts ${JSON.stringify(c)}`);
  if (!check) {
    console.log("# no check fired: no card");
    return 0;
  }
  console.log(`# check ${check.rule}`);
  console.log(`One change: ${change(check)}`);
  console.log(`Why: ${reason(check, c)}`);
  return 0;
}

if (require.main === module) {
  try {
    const o = argsOf(process.argv.slice(2));
    if (!o) {
      console.log(
        "Usage: node tools/coach-card.js --logs <dir> --start <iso> --end <iso> --player <Name-Realm>",
      );
      process.exit(0);
    }
    main(o).then(
      (c) => {
        process.exitCode = c;
      },
      (e) => {
        console.error(e.message);
        process.exitCode = 2;
      },
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}

module.exports = {
  argsOf,
  playerName,
  fightWindow,
  readWindow,
  fields,
  count,
  pick,
  change,
  reason,
  countsLine,
  allowedNumbers,
  numbersOk,
  modelPrompt,
};
