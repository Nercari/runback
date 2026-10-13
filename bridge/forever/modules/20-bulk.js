'use strict';
const fs = require('fs');
const path = require('path');
const lua = require('../lua-table');
module.exports = {
  init(ctx) { this.ctx = ctx; this.tries = 0; },
  onSavedVariables(src, ctx) {
    let root;
    try { root = lua.parseGlobal(src, 'Runback_Bulk'); this.tries = 0; }
    catch (err) {
      if (this.tries++ < 2) setTimeout(() => { try { this.onSavedVariables(fs.readFileSync(ctx.SAVED_VARS, 'utf8'), ctx); } catch {} }, 2000);
      return;
    }
    if (!root) return;
    const mentorDir = ctx.cfg.forever.mentorDir;
    for (const name of ['ah', 'quests', 'journal', 'gear']) {
      const table = root[name];
      if (!table || !Number.isFinite(Number(table.version)) || !Number.isFinite(Number(table.at))) continue;
      const prev = ctx.state.forever.bulk[name];
      if (prev && (Number(table.version) < prev.version || (Number(table.version) === prev.version && Number(table.at) <= prev.at))) continue;
      const dir = path.join(mentorDir, 'bulk');
      fs.mkdirSync(dir, { recursive: true });
      ctx.atomicWrite(path.join(dir, `${name}.json`), JSON.stringify(table, null, 2) + '\n');
      ctx.state.forever.bulk[name] = { version: Number(table.version), at: Number(table.at) };
      ctx.saveState();
      if (name === 'journal' && table.logout && ctx.cfg.forever.journal.enabled !== false) {
        const now = new Date();
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const outputFile = path.join(ctx.cfg.forever.journal.dir, `${day}.md`);
        const prompt = `[runback cmd=journal]\nWrite today's session story per AGENTS.md (Journal) ` +
          `from bulk/journal.json into ${outputFile}. Screenshots folder: ` +
          `${ctx.cfg.forever.clientDir}\\Screenshots.`;
        // One journal run at a time, however often the file changes.
        if (this.journalRun) continue;
        this.journalRun = Promise.resolve(ctx.runAgentOnce({ agentId: ctx.cfg.forever.journal.agent || ctx.cfg.agent, cwd: mentorDir, chat: 'journal', prompt }))
          .finally(() => { this.journalRun = null; });
      }
    }
  },
};
