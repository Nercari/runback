#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function argsOf(argv) {
  const o = { pad: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help") return null;
    if (
      ![
        "--logs",
        "--start",
        "--end",
        "--player",
        "--out",
        "--pad",
        "--death",
      ].includes(k) ||
      !argv[i + 1]
    )
      throw new Error(
        `usage: node tools/slice-fight.js --logs <dir> --start <iso> --end <iso> --player <Name-Realm> --out <file> [--pad 3] [--death <iso>]`,
      );
    const key = k.slice(2);
    o[key] = argv[++i];
  }
  for (const k of ["logs", "start", "end", "player", "out"])
    if (!o[k]) throw new Error(`missing --${k}`);
  for (const k of ["start", "end", "death"])
    if (o[k] && !Number.isFinite(Date.parse(o[k])))
      throw new Error(`invalid --${k} ISO date`);
  o.pad = Number(o.pad);
  if (!Number.isFinite(o.pad) || o.pad < 0) throw new Error("invalid --pad");
  return o;
}
// ponytail: a log without the year (pre-2024 format) is read as this year;
// a fight across New Year's would need the year from the file name.
function stamp(line, year = new Date().getFullYear()) {
  const m = line.match(
    /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))? (\d\d):(\d\d):(\d\d)\.(\d{3})\d*(?:([+-])(\d{1,2})(?::?(\d\d))?)?  /,
  );
  if (!m) return NaN;
  const [, mo, da, yr = year, h, mi, s, ms, sign, oh, om] = m;
  const utc = Date.UTC(+yr, +mo - 1, +da, +h, +mi, +s, +ms);
  return sign
    ? utc - (sign === "+" ? 1 : -1) * (+oh * 60 + +(om || 0)) * 60000
    : new Date(+yr, +mo - 1, +da, +h, +mi, +s, +ms).getTime();
}
function fileNameTime(n) {
  const m = n.match(
    /WoWCombatLog-(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.txt$/i,
  );
  if (!m) return NaN;
  const [, mo, d, y, h, mi, s] = m;
  return new Date(2000 + +y, +mo - 1, +d, +h, +mi, +s).getTime();
}
async function firstLast(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size,
      head = Buffer.alloc(Math.min(65536, size));
    await fh.read(head, 0, head.length, 0);
    let first = NaN,
      version = "";
    for (const l of head.toString("utf8").split(/\r?\n/)) {
      if (VERSION.test(l)) version = l;
      first = stamp(l);
      if (Number.isFinite(first)) break;
    }
    const n = Math.min(65536, size),
      tail = Buffer.alloc(n);
    await fh.read(tail, 0, n, size - n);
    const lines = tail.toString("utf8").split(/\r?\n/).reverse();
    let last = NaN;
    for (const l of lines) {
      last = stamp(l);
      if (Number.isFinite(last)) break;
    }
    return {
      version,
      first: Number.isFinite(first) ? first : fileNameTime(path.basename(file)),
      last: Number.isFinite(last)
        ? last
        : Number.isFinite(first)
          ? first
          : fileNameTime(path.basename(file)),
    };
  } finally {
    await fh.close();
  }
}
async function seekAt(file, target) {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    if (size < 65536) return 0;
    let lo = 0,
      hi = size;
    for (let i = 0; i < 32 && lo < hi; i++) {
      const mid = Math.floor((lo + hi) / 2),
        pos = mid === 0 ? 0 : mid + 1;
      if (pos >= size) {
        hi = mid;
        continue;
      }
      let buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      const end = buf.subarray(0, bytesRead).indexOf(10);
      if (end < 0) {
        lo = pos + bytesRead;
        continue;
      }
      const line = buf.subarray(0, end).toString("utf8");
      const t = stamp(line);
      if (!Number.isFinite(t) || t < target) lo = pos + end + 1;
      else hi = mid;
    }
    let pos = lo === 0 ? 0 : lo;
    if (pos > 0) {
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, pos - 1);
      if (b[0] !== 10) {
        const chunk = Buffer.alloc(65536);
        let at = pos,
          found = false;
        while (at < size && !found) {
          const { bytesRead } = await fh.read(chunk, 0, chunk.length, at);
          const ix = chunk.subarray(0, bytesRead).indexOf(10);
          if (ix >= 0) {
            pos = at + ix + 1;
            found = true;
          } else at += bytesRead;
        }
        if (!found) pos = size;
      }
    }
    return pos;
  } finally {
    await fh.close();
  }
}
// The game writes this header when logging starts, usually long before the fight.
const VERSION = /(?:^|  )COMBAT_LOG_VERSION,/;
const STRUCT =
  /(?:COMBAT_LOG_VERSION|ENCOUNTER_START|ENCOUNTER_END|UNIT_DIED|ZONE_CHANGE|CHALLENGE_MODE_)/;
const DAMAGE = /_(?:DAMAGE|MISSED|ABSORBED)(?:,|$)/;
const HEAL = /_HEAL(?:_ABSORBED)?(?:,|$)/;
// Death recap, as Details! and Blizzard's death recap show it: who hit the
// player, with what and how hard, in the window before the death. Amounts are
// the first suffix field, which every log layout shares; the advanced block
// (19 fields) sits between prefix and suffix when ADVANCED_LOG_ENABLED is 1;
// logs differ on whether it comes before or after the environment type,
// so the environment type is looked up by name rather than by position.
// Not yet checked on a real Forever log.
const ENVIRONMENT = /^(?:Falling|Drowning|Fatigue|Fire|Lava|Slime)$/i;
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
function prefixLength(name) {
  if (name.startsWith("SWING_")) return 0;
  if (name.startsWith("ENVIRONMENTAL_")) return 1;
  return 3;
}
function recap(deathLines, player, advanced, deathAt) {
  const seen = new Set(),
    sources = new Map();
  let damage = 0,
    heals = 0,
    hits = 0,
    firstHit = null,
    killing = null;
  for (const line of deathLines) {
    if (seen.has(line)) continue;
    seen.add(line);
    const f = fields(line.slice(line.indexOf("  ") + 2)),
      name = f[0];
    if (f[6] !== player) continue;
    const pre = prefixLength(name),
      at = 9 + pre + (advanced ? 19 : 0),
      raw = f[at],
      amount = /^\d+$/.test(raw || "") ? Number(raw) : null;
    if (/_HEAL$/.test(name)) {
      if (amount !== null) heals += amount;
      continue;
    }
    if (!/_DAMAGE$/.test(name)) continue;
    const t = stamp(line),
      source = name.startsWith("ENVIRONMENTAL_") ? "Environment" : f[2] || "unknown",
      spell = pre === 0 ? "Melee" : pre === 1 ? f.slice(9, at).find((v) => ENVIRONMENT.test(v)) || "unknown" : f[10] || "unknown",
      key = `${source}\u0000${spell}`,
      row = sources.get(key) || { source, spell, hits: 0, damage: 0, unknown: 0 };
    row.hits++;
    if (amount === null) row.unknown++;
    else row.damage += amount;
    sources.set(key, row);
    hits++;
    if (amount !== null) damage += amount;
    if (firstHit === null && Number.isFinite(t)) firstHit = t;
    killing = { line, source, spell, amount };
  }
  if (!killing) return ["# recap no damage to the player in the window"];
  const out = [];
  const before =
    firstHit !== null && Number.isFinite(deathAt)
      ? `,first-hit=${Math.max(0, (deathAt - firstHit) / 1000).toFixed(1)}s-before`
      : "";
  out.push(`# recap hits=${hits},damage=${damage},heals=${heals}${before}`);
  const at = killing.line.slice(0, killing.line.indexOf("  ")).split(" ")[1] || "";
  out.push(
    `# killing-blow at=${at},source="${killing.source}",spell="${killing.spell}",amount=${killing.amount ?? "?"}`,
  );
  const rows = [...sources.values()].sort((a, b) => b.damage - a.damage || b.hits - a.hits);
  for (const r of rows) {
    const share = damage ? Math.round((r.damage * 100) / damage) : 0,
      unknown = r.unknown ? `,unread=${r.unknown}` : "";
    out.push(
      `# taken source="${r.source}",spell="${r.spell}",hits=${r.hits},damage=${r.damage},share=${share}%${unknown}`,
    );
  }
  return out;
}
function toPlayer(event, player) {
  return fields(event)[6] === player;
}
function isPlayer(line, player) {
  return line.includes(`"${player}"`);
}
async function run(o) {
  const start = Date.parse(o.start) - o.pad * 1000,
    end = Date.parse(o.end) + o.pad * 1000;
  let names = await fs.promises.readdir(o.logs).catch(() => []);
  names = names.filter((n) => /^WoWCombatLog(?:-\d{6}_\d{6})?\.txt$/i.test(n));
  const files = [];
  for (const n of names) {
    const p = path.join(o.logs, n),
      range = await firstLast(p);
    if (range.first <= end && range.last >= start) files.push(p);
  }
  if (!files.length) {
    console.error("Combat logging was off: type /combatlog before the fight");
    return 3;
  }
  const lines = [],
    deathLines = [],
    deathAt = o.death ? Date.parse(o.death) : null;
  let deathSeen = false,
    deathDamage = null;
  for (const file of files) {
    const range = await firstLast(file);
    if (range.version && !lines.includes(range.version)) lines.push(range.version);
    const offset = start <= range.first ? 0 : await seekAt(file, start),
      input = fs.createReadStream(file, { start: offset });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const t = stamp(line);
      if (Number.isFinite(t) && t > end) break;
      if (VERSION.test(line)) {
        if (!lines.includes(line)) lines.push(line);
        continue;
      }
      if (!Number.isFinite(t) || t < start || t > end) continue;
      const event = line.slice(line.indexOf("  ") + 2);
      const structural = STRUCT.test(event);
      if (structural || isPlayer(line, o.player)) lines.push(line);
      if (
        deathAt !== null &&
        t >= deathAt - 15000 &&
        t <= deathAt &&
        isPlayer(line, o.player)
      ) {
        if ((DAMAGE.test(event) || HEAL.test(event)) && toPlayer(event, o.player))
          deathLines.push(line);
      }
      if (
        deathAt !== null &&
        isPlayer(line, o.player) &&
        line.includes("UNIT_DIED")
      )
        deathSeen = true;
      if (
        deathAt !== null &&
        t <= deathAt &&
        isPlayer(line, o.player) &&
        DAMAGE.test(event) &&
        toPlayer(event, o.player)
      )
        deathDamage = line;
    }
  }
  const max = 2 * 1024 * 1024;
  let dropped = 0;
  const header = () =>
    `# slice player=${o.player} start=${o.start} end=${o.end} files=${files.length} lines=${lines.length}${dropped ? `\n# truncated ${dropped} lines` : ""}`;
  let total = lines.reduce(
    (n, line) => n + Buffer.byteLength(line) + 1,
    Buffer.byteLength(header()) + 1,
  );
  if (total > max) {
    const kept = [];
    const reserve = 256;
    for (const line of lines) {
      const size = Buffer.byteLength(line) + 1;
      if (total > max - reserve && !STRUCT.test(line)) {
        total -= size;
        dropped++;
      } else kept.push(line);
    }
    lines.length = 0;
    for (const line of kept) lines.push(line);
  }
  await fs.promises.mkdir(path.dirname(path.resolve(o.out)), {
    recursive: true,
  });
  await fs.promises.writeFile(
    o.out,
    header() + "\n" + lines.join("\n") + (lines.length ? "\n" : ""),
  );
  if (deathAt !== null) {
    if (deathDamage && !deathSeen) deathLines.push(deathDamage);
    const dp = o.out + ".death.txt",
      advanced = lines.some((l) => VERSION.test(l) && /ADVANCED_LOG_ENABLED,1/.test(l)),
      summary = recap(deathLines, o.player, advanced, deathAt);
    await fs.promises.writeFile(
      dp,
      `# death player=${o.player} at=${o.death}\n${summary.join("\n")}\n${deathLines.join("\n")}${deathLines.length ? "\n" : ""}`,
    );
  }
  return 0;
}
if (require.main === module) {
  try {
    const o = argsOf(process.argv.slice(2));
    if (!o) {
      console.log(
        "Usage: node tools/slice-fight.js --logs <dir> --start <iso> --end <iso> --player <Name-Realm> --out <file> [--pad 3] [--death <iso>]",
      );
      process.exit(0);
    }
    run(o)
      .then((c) => {
        process.exitCode = c;
      })
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 2;
      });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
module.exports = {
  argsOf,
  stamp,
  firstLast,
  seekAt,
  run,
  recap,
};
