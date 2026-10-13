'use strict';
module.exports = {
  intercept(job) {
    if (job.cmd) job.text = `[runback cmd=${job.cmd}]\n${job.text || ''}`;
    return false;
  },
};
