# Shared context — read this first

Distilled from `yavin-iv-context.md` and `implementation-plan.md`. Open those files for anything not covered here.

## Mental model

- **yavin-iv** = Next.js + Postgres + REST + WebSocket. Owns state. Does not run agents.
- **rogue-one** = headless worker. Drives the 6-stage pipeline. Streams to yavin-iv. No persistent storage.
- Communication: REST + WebSocket against yavin-iv only. **No direct Postgres access.**

## Pipeline

```
research → plan → plan_review → code → code_review → pr
```

Gates (human approval) live between:
- `research` → `plan` (`post_research`)
- `plan_review` → `code` (`post_plan`)
- `code_review` → `pr` (`pre_pr`)

Run status flow (happy path):
```
pending → researching → awaiting_research_approval → planning → reviewing_plan
   → awaiting_plan_approval → coding → reviewing_code → awaiting_pr_approval
   → opening_pr → completed
```

## Protocol package

`@cmhrabi/yavin-protocol` (GitHub Packages). Exports types, status arrays, `canTransition`, and zod schemas for stage outputs. Always validate stage outputs with the matching zod schema before sending.

Install requires a `GITHUB_TOKEN` PAT with `read:packages` and an `.npmrc`:
```
@cmhrabi:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Auth

API key format: `yvn_<8-hex>_<32-base64url>`. Shown once at creation.
- REST: `Authorization: Bearer yvn_…`
- WS: `?token=<urlencoded-key>` on the upgrade

## Wire essentials

### WS URL
```
ws://<host>/ws?role=worker&token=<urlencoded-key>
```

### Heartbeat
Server pings on connect and every 30s. Reply `{ "kind": "pong" }` within 60s or get terminated.

### Inbound (`ServerToWorker`)
- `run.start` — yavin handing you a run. Already in `researching`. No `run.claim` needed.
- `gate.decided` — human resolved a gate. `decision` is `approved | rejected | regenerate`.
- `run.cancel` — abort.
- `ping`.

### Outbound (`WorkerToServer`)
- `run.claim` — only when reconciling after a crash.
- `stage.started` — server upserts by `(runId, kind)`; `stage.id` is ignored on this message.
- `stage.completed` — include validated `output`.
- `stage.failed` — requires real stage UUID (fetch via `GET /api/runs/{id}`). Transitions run to `failed`.
- `event.append` — log/tool_call/tool_result/message. Server assigns `seq`.
- `agent.message` — record one Claude API turn with tokens + cost. Requires real stage UUID.
- `gate.await` — pass stage output as `payload`. Wait for `gate.decided`.
- `pong`.

## Stage output schemas (validate before sending)

| stage | shape |
|---|---|
| `research` | `{ brief, citations: [{url,title?}], notes? }` |
| `plan` | `{ summary, steps: [{title,description,files,notes?}] }` |
| `plan_review` | `{ critique, revisedPlan?, decision: accept\|revise }` |
| `code` | `{ files: [{path,status,oldPath?,diff}], summary? }` |
| `code_review` | `{ comments: [{path,line,severity,message}], summary, decision }` |
| `pr` | `{ title, body, url?, number? }` |

## Reconnection recipe

1. Reconnect to `/ws?role=worker&token=…`.
2. For each owned run: `GET /api/runs/{id}` to refetch run, stages (with UUIDs), and event log.
3. Resume based on `run.status` / `run.currentStage`. If `awaiting_*_approval`, just wait.
4. Re-sending `stage.started`/`stage.completed` is safe (server upserts).

## Env vars

```
YAVIN_URL=http://localhost:3000          # or YAVIN_BASE_URL in the contract
YAVIN_API_KEY=yvn_…
ANTHROPIC_API_KEY=…                       # for Claude Agent SDK
GITHUB_TOKEN=…                            # for @cmhrabi/yavin-protocol install + PR creation
ROGUE_ONE_WORKER_LABEL=laptop
ROGUE_ONE_STUCK_TIMEOUT_MS=300000
REVIEWER=claude-adversarial
```

## Two execution modes

- `rogue-one worker` — long-lived process. Connects, claims, executes.
- `rogue-one start <instructions> <ticket-url>` — short-lived. POSTs `/api/runs` and exits.

The slash command invokes `rogue-one start`. The worker process must already be running for actual execution.

## Hard constraints

- Never connect to Postgres directly.
- Never store authoritative state locally (small resilience cache OK).
- Never authenticate humans, render UI, or hold ticket-provider creds.
- Validate every stage `output` with the matching zod schema before sending.
- Always use `canTransition(from, to)` if you ever send `run.status` explicitly.

## Reference pointers in yavin-iv

| File | What's in it |
|---|---|
| `packages/protocol/src/messages.ts` | Domain + wire types |
| `packages/protocol/src/runStatus.ts` | Status arrays + transitions |
| `packages/protocol/src/schemas.ts` | Stage output zod schemas |
| `src/server/ws.ts` | WS handlers, heartbeat |
| `src/server/runs.ts` | State machine |
| `scripts/stub-worker.ts` | Working research-stage example |
