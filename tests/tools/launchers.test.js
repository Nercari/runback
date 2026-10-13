"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
test("hidden VBScript launchers use hidden window style and no cmd /k", () => {
  for (const f of [
    "../../bridge/start-hidden.vbs",
    "../../bridge/runback-kill.vbs",
    "../../tools/policy-watch.vbs",
  ]) {
    const s = fs.readFileSync(path.resolve(__dirname, f), "utf8");
    assert.match(s, /,\s*0\s*,/i, f);
    assert.doesNotMatch(s, /cmd\s+\/k/i, f);
  }
});
