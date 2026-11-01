'use strict';
const fs = require('fs');
const path = require('path');
function inside(cwd, root) {
  // Resolve junctions and symlinks (the agent runs in the real folder); Windows paths are case-insensitive.
  const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const norm = p => process.platform === 'win32' ? real(p).toLowerCase() : real(p);
  const rel = path.relative(norm(root), norm(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function setOption(args, names, values) {
  for (let i = args.length - 1; i >= 0; i--) {
    if (names.includes(args[i])) args.splice(i, 2);
  }
  args.push(...values);
}
// Flags that lift the sandbox or approvals; a mentor chat never keeps them.
const BYPASS = /^(--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--always-approve|--full-auto|-y|--yolo)(=.*)?$/;
function rewrite(agent, args, cwd, repo) {
  args = args.filter(arg => !BYPASS.test(String(arg)));
  if (agent === 'claude') {
    setOption(args, ['--permission-mode'], ['--permission-mode', 'acceptEdits']);
    for (let i = 0; i < args.length;) {
      if (args[i] === '--allowedTools') {
        args.splice(i, 1);
        while (i < args.length && !args[i].startsWith('-')) args.splice(i, 1);
      } else i++;
    }
    args.push('--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch', `Bash(node ${path.join(repo, 'tools', 'slice-fight.js')}:*)`,
      `Bash(node ${path.join(repo, 'tools', 'check-citations.js')}:*)`,
      `Bash(node ${path.join(repo, 'tools', 'theorycraft.js')}:*)`,
      `Bash(node ${path.join(repo, 'tools', 'practice-compare.js')}:*)`,
      `Bash(node ${path.join(repo, 'tools', 'session-recap.js')}:*)`);
  } else if (agent === 'codex') {
    // codex exec ends with its prompt positional `[resume <id>] -`; options go before it.
    const dash = args.lastIndexOf('-');
    const tail = dash < 0 ? [] : args.splice(args[dash - 2] === 'resume' ? dash - 2 : dash);
    setOption(args, ['-s', '--sandbox'], ['-s', 'workspace-write']);
    setOption(args, ['-C'], ['-C', cwd]);
    args.push(...tail);
  } else if (agent === 'agy') {
    setOption(args, ['--mode'], ['--mode', 'accept-edits']);
    setOption(args, ['--add-dir'], ['--add-dir', cwd]);
  } else if (agent === 'grok') {
    setOption(args, ['--permission-mode'], ['--permission-mode', 'dontAsk']);
    // ponytail: no Bash rule, so grok mentor chats can't run the slicer; add one if grok becomes a reviewer.
    for (let i = args.length - 2; i >= 0; i--) if (args[i] === '--allow') args.splice(i, 2);
    for (const rule of ['Read', 'Grep', 'Edit']) args.push('--allow', rule);
  } else if (agent === 'hermes') {
    setOption(args, ['--in'], ['--in', cwd]);
  }
  return args;
}
// The workspace is a one-time copy of mentor/, so a later fix to the coach's
// instructions would never reach it. Each bridge start brings AGENTS.md up to
// date; the player's own files (LOCAL.md, notebooks, reviews) are not touched,
// and the replaced copy is kept as AGENTS.md.bak.
function syncPrompt(templateDir, workspace) {
  const src = path.join(templateDir, 'AGENTS.md');
  const dst = path.join(workspace, 'AGENTS.md');
  try {
    const next = fs.readFileSync(src);
    if (!fs.existsSync(workspace)) return false;
    if (fs.existsSync(dst)) {
      if (fs.readFileSync(dst).equals(next)) return false;
      fs.copyFileSync(dst, dst + '.bak');
    }
    fs.writeFileSync(dst, next);
    return true;
  } catch { return false; }
}
// Hermes has no tool limit the bridge can set in the mentor folder, so a mentor
// job on it is refused until it has one: other players' chat and game text would
// reach its tools. Returns the line to show the player, or ''.
function refusal(agentId, cwd, mentorDir) {
  if (agentId !== 'hermes' || !mentorDir) return '';
  if (!inside(String(cwd || ''), mentorDir)) return '';
  return 'Hermes has no tool limit in the mentor folder, so Runback will not run a mentor job on it: other players\' chat and game text could reach its tools. Pick Claude, Codex, Grok or Antigravity with /runback agent, or move this chat to another folder.';
}
module.exports = {
  inside,
  rewrite,
  refusal,
  syncPrompt,
  augment(job, info, ctx) {
    const root = ctx.cfg.forever && ctx.cfg.forever.mentorDir || path.join(ctx.REPO, '..', 'wow-mentor');
    const cwd = job.cwd || '';
    if (!inside(cwd, root)) return;
    info.args = rewrite(info.agentId || job.agent, info.args || [], cwd, ctx.REPO);
  },
};
