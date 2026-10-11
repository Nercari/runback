#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const luaparse = require("luaparse");

const EXTENSIONS = new Set([".js", ".ps1", ".py", ".lua", ".toc", ".vbs", ".cmd"]);
const forbiddenParts = [
  ["Send", "Input"].join(""),
  ["keybd", "_event"].join(""),
  ["mouse", "_event"].join(""),
  ["Post", "Message"].join(""),
  ["Write", "Process", "Memory"].join(""),
  ["Read", "Process", "Memory"].join(""),
  ["Open", "Process"].join(""),
  ["Set", "Windows", "Hook", "Ex"].join(""),
  ["Virtual", "Alloc", "Ex"].join(""),
  ["Create", "Remote", "Thread"].join(""),
  ["Attach", "Thread", "Input"].join(""),
  ["Set", "Foreground", "Window"].join(""),
  ["Send", "Keys"].join(""),
  ["Auto", "It"].join(""),
  ["Send", "Message"].join(""),
  ["user32", "\\.dll.*(?:keybd|mouse|", "Send", "Input)"].join(""),
];
const FORBIDDEN = new RegExp(forbiddenParts.join("|"), "i");
const protectedNames = [
  "CastSpellByName",
  "CastSpellByID",
  "CastSpell",
  "SpellStopCasting",
  "UseAction",
  "TargetUnit",
  "AttackTarget",
  "MoveForwardStart",
  "MoveBackwardStart",
  "TurnLeftStart",
  "TurnRightStart",
  "StrafeLeftStart",
  "StrafeRightStart",
  "JumpOrAscendStart",
  "ToggleAutoRun",
  "InteractUnit",
  "SetBinding",
  "RunBinding",
  "SendChatMessage",
  "RunMacroText",
  "SecureCmdOptionParse",
  // Economy, trade and targeting actions: an addon never performs these for the player.
  "PlaceAuctionBid",
  "PostAuction",
  "StartAuction",
  "PostItem",
  "PostCommodity",
  "PlaceBid",
  "ConfirmCommoditiesPurchase",
  "BuyMerchantItem",
  "AcceptTrade",
  "AssistUnit",
  "FocusUnit",
  "ClearTarget",
  "TargetNearestEnemy",
  "TargetLastTarget",
  "PetAttack",
  "CastPetAction",
  "UseInventoryItem",
  "UseContainerItem",
  "UseItemByName",
  "SpellTargetUnit",
  "CameraOrSelectOrMoveStart",
  "AcceptBattlefieldPort",
  "JoinBattlefield",
  // Quest, gossip, trainer, taxi and talent actions (backlog 68): the player clicks these, an addon never does.
  // C_QuestLog.AbandonQuest and C_QuestLog.SetAbandonQuest are covered by the bare names.
  "AcceptQuest",
  "ConfirmAcceptQuest",
  "CompleteQuest",
  "GetQuestReward",
  "AcceptGossipQuest",
  "SelectGossipOption",
  "SelectGossipActiveQuest",
  "SelectGossipAvailableQuest",
  "SelectActiveQuest",
  "SelectAvailableQuest",
  "QuestFrameAcceptButton_OnClick",
  "QuestFrameCompleteButton_OnClick",
  "QuestFrameCompleteQuestButton_OnClick",
  "AbandonQuest",
  "SetAbandonQuest",
  "ConfirmBinder",
  "TakeTaxiNode",
  "BuyTrainerService",
  "LearnTalent",
  "PickupMerchantItem",
  "DeleteCursorItem",
];
// Namespaced actions whose bare member name is too generic to ban everywhere (SelectOption).
const protectedQualified = [
  "C_GossipInfo.SelectOption",
  "C_GossipInfo.SelectOptionByIndex",
  "C_GossipInfo.SelectAvailableQuest",
  "C_GossipInfo.SelectActiveQuest",
];
// UI Add-On Development Policy rules 4 and 5: no advertising, no donation requests.
const SOLICIT = /\b(?:donat(?:e|es|ion|ions)|patreon|paypal|ko-?fi|buymeacoffee|buy me a coffee|venmo|cash ?app|subscribestar)\b/i;
// Blizzard tables an addon may add its own entries to by convention.
const BLIZZARD_REGISTRIES = new Set(["SlashCmdList", "StaticPopupDialogs"]);
const PROTECTED_QUALIFIED = new RegExp(
  protectedQualified.map((full) => {
    const [ns, member] = full.split(".");
    return `\\b${ns}\\s*(?:\\.\\s*|\\[\\s*["'])${member}\\b`;
  }).join("|"),
);
const PROTECTED = new RegExp(`\\b(?:${protectedNames.join("|")})\\s*\\(`);
const RESTRICTED = new Set([
  "_G",
  "getfenv",
  "setfenv",
  "rawget",
  "rawset",
  "rawequal",
  "setmetatable",
  "getmetatable",
  "getglobal",
  "setglobal",
  "loadstring",
  "load",
  "dofile",
  "loadfile",
  "RunScript",
  "debug",
  "newproxy",
  "coroutine",
]);

function finding(file, line, rule, text, root) {
  return {
    file: path.relative(root, file).replace(/\\/g, "/"),
    line,
    rule,
    text: String(text).trim().slice(0, 240),
  };
}

function readAllowlist(root) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, "tools/safety-allow.json"), "utf8"),
    );
  } catch {
    return { network: [] };
  }
}

function walkRepo(input, findings, root) {
  let stats;
  try {
    stats = fs.lstatSync(input);
  } catch (error) {
    findings.push(finding(input, 1, "SCAN-ROOT", error.message, root));
    return [];
  }
  if (stats.isSymbolicLink()) return [];
  if (stats.isFile()) return [input];
  if (!stats.isDirectory()) return [];

  let entries;
  try {
    entries = fs.readdirSync(input, { withFileTypes: true });
  } catch (error) {
    findings.push(finding(input, 1, "SCAN-ROOT", error.message, root));
    return [];
  }
  return entries.flatMap((entry) =>
    walkRepo(path.join(input, entry.name), findings, root),
  );
}

function scanLines(file, source, mode, findings, root, allow) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const lines = source.split(/\r?\n/);

  if (ext === ".lua") {
    const addonName = mode === "untrusted" ? path.basename(path.dirname(file)) : "WoWAI";
    checkBlizzardOverrides(file, source, addonName, findings, root);
  }

  if (ext === ".lua") {
    try {
      luaparse.parse(source, {
        luaVersion: "5.1",
        scope: true,
        locations: true,
      });
    } catch (error) {
      findings.push(
        finding(file, error.line || 1, "LUA-SYNTAX", error.message, root),
      );
    }
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let candidate = line;
    if (ext === ".lua") {
      const token = ["Send", "Message"].join("");
      candidate = candidate.replace(new RegExp(`\\b${token}\\b`, "g"), "");
    }
    if (mode === "repo" && ext === ".lua" && rel === "addon/WoWAI/WoWAI.lua") {
      candidate = candidate.replace(/\bSetBinding\b/g, "");
    }
    if (FORBIDDEN.test(candidate)) {
      findings.push(finding(file, lineNumber, "FORBIDDEN-API", line, root));
    }
    if (
      ext === ".lua" &&
      /\b(?:loadstring|RunScript|setfenv)\b|\bload\s*\(/.test(line)
    ) {
      findings.push(finding(file, lineNumber, "LUA-DYNAMIC-CODE", line, root));
    }
    let protectedCandidate = line;
    if (mode === "repo" && rel === "addon/WoWAI/WoWAI.lua") {
      protectedCandidate = protectedCandidate.replace(/\bSetBinding\b/g, "");
    }
    if (ext === ".lua" && (PROTECTED.test(protectedCandidate) || PROTECTED_QUALIFIED.test(protectedCandidate))) {
      findings.push(
        finding(file, lineNumber, "LUA-PROTECTED-AUTOMATION", line, root),
      );
    }
    if ((ext === ".lua" || ext === ".js") && line.length > 2000) {
      findings.push(
        finding(
          file,
          lineNumber,
          "OBFUSCATION",
          "line exceeds 2000 characters",
          root,
        ),
      );
    }
    if (
      (ext === ".lua" || ext === ".js") &&
      /[A-Za-z0-9+/]{400,}={0,2}/.test(line)
    ) {
      findings.push(
        finding(
          file,
          lineNumber,
          "OBFUSCATION",
          "base64-looking blob longer than 400 characters",
          root,
        ),
      );
    }
    const escapes = line.match(/\\x[0-9a-f]{2}/gi) || [];
    if ((ext === ".lua" || ext === ".js") && escapes.length > 20) {
      findings.push(
        finding(
          file,
          lineNumber,
          "OBFUSCATION",
          "more than 20 hex escapes",
          root,
        ),
      );
    }
    const charCode =
      ext === ".js" && line.match(/\bString\.fromCharCode\s*\(([^)]*)\)/);
    if (charCode && charCode[1].split(",").length > 10) {
      findings.push(
        finding(
          file,
          lineNumber,
          "OBFUSCATION",
          "String.fromCharCode has more than 10 arguments",
          root,
        ),
      );
    }
    if (ext === ".js" && /\b(?:eval\s*\(|new\s+Function\s*\()/.test(line)) {
      findings.push(finding(file, lineNumber, "OBFUSCATION", line, root));
    }
    if ((ext === ".lua" || ext === ".toc") && SOLICIT.test(line)) {
      findings.push(finding(file, lineNumber, "POLICY-SOLICIT", line, root));
    }
    const networkExt = [".js", ".ps1", ".py", ".lua", ".vbs", ".cmd"].includes(
      ext,
    );
    if (
      networkExt &&
      /\brequire\s*\(\s*['"](?:http|https|net|dgram|tls)['"]\s*\)|\bfetch\s*\(/.test(
        line,
      ) &&
      /^(bridge|tools)\//.test(rel) &&
      !allow.network?.includes(rel)
    ) {
      findings.push(finding(file, lineNumber, "NETWORK", line, root));
    }
  });
}

// Replacing a Blizzard function or a method on a Blizzard frame taints every
// secure path that runs through it; the game then blocks protected actions
// (typed /cast, /run, settings) and blames this addon. Hooks
// (hooksecurefunc, HookScript) are the allowed way to react to Blizzard code.
function checkBlizzardOverrides(file, source, addonName, findings, root) {
  let ast;
  try {
    ast = luaparse.parse(source, { luaVersion: "5.1", scope: true, locations: true });
  } catch {
    return; // LUA-SYNTAX is already reported.
  }
  const owned = (name) => {
    const lower = name.toLowerCase();
    return lower.startsWith("wowai") || lower.startsWith(addonName.toLowerCase()) ||
      name.startsWith("SLASH_") || name.startsWith("BINDING_");
  };
  const fromGlobalLookup = new Set();
  const isGlobalLookup = (value) => value?.type === "IndexExpression" &&
    value.base.type === "Identifier" && value.base.name === "_G" && !value.base.isLocal;
  const rootOf = (target) => {
    let base = target;
    while (base.type === "MemberExpression" || base.type === "IndexExpression") base = base.base;
    return base;
  };
  const report = (node, text) =>
    findings.push(finding(file, node.loc?.start.line || 1, "LUA-TAINT", text, root));
  const checkTarget = (target) => {
    if (target.type === "Identifier") {
      if (!target.isLocal && !owned(target.name)) {
        report(target, `replaces the Blizzard function ${target.name}; use hooksecurefunc instead`);
      }
      return;
    }
    const base = rootOf(target);
    if (base.type !== "Identifier") return;
    if (fromGlobalLookup.has(base.name)) {
      report(target, `replaces a method on the Blizzard object ${base.name}; use hooksecurefunc instead`);
    } else if (!base.isLocal && !owned(base.name) && !BLIZZARD_REGISTRIES.has(base.name)) {
      report(target, `replaces a member of the Blizzard global ${base.name}; use hooksecurefunc instead`);
    }
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type === "LocalStatement") {
      node.variables.forEach((variable, index) => {
        if (isGlobalLookup(node.init[index])) fromGlobalLookup.add(variable.name);
      });
    }
    if (node.type === "AssignmentStatement") {
      node.variables.forEach((variable, index) => {
        if (node.init[index]?.type === "FunctionDeclaration") checkTarget(variable);
      });
    }
    if (node.type === "FunctionDeclaration" && node.identifier && !node.isLocal) {
      checkTarget(node.identifier);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc" && key !== "range") visit(value);
    }
  };
  visit(ast.body);
}

function loadLuaAllowlist(root) {
  const data = JSON.parse(
    fs.readFileSync(path.join(root, "tools/lua-allow.json"), "utf8"),
  );
  if (data.version !== 1 || !Array.isArray(data.globals) || !data.namespaces) {
    throw new Error("invalid tools/lua-allow.json format");
  }
  return data;
}

function reservedGlobal(name, allowlist) {
  return name.toLowerCase().startsWith("wowai") ||
    allowlist.globals.includes(name) || Object.hasOwn(allowlist.namespaces, name);
}

function checkLuaAst(file, source, parsed, allowlist, findings, root, metadata) {
  const report = (node, text) =>
    findings.push(
      finding(file, node.loc?.start.line || 1, "LUA-RESTRICTED", text, root),
    );
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (protectedNames.some((name) => line.includes(`.${name}`) || line.includes(`:${name}`))) {
      findings.push(finding(file, index + 1, "LUA-RESTRICTED", line, root));
    }
  }
  const allowedGlobals = new Set(allowlist.globals);
  const forbiddenMembers = new Set([
    "dump", "__index", "__newindex", "__metatable", ...protectedNames,
    ...RESTRICTED,
  ]);
  const stringLocals = new Set();
  for (const statement of parsed.body) {
    if (statement.type !== "LocalStatement") continue;
    statement.variables.forEach((variable, index) => {
      const value = statement.init[index];
      if (variable.type === "Identifier" && value?.type === "StringLiteral") {
        stringLocals.add(variable.name);
      }
      if (
        value?.type === "Identifier" &&
        protectedNames.includes(value.name) &&
        !value.isLocal
      ) report(value, `protected API ${value.name} is forbidden`);
    });
  }
  const isStringBase = (base) => base?.type === "StringLiteral" ||
    (base?.type === "Identifier" && stringLocals.has(base.name));
  const isGlobalBase = (base) => base?.type === "Identifier" && !base.isLocal;
  // ponytail: Unlisted Blizzard globals can collide with addon prefixes; use exact addon-table and SavedVariables names if needed.
  const permittedWrite = (name) => !reservedGlobal(name, allowlist) && (name.startsWith("SLASH_") ||
    metadata.savedVariables.has(name) || name.startsWith(metadata.addonName));
  const checkWrite = (target) => {
    if (target.type === "Identifier" && !target.isLocal) {
      if (!permittedWrite(target.name)) {
        report(target, `global write ${target.name} is not allowed`);
      }
    } else if (target.type === "MemberExpression") {
      let base = target;
      while (base.type === "MemberExpression") base = base.base;
      if (isGlobalBase(base) && allowlist.namespaces[base.name]) {
        report(target, `write to namespace ${base.name} is not allowed`);
      }
    }
  };
  // Globals this addon defines itself (permitted writes) may be read anywhere in it.
  const topAssigned = new Set();
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collect);
    const targets = node.type === "AssignmentStatement" ? node.variables
      : node.type === "FunctionDeclaration" && node.identifier ? [node.identifier] : [];
    for (const t of targets) {
      if (t.type === "Identifier" && !t.isLocal && permittedWrite(t.name)) topAssigned.add(t.name);
    }
    for (const [key, value] of Object.entries(node)) if (key !== "loc" && key !== "range") collect(value);
  };
  collect(parsed.body);
  const assignmentTargets = (node) => {
    if (node.type === "AssignmentStatement") node.variables.forEach(checkWrite);
    if (node.type === "FunctionDeclaration" && node.identifier) {
      checkWrite(node.identifier);
    }
  };
  const visit = (node, memberName = false) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child));
      return;
    }
    if (node.type === "MemberExpression" || node.type === "IndexExpression") {
      const computed = node.type === "IndexExpression" || node.indexer === "[";
      const member = node.identifier?.name || node.identifier?.value || node.index?.value;
      if (
        computed &&
        (isGlobalBase(node.base) ||
          (node.base.type === "Identifier" && allowlist.namespaces[node.base.name]))
      ) {
        report(
          node,
          `computed access on global ${node.base.name} is forbidden`,
        );
      }
      if (node.base.type === "Identifier" && !node.base.isLocal) {
        const ns = allowlist.namespaces[node.base.name];
        if (ns && member && !ns.includes(member)) {
          report(
            node,
            `global member ${node.base.name}.${member} is not allowed`,
          );
        }
      }
      if (member && forbiddenMembers.has(member)) report(node, `member ${member} is forbidden`);
      if (!computed && isStringBase(node.base)) {
        const stringMembers = new Set(allowlist.namespaces.string);
        if (!stringMembers.has(member)) report(node, `string member ${member} is not allowed`);
      }
      if (computed && isStringBase(node.base)) {
        report(node, "computed string access is forbidden");
      }
    } else if (node.type === "Identifier" && !node.isLocal && !memberName) {
      if (RESTRICTED.has(node.name))
        report(node, `restricted identifier ${node.name}`);
      else if (
        !allowedGlobals.has(node.name) &&
        !allowlist.namespaces[node.name] &&
        !topAssigned.has(node.name)
      ) {
        report(node, `global ${node.name} is not allowed`);
      }
    }
    assignmentTargets(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "identifier" && node.type === "MemberExpression")
        visit(value, true);
      else if (key !== "loc" && key !== "range") visit(value);
    }
  };
  visit(parsed.body);
}

function scanUntrusted(paths, root, allow, findings) {
  let luaAllow;
  try {
    luaAllow = loadLuaAllowlist(root);
  } catch (error) {
    findings.push(
      finding("tools/lua-allow.json", 1, "SCAN-ROOT", error.message, root),
    );
    return;
  }

  for (const input of paths) {
    let stats;
    try {
      stats = fs.lstatSync(input);
    } catch (error) {
      findings.push(finding(input, 1, "SCAN-ROOT", error.message, root));
      continue;
    }
    if (stats.isSymbolicLink()) {
      findings.push(
        finding(
          input,
          1,
          "LINK",
          "symlinks and junctions are not allowed",
          root,
        ),
      );
      continue;
    }
    if (!stats.isDirectory()) {
      findings.push(
        finding(
          input,
          1,
          "SCAN-ROOT",
          "untrusted scan root must be a directory",
          root,
        ),
      );
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(input, { withFileTypes: true });
    } catch (error) {
      findings.push(finding(input, 1, "SCAN-ROOT", error.message, root));
      continue;
    }
    if (!entries.length)
      findings.push(
        finding(input, 1, "SCAN-ROOT", "untrusted scan root is empty", root),
      );
    const metadata = {
      addonName: path.basename(input),
      savedVariables: new Set(),
    };
    const tocs = entries.filter((entry) => entry.name.toLowerCase().endsWith(".toc"));
    if (tocs.length > 1 || tocs.some(toc => {
      const base = toc.name.slice(0, -4);
      return !base || base !== path.basename(input);
    })) findings.push(finding(input, 1, "TOC-NAME", "expected exactly one .toc named after the addon folder", root));
    for (const toc of tocs) {
      metadata.addonName = path.basename(toc.name, path.extname(toc.name));
      try {
        const tocSource = fs.readFileSync(path.join(input, toc.name), "utf8");
        for (const [index, line] of tocSource.split(/\r?\n/).entries()) {
          const match = line.trim().match(/^##\s*SavedVariables(?:PerCharacter)?:\s*(.*)$/i);
          if (match) {
            match[1].split(",").forEach((name) => {
              const savedName = name.trim();
              if (reservedGlobal(savedName, luaAllow))
                findings.push(finding(path.join(input, toc.name), index + 1, "TOC-SV", `reserved SavedVariables name ${savedName}`, root));
              else if (savedName) metadata.savedVariables.add(savedName);
            });
          }
        }
      } catch { /* File read errors are reported in the normal scan pass. */ }
    }
    for (const entry of entries) {
      const file = path.join(input, entry.name);
      let childStats;
      try {
        childStats = fs.lstatSync(file);
      } catch (error) {
        findings.push(finding(file, 1, "SCAN-ROOT", error.message, root));
        continue;
      }
      if (childStats.isSymbolicLink()) {
        findings.push(
          finding(
            file,
            1,
            "LINK",
            "symlinks and junctions are not allowed",
            root,
          ),
        );
        continue;
      }
      if (!childStats.isFile()) {
        findings.push(
          finding(
            file,
            1,
            "FILE-TYPE",
            "subfolders and non-files are not allowed",
            root,
          ),
        );
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".lua" && ext !== ".toc") {
        findings.push(
          finding(
            file,
            1,
            "FILE-TYPE",
            "only .lua and .toc files are allowed",
            root,
          ),
        );
        continue;
      }
      let source;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch (error) {
        findings.push(finding(file, 1, "SCAN-ROOT", error.message, root));
        continue;
      }
      scanLines(file, source, "untrusted", findings, root, allow);
      if (ext === ".toc") {
        for (const [index, line] of source.split(/\r?\n/).entries()) {
          const name = line.trim();
          if (!name || name.startsWith("##") || name.startsWith("#")) continue;
          if (
            path.basename(name) !== name ||
            path.extname(name).toLowerCase() !== ".lua" ||
            !entries.some(
              (candidate) => candidate.name === name && candidate.isFile(),
            )
          ) {
            findings.push(
              finding(
                file,
                index + 1,
                "TOC-REF",
                `missing or invalid Lua file: ${name}`,
                root,
              ),
            );
          }
        }
      } else {
        let ast = null;
        try {
          ast = luaparse.parse(source, {
            luaVersion: "5.1",
            scope: true,
            locations: true,
          });
        } catch {
          // LUA-SYNTAX is already reported by scanLines.
        }
        if (ast) {
          // A checker bug must fail closed, never pass the file unchecked.
          try {
            checkLuaAst(file, source, ast, luaAllow, findings, root, metadata);
          } catch (err) {
            findings.push(finding(file, 1, "LUA-CHECK-ERROR", String(err && err.message), root));
          }
        }
      }
    }
  }
}

function scan(
  paths = ["addon", "bridge", "tools", "setup.js"],
  { mode = "repo" } = {},
) {
  const root = path.resolve(__dirname, '..');
  const allow = readAllowlist(root);
  const findings = [];
  const requested = Array.isArray(paths) ? paths : [paths];

  if (mode === "untrusted") {
    scanUntrusted(requested, root, allow, findings);
  } else if (mode === "repo") {
    for (const input of requested) {
      const absolute = path.resolve(root, input);
      const before = findings.length;
      const files = walkRepo(absolute, findings, root);
      if (files.length === 0 && findings.length === before) {
        findings.push(
          finding(
            absolute,
            1,
            "SCAN-ROOT",
            "scan root is empty or not a file/directory",
            root,
          ),
        );
      }
      for (const file of files) {
        if (!EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
        try {
          scanLines(
            file,
            fs.readFileSync(file, "utf8"),
            mode,
            findings,
            root,
            allow,
          );
        } catch (error) {
          findings.push(finding(file, 1, "SCAN-ROOT", error.message, root));
        }
      }
    }
  } else {
    throw new Error(`unknown scan mode: ${mode}`);
  }

  const failures = findings.filter((item) => item.rule !== "NETWORK");
  return { ok: failures.length === 0, findings };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const untrusted = args.includes("--untrusted");
  const paths = args.filter((arg) => arg !== "--untrusted");
  const roots = paths.length ? paths : ["addon", "bridge", "tools", "setup.js"];
  const result = scan(roots, { mode: untrusted ? "untrusted" : "repo" });
  for (const item of result.findings) {
    console.log(`${item.file}:${item.line} [${item.rule}] ${item.text}`);
  }
  if (!result.ok) process.exitCode = 1;
}

module.exports = { scan };
