#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const DEFAULT_SOURCES = require("./policy-sources.json");
function htmlText(html) {
  return (
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/\s+/g, " ")
      .trim() + "\n"
  );
}
async function fetchText(source, fetcher = globalThis.fetch) {
  let url = source.url;
  if (/forums\.blizzard\.com/.test(url)) url += ".json";
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (/forums\.blizzard\.com/.test(url)) {
    const data = JSON.parse(body);
    const posts = data.post_stream?.posts || [];
    return posts.map((p) => htmlText(p.cooked)).join("\n");
  }
  return htmlText(body);
}
function diff(oldText, newText) {
  const old = new Set(oldText.split(/\r?\n/).filter(Boolean)),
    now = new Set(newText.split(/\r?\n/).filter(Boolean));
  return (
    [
      ...[...old].filter((x) => !now.has(x)).map((x) => `-${x}`),
      ...[...now].filter((x) => !old.has(x)).map((x) => `+${x}`),
    ].join("\n") + "\n"
  );
}
function notify(cmd, summary) {
  return new Promise((resolve, reject) => {
    const [exe, ...args] = cmd;
    const child = spawn(exe, args, {
      stdio: ["pipe", "ignore", "inherit"],
      shell: false,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`notify command exited ${code}`)),
    );
    child.stdin.end(summary);
  });
}
async function watch({
  snapshotDir = "policy/snapshot",
  sources = DEFAULT_SOURCES,
  fetcher = globalThis.fetch,
  notifyCommand,
  now = new Date(),
} = {}) {
  const root = path.resolve(snapshotDir, ".."),
    changesDir = path.join(root, "changes");
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.mkdir(changesDir, { recursive: true });
  const statePath = path.join(root, "state.json");
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {}
  const changed = [],
    baselined = [],
    failed = [],
    summaries = [];
  for (const s of sources) {
    try {
      const content = await fetchText(s, fetcher),
        hash = crypto.createHash("sha256").update(content).digest("hex"),
        dest = path.join(snapshotDir, `${s.slug}.txt`);
      let prior;
      try {
        prior = await fs.readFile(dest, "utf8");
      } catch {}
      if (prior === undefined) {
        await fs.writeFile(dest, content);
        baselined.push(s.slug);
      } else if (
        crypto.createHash("sha256").update(prior).digest("hex") !== hash
      ) {
        await fs.writeFile(
          path.join(
            changesDir,
            `${now.toISOString().slice(0, 10)}-${s.slug}.diff`,
          ),
          diff(prior, content),
        );
        await fs.writeFile(dest, content);
        changed.push(s.slug);
        summaries.push(`${s.slug} changed`);
      }
      state[s.slug] = { failures: 0, hash };
    } catch (e) {
      const old = state[s.slug] || {};
      old.failures = (old.failures || 0) + 1;
      old.error = String(e.message || e);
      state[s.slug] = old;
      failed.push(s.slug);
      if (old.failures >= 2)
        summaries.push(
          `${s.slug} fetch failed ${old.failures} consecutive times: ${old.error}`,
        );
    }
  }
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
  const alert = [
    ...new Set([
      ...changed,
      ...sources
        .filter(
          (s) => (state[s.slug]?.failures || 0) >= 2 && failed.includes(s.slug),
        )
        .map((s) => s.slug),
    ]),
  ];
  if (changed.length || alert.some((s) => !changed.includes(s)))
    await fs.writeFile(
      path.join(root, "ALERT.json"),
      JSON.stringify({ changed: alert, at: now.toISOString() }, null, 2) + "\n",
    );
  if (notifyCommand && summaries.length)
    await notify(notifyCommand, summaries.join("\n") + "\n");
  return {
    baselined,
    changed,
    failed,
    state,
    summary: baselined.length
      ? `baseline: ${baselined.join(", ")}`
      : changed.length
        ? `changed: ${changed.join(", ")}`
        : "unchanged",
  };
}
function cliArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--snapshot-dir") o.snapshotDir = argv[++i];
    else if (argv[i] === "--notify")
      o.notifyCommand = argv[++i]?.trim().split(/\s+/);
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return o;
}
if (require.main === module)
  watch(cliArgs(process.argv.slice(2)))
    .then((r) => console.log(r.summary))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
module.exports = {
  watch,
  fetchText,
  htmlText,
  diff,
};
