'use strict';
const fs = require('fs');
const path = require('path');
module.exports = {
  init(ctx) {
    const file = path.join(ctx.HERE, 'KILLED');
    this.ctx = ctx;
    this.file = file;
    this.off = fs.existsSync(file);
    if (this.off) ctx.capture.stop();
  },
  intercept(job, ctx) {
    if (job.cmd === 'off') {
      fs.writeFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), by: job.chat || '' }));
      this.off = true;
      ctx.capture.stop();
      if (ctx.stopRunning) ctx.stopRunning();
      ctx.finish(job, 'done', 'AI is off. /runback on to resume.');
      return true;
    }
    if (job.cmd === 'on') {
      try { fs.unlinkSync(this.file); } catch {}
      this.off = false;
      ctx.capture.start();
      ctx.finish(job, 'done', 'AI is on.');
      return true;
    }
    if (this.off || fs.existsSync(this.file)) {
      this.off = true;
      ctx.finish(job, 'done', 'AI is off (/runback on).');
      return true;
    }
    return false;
  },
};
