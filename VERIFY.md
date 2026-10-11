# VERIFY

Merge evidence for wow-ai. Run these from the repo root and paste their real output in the PR body. CI runs the same two commands on Windows and Linux. When behavior changes, update this file in the same PR. A fuller project skill can be generated with `create-verification-skill` and kept current with `maintain-verification-skill`.

## Commands

- `npm ci`
- `node tools/safety-ci.js` (Blizzard-policy and safety checks; must exit 0)
- `npm test` (must end with `# fail 0` and `CODEC ROUND-TRIP PASS`)

In-game behavior cannot be verified by an agent. Only Pedro can run the game; a PR that changes the addon gives him a short checklist and says the in-game part is unverified.

## Output (2026-10-11, `forever` 2a98f82 plus branch `claude/project-thread-6o8g59`, backlog 52 stalled runs, Linux)

```
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 317
# pass 314
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```

## Output (2026-10-11, `forever` 9ff11ba plus branch `claude/project-thread-8c7qp8`, backlog 43 effort on the command line, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 292
# pass 289
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```

## Output (2026-10-10, `forever` f9e5b1e plus branch `claude/project-thread-0krksp`, backlog 42 model catalog, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 286
# pass 283
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```

## Output (2026-10-10, `forever` f9e5b1e plus branch `claude/project-thread-a7dggu`, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 285
# pass 282
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```

## Output (2026-10-10, `forever` f9e5b1e plus branch `claude/project-thread-fie9ei`, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 286
# pass 283
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```

## Output (2026-10-10, `forever` d9348cf plus branch `claude/project-thread-0krksp`, backlog 42 model catalog, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 288
# pass 285
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```

## Output (2026-10-10, `forever` d9348cf plus branch `claude/project-thread-a7dggu`, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 287
# pass 284
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```


## Output (2026-10-09, ticket 41, Pedro's PC, Windows)

Docs only. CLI probes (read-only):

```
claude --version          -> 2.1.295 (Claude Code); --effort (low, medium, high, xhigh, max)
codex --version           -> codex-cli 0.159.0; exec has -m and -c key=value
codex exec --json -m gpt-6-sol -c model_reasoning_effort=high -
                          -> flags accepted, 401 token_expired (ChatGPT sign-in), no reply
~/.codex/models_cache.json-> fetched_at 2026-10-02; 11 models, 9 visibility=list
grok                      -> not installed
agy --version             -> 1.3.2; agy models -> 18 "id<TAB>label" lines; --output-format rejected
hermes chat --help        -> --reasoning LEVEL: none, minimal, low, medium, high, xhigh, max, ultra
```

Repo checks:

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 267
# pass 267
# fail 0
# skipped 0
>>> CODEC ROUND-TRIP PASS
```

### Trimmed CLI output behind each row (ticket 41, 2026-10-09)

```
$ claude --help (trimmed)
  --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
  --model <model>    Model for the current session. Provide an alias for the latest model
                     (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.

$ python: ~/.codex/models_cache.json (fetched_at 2026-10-02T10:27:47Z, client_version 0.159.2)
top keys ['fetched_at', 'etag', 'client_version', 'identity', 'models']
slug                         visibility  default_reasoning_level  supported_reasoning_levels[].effort
gpt-6.1-sol                  list  low     low medium high xhigh max ultra
gpt-6-astra                  list  medium  low medium high xhigh max ultra
gpt-6-sol                    list  medium  low medium high xhigh max ultra
gpt-6-luna                   list  medium  low medium high xhigh max
gpt-reserve                  hide  medium  low medium high xhigh max
gpt-5.6-sol                  list  low     low medium high xhigh max ultra
gpt-5.6-terra                list  medium  low medium high xhigh max ultra
gpt-5.6-luna                 list  medium  low medium high xhigh max
gpt-daybreak-blue-latest     list  low     low medium high xhigh max ultra
gpt-5.5                      list  medium  low medium high xhigh
codex-auto-review            hide  medium  low medium high xhigh max

$ agy --help (trimmed)
  --effort   Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --model    Model for the current CLI session
$ agy models --output-format json
Error: flags provided but not defined: -output-format
$ agy models
gemini-3.8-flash-high / -medium / -low    Gemini 3.8 Flash (High|Medium|Low)
gemini-3.7-flash-high / -medium / -low    Gemini 3.7 Flash (High|Medium|Low)
gemini-3.6-flash-high / -medium / -low    Gemini 3.6 Flash (High|Medium|Low)
gemini-3.1-pro-high / -low                Gemini 3.1 Pro (High|Low)
claude-opus-5-5-low / -medium / -high     Claude Opus 5.5 (Low|Medium|High)
claude-sonnet-5-5-low / -medium / -high   Claude Sonnet 5.5 (Low|Medium|High)
gpt-oss-120b-medium                       GPT-OSS 120B (Medium)

$ hermes --version
Hermes Agent v0.21.5+9123.g49eb4f4 (2026.9.24)
$ hermes chat --help (trimmed)
  -m, --model MODEL    Model to use (e.g., anthropic/claude-sonnet-4)
  --reasoning LEVEL    Reasoning effort for this session: none, minimal, low, medium, high,
                       xhigh, max, or ultra. Overrides agent.reasoning_effort for this run only
  --provider PROVIDER  Inference provider (default: auto).

$ grok: not on PATH; ls ~/.grok -> No such file or directory
```

## Output (2026-10-10, `forever` d1cd38f plus branch `claude/project-thread-0krksp`, backlog 42 model catalog, Linux)

```
npm ci                    -> exit 0
node tools/safety-ci.js   -> exit 0
npm test                  -> exit 0
# tests 290
# pass 287
# fail 0
# skipped 3
>>> CODEC ROUND-TRIP PASS
```
