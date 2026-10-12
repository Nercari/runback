'use strict';
const fs = require('fs');
const path = require('path');
const A = require('../../agents');
function latest(dir) {
  try { return fs.readdirSync(dir).filter(f => /\.(png|jpg|tga)$/i.test(f)).map(f => path.join(dir, f))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]?.file || ''; } catch { return ''; }
}
module.exports = {
  init(ctx) {
    const dir = ctx.cfg.forever.screenshotsDir || path.join(ctx.cfg.forever.clientDir, 'Screenshots');
    this.dir = dir; this.newest = latest(dir); this.watch(ctx);
  },
  watch(ctx) {
    try {
      this.watcher = fs.watch(this.dir, () => { this.newest = latest(this.dir); });
      this.watcher.on('error', err => {
        ctx.log('screenshot watch:', err.message);
        this.watcher.close();
        this.watcher = null;
        this.retry = setTimeout(() => this.watch(ctx), 30000);
      });
    }
    catch (err) { ctx.log('screenshot watch:', err.message); this.retry = setTimeout(() => this.watch(ctx), 30000); }
  },
  intercept(job, ctx) {
    if (job.cmd !== 'look') return false;
    const agent = job.agent || (ctx.state.chatAgents && ctx.state.chatAgents[job.chat]) || ctx.cfg.agent;
    const known = A.AGENTS[A.normalizeAgent(agent)];
    if (known && !known.takesImages) {
      ctx.finish(job, 'error', `${known.name} can't see screenshots. To ask about your screen, pick ${A.imageAgentNames()} with the AI button, then press Print Screen and type look.`);
      return true;
    }
    this.newest = latest(this.dir);
    // Only a screenshot taken for this question; an old one may show something unrelated.
    let fresh = false;
    try { fresh = !!this.newest && Date.now() - fs.statSync(this.newest).mtimeMs < 10 * 60000; } catch {}
    if (!fresh) { ctx.finish(job, 'error', 'No screenshot in the last 10 minutes: press Print Screen first.'); return true; }
    job.images = [this.newest]; return false;
  },
  stop() { if (this.watcher) this.watcher.close(); if (this.retry) clearTimeout(this.retry); },
};
