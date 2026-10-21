// Cursor port of claude/mods/merge-gate (Pedro, 2026-10-16): Cursor and the Grok bots may not merge around the check.
// beforeShellExecution: denies `gh pr merge`, `gh api …/pulls/N/merge` and a git push to main/master.
// beforeMCPExecution: denies a GitHub MCP merge unless the merge command stamped that exact head in the last 30 min.
// The only merge command is `python3 scripts/hq_onboard_repo.py merge N` in nercari-control (`--repo Nercari/<name>` for another repo); it calls gh from Python, so no hook sees it.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TRUNK = ['main', 'master']
const SEPARATORS = /&&|\|\||;|\||\n/
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const PUSH_VALUED = new Set(['--repo', '--push-option', '--receive-pack', '--exec', '-o'])
const STAMP_TTL_MS = 30 * 60 * 1000
const MERGE_COMMAND = 'python3 scripts/hq_onboard_repo.py merge N in nercari-control (add --repo Nercari/<name> for another repo)'

const tokens = segment => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => t.replace(/^["']|["']$/g, ''))

/** Merge or push-to-trunk actions in a shell command; `branch` is the current branch, for a bare `git push`. */
export const actionsIn = (command, branch) => {
  const found = []
  for (const segment of command.split(SEPARATORS)) {
    const t = tokens(segment)
    while (t.length > 0 && /^\w+=/.test(t[0])) t.shift()
    const head = (t[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
    if (head === 'gh' && t[1] === 'pr' && t[2] === 'merge') { found.push('gh pr merge'); continue }
    if (head === 'gh' && t[1] === 'api' && t.some(x => /(^|\/)pulls\/\d+\/merge$/.test(x))) {
      found.push('gh api …/pulls/N/merge'); continue
    }
    if (head !== 'git') continue
    let i = 1
    while (i < t.length && t[i].startsWith('-')) i += GIT_VALUED.has(t[i]) ? 2 : 1
    if (t[i] !== 'push') continue
    const operands = []
    for (i++; i < t.length; i++) {
      if (PUSH_VALUED.has(t[i])) i++
      else if (!t[i].startsWith('-')) operands.push(t[i])
    }
    const refspecs = operands.slice(1)
    const targets = refspecs.length === 0 ? (branch ? [branch] : []) : refspecs.map(r => {
      const dest = r.replace(/^\+/, '').split(':').pop() ?? ''
      return dest === 'HEAD' ? (branch ?? '') : dest.replace(/^refs\/heads\//, '')
    })
    const hit = targets.find(b => TRUNK.includes(b))
    if (hit) found.push(`git push to ${hit}`)
  }
  return found
}

/** Why an MCP merge is refused, or undefined when the merge command passed for this head recently. */
export const mergeProblem = (input, readStamp, nowMs) => {
  const sha = input.expectedHeadSha ?? input.sha
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    return 'set expectedHeadSha to the full head sha, so a later push cannot merge unchecked'
  }
  const name = `${String(input.owner ?? '').toLowerCase()}__${String(input.repo ?? '').toLowerCase()}__${Number(input.pullNumber ?? input.pull_number)}__${sha.toLowerCase()}`
  const stamp = readStamp(name)
  if (stamp === undefined) return `the merge command has not passed for head ${sha.slice(0, 7)}. Run ${MERGE_COMMAND}`
  const at = Number(stamp.trim()) * 1000
  if (!Number.isFinite(at) || nowMs - at > STAMP_TTL_MS) {
    return `the merge command passed for head ${sha.slice(0, 7)} more than 30 minutes ago; run it again`
  }
  return undefined
}

const deny = why => ({ permission: 'deny', user_message: `merge-gate: ${why}`, agent_message: `merge-gate: ${why}` })

export const decide = (event, { branch, readStamp, nowMs }) => {
  if (event.hook_event_name === 'beforeMCPExecution' || event.tool_name !== undefined) {
    if (!/merge_pull_request|merge_pr\b|pull_request_merge/i.test(String(event.tool_name ?? ''))) return { permission: 'allow' }
    let input = event.tool_input ?? {}
    if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = {} } }
    const problem = mergeProblem(input, readStamp, nowMs)
    return problem ? deny(`not merged, because ${problem}.`) : { permission: 'allow' }
  }
  const command = String(event.command ?? '')
  if (!/\b(push|merge)\b/.test(command)) return { permission: 'allow' }
  const action = actionsIn(command, branch())[0]
  if (!action) return { permission: 'allow' }
  if (action.startsWith('git push')) return deny(`${action} was not run. Never push to main; push your own branch and open a PR.`)
  return deny(`${action} was not run. The only merge command is ${MERGE_COMMAND}.`)
}

if (process.argv[1]?.endsWith('merge-gate.mjs')) {
  const event = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const dir = process.env.NERCARI_MERGE_STAMPS || join(homedir(), '.cache', 'nercari', 'merge-gate')
  const out = decide(event, {
    branch: () => {
      try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: event.cwd || undefined, encoding: 'utf8', timeout: 5000 }).trim()
      } catch { return undefined }
    },
    readStamp: name => { try { return readFileSync(join(dir, name), 'utf8') } catch { return undefined } },
    nowMs: Date.now(),
  })
  process.stdout.write(JSON.stringify(out))
}
