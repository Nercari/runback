'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runAgentOnce({ agentId, cwd, prompt, timeoutMs }, deps) {
  const { A, P, cfg, killTree, augment, onSpawn } = deps;
  agentId = A.normalizeAgent(agentId);
  if (!agentId) return Promise.resolve({ status: 'error', text: 'Unknown agent.' });
  const agent = A.AGENTS[agentId], acfg = A.agentConfig(cfg, agentId), cmd = A.resolveCommand(agentId, acfg);
  if (!cmd.found) return Promise.resolve({ status: 'error', text: `${agent.name} is not installed: ${cmd.note}` });
  const system = P.systemPrompt('', ''), input = agent.input({ prompt: String(prompt || ''), system, systemShort: system, resume: '', cfg: acfg });
  // Grok reads its prompt from a file.
  let promptFile = '';
  if (input.promptFile !== undefined) {
    promptFile = path.join(os.tmpdir(), `wowai-once-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(promptFile, input.promptFile);
  }
  let args = [...cmd.args, ...agent.args({
    cfg: acfg, resume: '', cwd, system, systemShort: system, promptFile,
    prompt: String(prompt || ''), timeoutMs,
  })];
  // The same Forever rewrites as a chat run (mentor guard: sandbox, no bypass flags).
  if (augment) { const info = { agentId, cwd, args }; augment({ cwd, agent: agentId }, info); args = info.args; }
  const env = agent.env({ ...process.env });
  return new Promise(resolve => {
    const child = spawn(cmd.file, args, { cwd, env, windowsHide: true, stdio: [input.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(child);
    const parser = agent.parser(); let buffer = '', stdoutText = '', stderr = '', result = null, ended = false;
    const done = (status, text) => {
      if (ended) return; ended = true; clearTimeout(timer);
      if (promptFile) fs.rm(promptFile, { force: true }, () => {});
      resolve({ status, text });
    };
    const line = src => {
      let ev;
      try { ev = JSON.parse(src); } catch { return; }
      try {
        const r = parser.feed(ev);
        if (r && r.done) result = r.done;
      } catch (e) { result = { text: e.message, error: true }; }
    };
    child.stdout.on('data', chunk => {
      if (agent.stream === 'text') { stdoutText += chunk.toString('utf8'); return; }
      buffer += chunk.toString('utf8');
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const row = buffer.slice(0, n).trim();
        buffer = buffer.slice(n + 1);
        if (row) line(row);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => killTree(child), timeoutMs || cfg.timeoutMs || 1800000);
    child.on('error', err => done('error', err.message));
    child.on('close', code => {
      if (agent.stream === 'text') {
        try {
          result = parser.finish({ stdout: stdoutText, stderr, code }).done;
          if (result && input.note) result.text += `\n\n${input.note}`;
        }
        catch (e) { result = { text: e.message, error: true }; }
      } else if (buffer.trim()) line(buffer.trim());
      const status = result && !result.error ? 'done' : 'error';
      const text = result ? String(result.text || '') :
        `${agent.name} exited with code ${code} and no result.\n${stderr.trim().slice(-1500)}`;
      done(status, text);
    });
    if (input.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input.stdin); }
  });
}
module.exports = { runAgentOnce };
