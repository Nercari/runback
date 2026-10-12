"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { recap, format } = require("../../tools/session-recap");
const TOOL = path.resolve(__dirname, "../../tools/session-recap.js");
const book = (...rows) => ["# Hero", "## Scorecard", "```json", ...rows.map((r) => JSON.stringify(r)), "```", "", "## Drills"].join("\n");

test("counts only the rows of the date and prints five lines", () => {
  const nb = book(
    { date: "2026-10-02", fight: "Old", deaths: 5, top: "x" },
    { date: "2026-10-03", fight: "Hogger", deaths: 1, mistakes: 2, top: "late interrupt", durationS: 90 },
    { date: "2026-10-03", fight: "Wolf", deaths: 0, top: "late interrupt", durationS: 150 },
    { date: "2026-10-03", fight: "Target Dummy", kind: "dummy", top: "idle gaps" },
  );
  const r = recap(nb, "2026-10-03");
  assert.equal(r.fights, 3);
  assert.equal(r.dummy, 1);
  assert.equal(r.deaths, 1);
  assert.equal(r.seconds, 240);
  assert.equal(format(r), [
    "recap: 2026-10-03",
    "fights: 3 reviewed (1 on a target dummy)",
    "deaths: 1 (2 of 3 rows say)",
    "time: 4 min in fights (2 of 3 rows say)",
    'repeat: "late interrupt" (2 times)',
  ].join("\n"));
});

test("a field no row has reads 'not in the rows' and no rows exits 1", () => {
  const nb = book({ date: "2026-10-03", fight: "Hogger" });
  const lines = format(recap(nb, "2026-10-03")).split("\n");
  assert.equal(lines[2], "deaths: not in the rows");
  assert.equal(lines[3], "time: not in the rows");
  assert.equal(lines[4], "repeat: none noted");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recap-")), "n.md");
  fs.writeFileSync(file, nb);
  const out = spawnSync(process.execPath, [TOOL, "--notebook", file, "--date", "2026-01-01"], { encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /no scorecard rows dated 2026-01-01/);
});

// Backlog 63: the low-health count comes from the addon through --low-start.
test("--low-start adds the count and one tip only when it is above 0", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recap-")), "n.md");
  fs.writeFileSync(file, book({ date: "2026-10-03", fight: "Hogger", deaths: 0, durationS: 60 }));
  const run = (...extra) => spawnSync(process.execPath, [TOOL, "--notebook", file, "--date", "2026-10-03", ...extra], { encoding: "utf8" });
  const none = run();
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim().split("\n").length, 5);
  assert.equal(run("--low-start", "0").stdout, none.stdout);
  const three = run("--low-start", "3");
  assert.equal(three.status, 0);
  assert.deepEqual(three.stdout.trim().split("\n").slice(5), [
    "fights started below 50% health: 3",
    "tip: before the next pull, rest, eat or drink until you are above half health.",
  ]);
  assert.equal(JSON.parse(run("--low-start", "3", "--json").stdout).lowStart, 3);
  assert.equal(run("--low-start", "-1").status, 2);
  assert.equal(run("--low-start", "two").status, 2);
});

test("the count is printed even on a day with no reviewed rows", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recap-")), "n.md");
  fs.writeFileSync(file, book());
  const out = spawnSync(process.execPath, [TOOL, "--notebook", file, "--date", "2026-10-03", "--low-start", "1"], { encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.equal(out.stdout.trim().split("\n")[1], "fights started below 50% health: 1");
});

test("the mentor's review rule quotes the same tip the recap prints", () => {
  const { LOW_HEALTH_TIP } = require("../../tools/session-recap");
  const agents = fs.readFileSync(path.resolve(__dirname, "../../mentor/AGENTS.md"), "utf8");
  assert.ok(agents.includes(`"${LOW_HEALTH_TIP}"`));
  assert.ok(agents.includes('"fights started below 50% health: N"'));
  assert.ok(agents.includes("--low-start N"));
});
