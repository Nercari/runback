#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const TS_RE = /^\d{1,2}\/\d{1,2}(?:\/\d{4})? \d{2}:\d{2}:\d{2}\.\d{3}\d*(?:[+-]\d{1,2}(?::?\d{2})?)?/;

function argsOf(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help") return null;
    if (!["--review", "--slice", "--death", "--notebook"].includes(k) || !argv[i + 1]) {
      throw new Error(
        "usage: node tools/check-citations.js --review <file> --slice <file> [--death <file>] [--notebook <file>]"
      );
    }
    const key = k.slice(2);
    o[key] = argv[++i];
  }
  for (const k of ["review", "slice"]) {
    if (!o[k]) throw new Error(`missing --${k}`);
  }
  return o;
}

function parseSourceLines(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function cleanCitation(text) {
  return text.trim().replace(/\s*(?:…|\.{3})$/, "").trimEnd();
}

function isValidCitation(clean, sourceLines) {
  for (const src of sourceLines) {
    if (!src.startsWith(clean)) continue;
    const twoSpaces = src.indexOf("  ");
    if (twoSpaces < 0) continue;
    if (clean.length < twoSpaces + 2) continue;
    const comma = src.indexOf(",", twoSpaces + 2);
    const minLen = comma >= 0 ? comma : src.length;
    if (clean.length >= minLen) return true;
  }
  return false;
}

function checkScorecard(notebook, problems) {
  const sectionMatch = notebook.match(/(?:^|\n)##\s+Scorecard\b([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (!sectionMatch) {
    problems.push("missing ## Scorecard section");
    return;
  }
  const blockMatch = sectionMatch[1].match(/```json\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (!blockMatch) {
    problems.push("missing scorecard JSON block");
    return;
  }
  const blockLines = blockMatch[1].split(/\r?\n/);
  let lineNum = 0;
  for (const raw of blockLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    lineNum++;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      problems.push(`scorecard line ${lineNum}: invalid JSON`);
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      problems.push(`scorecard line ${lineNum}: expected JSON object`);
      continue;
    }
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || Number.isNaN(Date.parse(row.date))) {
      problems.push(`scorecard line ${lineNum}: invalid date (expected YYYY-MM-DD)`);
    }
    if (typeof row.fight !== "string" || !row.fight) {
      problems.push(`scorecard line ${lineNum}: missing or invalid fight`);
    }
    for (const numField of ["deaths", "mistakes"]) {
      if (row[numField] !== undefined && (typeof row[numField] !== "number" || !Number.isFinite(row[numField]))) {
        problems.push(`scorecard line ${lineNum}: ${numField} must be a finite number`);
      }
    }
    for (const numField of ["damage", "durationS"]) {
      if (row[numField] !== undefined && (typeof row[numField] !== "number" || !Number.isFinite(row[numField]) || row[numField] < 0)) {
        problems.push(`scorecard line ${lineNum}: ${numField} must be a number of 0 or more`);
      }
    }
    if (row.kind !== undefined && row.kind !== "dummy") {
      problems.push(`scorecard line ${lineNum}: kind must be "dummy" when present`);
    }
    if (row.activeTimePct !== undefined) {
      if (
        typeof row.activeTimePct !== "number" ||
        !Number.isFinite(row.activeTimePct) ||
        row.activeTimePct < 0 ||
        row.activeTimePct > 100
      ) {
        problems.push(`scorecard line ${lineNum}: activeTimePct must be 0..100`);
      }
    }
  }
}

function check({ review, slice, death, notebook }) {
  const problems = [];
  const sourceLines = [...parseSourceLines(slice), ...parseSourceLines(death)];
  const lines = (review || "").split(/\r?\n/);

  let mistakesEndLine = lines.length;
  let inFenceScan = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*`{3,}/.test(lines[i])) {
      inFenceScan = !inFenceScan;
      continue;
    }
    if (!inFenceScan && /^\s*(?:Since last review|Drill)/i.test(lines[i])) {
      mistakesEndLine = i;
      break;
    }
  }

  const citations = [];
  const mistakes = [];
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)(`{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[2];
        continue;
      }
      if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
        continue;
      }
    }

    if (inFence) {
      let t = line.trim();
      if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) {
        t = t.slice(1, -1).trim();
      }
      if (TS_RE.test(t)) {
        citations.push({ text: t, lineIdx: i });
      }
    } else {
      if (i < mistakesEndLine) {
        const mistMatch = line.match(/^\s*(\d+)\.\s/);
        if (mistMatch) {
          mistakes.push({ num: mistMatch[1], lineIdx: i });
        }
      }
      const spanRegex = /`([^`]+)`/g;
      let m;
      let spans = 0;
      while ((m = spanRegex.exec(line)) !== null) {
        const span = m[1].trim();
        if (TS_RE.test(span)) {
          citations.push({ text: span, lineIdx: i });
          spans++;
        }
      }
      // The strip has no markdown, so agents often quote a log line bare (optionally after "Log:").
      const bare = line.trim().replace(/^Log:\s*/i, "");
      if (!spans && !line.includes("`") && TS_RE.test(bare)) {
        citations.push({ text: bare, lineIdx: i });
      }
    }
  }

  let validCount = 0;
  for (const c of citations) {
    const clean = cleanCitation(c.text);
    const valid = isValidCitation(clean, sourceLines);
    c.valid = valid;
    if (valid) {
      validCount++;
    } else {
      problems.push(`invented or altered log line: ${c.text.slice(0, 120)}`);
    }
  }

  if (mistakes.length > 3) {
    problems.push("more than 3 mistakes");
  }

  for (let k = 0; k < mistakes.length; k++) {
    const startLine = mistakes[k].lineIdx;
    const endLine = k + 1 < mistakes.length ? mistakes[k + 1].lineIdx : mistakesEndLine;
    const hasValid = citations.some((c) => c.valid && c.lineIdx >= startLine && c.lineIdx < endLine);
    if (!hasValid) {
      problems.push(`mistake ${mistakes[k].num} has no verified log line`);
    }
  }

  if (notebook !== undefined && notebook !== null) {
    checkScorecard(notebook, problems);
  }

  const zeroAllowed = /not enough data|combat logging was off/i.test(review || "");
  if (citations.length === 0 && !zeroAllowed) {
    problems.push("no log lines quoted");
  }

  const ok = problems.length === 0 && (validCount > 0 || zeroAllowed);
  return { ok, citations: validCount, problems };
}

async function run(o) {
  const review = await fs.promises.readFile(o.review, "utf8");
  const slice = await fs.promises.readFile(o.slice, "utf8");
  const death = o.death ? await fs.promises.readFile(o.death, "utf8") : undefined;
  const notebook = o.notebook ? await fs.promises.readFile(o.notebook, "utf8") : undefined;
  const res = check({ review, slice, death, notebook });
  if (res.ok) {
    console.log(`ok: ${res.citations} citations verified`);
    return 0;
  }
  for (const p of res.problems) {
    console.error(p);
  }
  return 1;
}

if (require.main === module) {
  try {
    const o = argsOf(process.argv.slice(2));
    if (!o) {
      console.log(
        "Usage: node tools/check-citations.js --review <file> --slice <file> [--death <file>] [--notebook <file>]"
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
  check,
  argsOf,
  run,
};
