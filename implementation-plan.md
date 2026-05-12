# rogue-one — Implementation Plan

## 1. What rogue-one is

The headless workflow engine that actually executes SDLC tasks. Invoked from Claude Code via a slash command, runs as a long-lived Node process per developer machine, spawns Claude Code subagents through the SDK, manages git worktrees, opens PRs, and streams everything back to yavin-iv.

rogue-one's responsibilities:
- Provide a `/rogue-one <instructions> <ticket-url>` slash command
- Connect to yavin-iv as a WebSocket worker
- Claim runs and execute the six-stage pipeline (research → plan → plan_review → code → code_review → pr)
- Spawn Claude Code subagents via `@anthropic-ai/claude-agent-sdk`
- Manage git worktrees on the host
- Push branches and open PRs via the GitHub API
- Emit a steady stream of events to yavin-iv

What it does **not** do: hold authoritative state, render UI, store data persistently across runs (it has a small local cache for resilience, but yavin-iv is truth).

## 2. Relationship to yavin-iv

rogue-one is a **client of yavin-iv**. It connects to yavin-iv's WebSocket as a `worker`, authenticates with an API key, and follows yavin-iv's instructions. yavin-iv decides when to start a run (concurrency), when a stage is approved (gate decisions), and when to cancel.

Integration contract:
- Both repos depend on the published `@yavin/protocol` package for shared types and the run state machine
- All communication is REST + WebSocket against yavin-iv — rogue-one **does not connect to Postgres directly**
- Auth: API key in env var (`YAVIN_API_KEY`)
- Configuration: yavin-iv URL via env var (`YAVIN_URL`)

If yavin-iv is down, rogue-one cannot start new runs and stops streaming events on in-flight runs (queueing locally). When yavin-iv comes back, rogue-one reconnects and replays buffered events using the per-run monotonic `seq`.

## 3. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 20+ | Required by Claude Agent SDK |
| Language | TypeScript | Type sharing via `@yavin/protocol` |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` | Official Claude Code SDK, the path your stack is committed to |
| WebSocket client | `ws` | Same library as yavin-iv server, well-understood |
| Git | `simple-git` for porcelain operations + raw `git` shell-out for worktree ops | `simple-git` is comfortable; worktrees are cleaner via shell |
| GitHub API | `@octokit/rest` + `@octokit/graphql` | PR creation, related-PR research |
| CLI framework | `commander` | Slash command argument parsing |
| Validation | `zod` | Validate stage outputs against `@yavin/protocol` schemas before sending |
| Process supervision | `pm2` (optional, for dev) | Auto-restart the worker process |
| Logging | `pino` | Structured logs with run_id correlation |

## 4. Repository layout

```
rogue-one/
├── src/
│   ├── cli/
│   │   ├── index.ts                # /rogue-one entrypoint
│   │   └── claudeCommand.ts        # registers slash command for Claude Code
│   ├── worker/
│   │   ├── index.ts                # long-running worker process entry
│   │   ├── connection.ts           # WS client with reconnect + replay
│   │   ├── runLoop.ts              # claims runs, dispatches to pipeline
│   │   └── eventEmitter.ts         # buffered event sender to yavin-iv
│   ├── pipeline/
│   │   ├── orchestrator.ts         # state machine driver
│   │   ├── stages/
│   │   │   ├── research.ts
│   │   │   ├── plan.ts
│   │   │   ├── planReview.ts
│   │   │   ├── code.ts
│   │   │   ├── codeReview.ts
│   │   │   └── pr.ts
│   │   └── gates.ts                # await-gate logic (WS-driven)
│   ├── agents/
│   │   ├── session.ts              # Claude Agent SDK wrapper
│   │   ├── prompts/
│   │   │   ├── researcher.md
│   │   │   ├── planner.md
│   │   │   ├── critic.md
│   │   │   ├── coder.md
│   │   │   └── codeReviewer.md
│   │   ├── reviewer.ts             // Reviewer interface + ClaudeAdversarialCritic
│   │   └── tools/                  // custom tools exposed to subagents (if any)
│   ├── env/
│   │   ├── environment.ts          // Environment interface
│   │   └── worktreeEnvironment.ts  // git worktree implementation
│   ├── git/
│   │   ├── worktree.ts             // create/remove/lookup worktrees
│   │   └── branch.ts               // branch naming, push
│   ├── github/
│   │   └── pr.ts                   // open PR with templated body
│   ├── yavin/
│   │   ├── client.ts               // REST client for yavin-iv
│   │   └── ticket.ts               // wrapper around /api/tickets/lookup
│   └── util/
│       ├── retry.ts
│       ├── stuckDetector.ts        // timeout-based stuck detection
│       └── log.ts
├── bin/
│   └── rogue-one                   // entrypoint script (worker mode)
├── package.json
└── tsconfig.json
```

## 5. The two execution modes

rogue-one ships as a single npm package with two modes:

**Worker mode** — `rogue-one worker` — a long-lived process that connects to yavin-iv, claims runs, and executes them. Started once per developer machine (e.g., on login, or via `pm2`). Holds the Claude Agent SDK sessions and the git worktrees.

**CLI mode** — `rogue-one start <instructions> <ticket-url>` — a short-lived command that hits yavin-iv's REST API to create a new run, then exits. The actual work happens in the worker process. This is what the Claude Code slash command invokes.

Why split them: the slash command needs to return quickly so Claude Code stays responsive, but agent execution can take 30+ minutes. Decoupling lets the worker run independently of any individual Claude Code session.

## 6. The slash command

Registered with Claude Code via its custom-command mechanism (project-level `.claude/commands/rogue-one.md` or user-level config). The command shells out to `rogue-one start` with the rest of the line as arguments.

```bash
# .claude/commands/rogue-one.md (or equivalent)
# Usage: /rogue-one <instructions> <ticket-url>
rogue-one start "$@"
```

`rogue-one start` parses the args, infers the repo from `cwd` (matched against yavin-iv's `repo_configs`), and POSTs to `/api/runs`. yavin-iv responds with the run ID and current status. The CLI prints a link to the dashboard and exits.

If no worker process is running on the machine, the CLI detects this (yavin-iv returns `awaiting_worker` status) and prints a helpful message to start one.

## 7. The worker connection

```ts
// src/worker/connection.ts (sketch)

class YavinConnection {
  private ws: WebSocket;
  private outbox: WorkerToServer[] = [];        // buffered for offline
  private lastSeqByRun = new Map<string, number>();

  async connect() {
    this.ws = new WebSocket(`${YAVIN_URL}/ws?role=worker&token=${API_KEY}`);
    this.ws.on('open', () => this.flushOutbox());
    this.ws.on('message', (raw) => this.handleMessage(JSON.parse(raw.toString())));
    this.ws.on('close', () => setTimeout(() => this.connect(), backoff()));
  }

  send(msg: WorkerToServer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.outbox.push(msg);
  }

  // ...
}
```

Reconnect with exponential backoff capped at 30s. On reconnect, re-claim any in-flight runs (yavin-iv tracks worker → run ownership) and resume event streaming with the next seq number. The outbox is bounded — if it fills, the worker logs a critical error and pauses the affected run rather than dropping events.

## 8. The pipeline orchestrator

The orchestrator is a small state machine driver:

```ts
// src/pipeline/orchestrator.ts (sketch)

async function runPipeline(run: Run, ctx: RunContext) {
  await researchStage(run, ctx);
  await awaitGate(run, 'post_research', ctx);

  await planStage(run, ctx);
  await planReviewStage(run, ctx);
  await awaitGate(run, 'post_plan', ctx);

  await codeStage(run, ctx);
  await codeReviewStage(run, ctx);
  await awaitGate(run, 'pre_pr', ctx);

  await prStage(run, ctx);
}
```

Each stage:
1. Tells yavin-iv `stage.started`
2. Spawns a Claude Agent SDK session with the right prompt and tools
3. Streams every tool call, tool result, and assistant message as `event.append` and `agent.message`
4. Validates the structured output with zod against `@yavin/protocol` schemas
5. Tells yavin-iv `stage.completed` with the structured output
6. On failure: catches, sends `stage.failed`, the orchestrator's retry wrapper attempts once more with the failure context appended to the prompt; if that also fails, transitions the run to `awaiting_human_intervention` and exits the pipeline

`awaitGate(run, kind)` returns a promise resolved when yavin-iv sends `gate.decided`. If the decision is `regenerate`, the orchestrator re-runs the stage that produced the artifact under review, with the human's feedback prepended to the prompt. If `rejected`, the run terminates. If `approved`, the pipeline continues.

## 9. The Claude Agent SDK integration

A thin wrapper in `src/agents/session.ts`:

```ts
// (sketch, actual SDK API may differ slightly)
import { query } from '@anthropic-ai/claude-agent-sdk';

interface SessionConfig {
  systemPrompt: string;
  cwd: string;                // worktree path for code stages, repo root for research
  allowedTools: string[];     // ['Read','Grep','WebSearch'] for research; full set for code
  maxTurns?: number;
  onEvent: (e: AgentEvent) => void;
}

async function runSession(cfg: SessionConfig, userMessage: string): Promise<SessionResult> {
  for await (const message of query({
    prompt: userMessage,
    options: {
      cwd: cfg.cwd,
      systemPrompt: cfg.systemPrompt,
      allowedTools: cfg.allowedTools,
      maxTurns: cfg.maxTurns ?? 50,
    },
  })) {
    cfg.onEvent(message);     // forwarded to yavin-iv as event.append + agent.message
  }
  // assemble final structured output from the last assistant message
}
```

Per stage, `allowedTools` is restricted to the minimum needed:
- **Research**: Read, Grep, Glob, WebSearch, WebFetch (no Edit, no Bash)
- **Plan**: same as research (planner reads, doesn't write)
- **Plan review**: Read, Grep, Glob (just enough to verify claims)
- **Code**: full toolset including Edit, Write, Bash
- **Code review**: Read, Grep, Bash (for running tests against the diff)
- **PR**: no SDK session needed — just the GitHub API

## 10. The Reviewer abstraction

```ts
// src/agents/reviewer.ts

export interface Reviewer {
  reviewPlan(input: { plan: Plan; ticket: Ticket; research: ResearchOutput }): Promise<Critique>;
  reviewCode(input: { diff: string; plan: Plan; testOutput: string }): Promise<CodeReview>;
}

export class ClaudeAdversarialCritic implements Reviewer { /* uses adversarial prompt */ }

// Future: GPT5Reviewer, GeminiReviewer, SecuritySpecialistReviewer, etc.
```

Picked at runtime from `process.env.REVIEWER` (default `claude-adversarial`). Plan-review stage calls `reviewPlan`, code-review stage calls `reviewCode`.

## 11. Git worktree management

```ts
// src/env/worktreeEnvironment.ts

export interface Environment {
  setup(run: Run, repoConfig: RepoConfig): Promise<{ cwd: string; branch: string }>;
  teardown(run: Run): Promise<void>;
}

export class WorktreeEnvironment implements Environment {
  async setup(run, repo) {
    const branch = `${repo.branchPrefix}${run.ticketId}-${slug(run.instructions)}`;
    const path = `${repo.repoPath}/.yavin/worktrees/${run.id}`;
    await git.fetch('origin', repo.baseBranch);
    await git.raw(['worktree', 'add', path, '-b', branch, `origin/${repo.baseBranch}`]);
    return { cwd: path, branch };
  }

  async teardown(run) {
    // intentionally a no-op for MVP; humans inspect worktrees post-hoc.
    // A separate `rogue-one gc` command removes worktrees for terminal runs >N days old.
  }
}
```

A `DockerEnvironment` is a future implementation of the same interface. The orchestrator only knows about `Environment`.

## 12. PR creation

```ts
// src/github/pr.ts

async function openPR(run: Run, ctx: PipelineContext) {
  await git.push('origin', ctx.branch);
  const body = renderPrBody({
    ticket: ctx.ticket,
    plan: ctx.stages.plan.output,
    critique: ctx.stages.planReview.output,
    review: ctx.stages.codeReview.output,
    testOutput: ctx.stages.code.output.testOutput,
    runUrl: `${YAVIN_URL}/runs/${run.id}`,
  });
  const { data } = await octokit.pulls.create({
    owner, repo,
    title: `${ctx.ticket.id}: ${ctx.ticket.summary}`,
    head: ctx.branch,
    base: ctx.repoConfig.baseBranch,
    body,
  });
  return { url: data.html_url, number: data.number };
}
```

PR body template includes the plan summary, critique trail, review trail, test output, and a link back to the yavin-iv run page so reviewers can dig into the full event log.

## 13. Failure handling

Three failure tiers:

**1. Tool/agent error inside a stage** — the SDK session throws or the assistant returns malformed output. Orchestrator catches, emits `stage.failed`, retries once with the error appended to the prompt. On second failure, run goes to `awaiting_human_intervention`.

**2. Stuck detection** — `stuckDetector` watches the event stream. If no event arrives for >5 minutes (configurable per repo), it kills the SDK session, treats it as a failure, and triggers the retry path above.

**3. Connection loss to yavin-iv** — pipeline pauses (no new stages start, in-flight stage continues running but events buffer), reconnects via exponential backoff, replays buffered events, resumes.

A `run.cancel` from yavin-iv at any point: cancels the active SDK session via `AbortController`, emits a final `stage.failed` with reason `cancelled`, transitions run to `cancelled`.

## 14. Configuration

All via env vars for v1:

```
YAVIN_URL=http://localhost:3000
YAVIN_API_KEY=<shared key>
GITHUB_TOKEN=<for PR creation>
ROGUE_ONE_WORKER_LABEL=laptop  # shows up in yavin-iv as the worker name
ROGUE_ONE_STUCK_TIMEOUT_MS=300000
REVIEWER=claude-adversarial
```

Agent auth is **not** an env var: the Claude Agent SDK spawns the `claude` CLI
under the hood and rides on whatever session `claude login` established. This
keeps Claude Pro/Max subscription users out of the API-billing path. If
`ANTHROPIC_API_KEY` is set in the environment, the SDK will quietly switch to
API billing — the worker warns about this at startup.

Repo-specific config (paths, base branch, concurrency) lives in yavin-iv's `repo_configs` and is fetched on `run.start`. rogue-one has no local repo config file.

## 15. Build phases

### Phase 1 — Worker skeleton (week 1)
- TypeScript scaffold, `@yavin/protocol` dependency
- WebSocket client with reconnect + outbox
- `rogue-one worker` boots, connects to yavin-iv, claims runs, replies with stub events
- `rogue-one start` CLI hitting `POST /api/runs`
- Slash command registered with Claude Code

**Demoable:** worker connects to yavin-iv, you can `/rogue-one "test" <url>` from Claude Code, a run appears in yavin-iv's dashboard, worker emits a fake `stage.completed` for research.

### Phase 2 — Research stage real (week 2)
- Claude Agent SDK wrapper in `src/agents/session.ts`
- Research stage: prompts, tool restriction, ticket lookup via `/api/tickets/lookup`, structured output validation
- Event streaming wired up (every SDK message → `event.append` + `agent.message` to yavin-iv)
- `awaitGate('post_research')` blocking on yavin-iv's gate decision
- Stuck detector

**Demoable:** real Linear ticket → real research brief in yavin-iv → human approves → pipeline pauses (no further stages yet).

### Phase 3 — Full pipeline (weeks 3-4)
- Plan stage with structured plan schema
- Plan review stage using `ClaudeAdversarialCritic`, one revision round
- `WorktreeEnvironment` setup
- Code stage in the worktree, full toolset, test execution
- Code review stage with one comment-addressing round
- PR stage: push branch, open GitHub PR with templated body
- `awaitGate` for all three gates
- Auto-retry-once on stage failure

**Demoable:** end-to-end happy path on one repo. `/rogue-one` → research → approve → plan → critique → revise → approve → code → review → approve → PR opens.

### Phase 4 — Reliability for daily use (week 5)
- Reconnect + replay correctness under network blips
- `run.cancel` honored mid-stage
- `awaiting_human_intervention` flow on second failure
- Per-stage cost tracking (tokens, model, USD) emitted in `agent.message`
- Concurrency-limit cooperation with yavin-iv (worker respects yavin-iv's go-ahead, never starts a run on its own)
- All three ticket providers used in research (Jira, Linear, GitHub Issues)

**Demoable:** team uses it daily, cancellations work, costs visible per run, multiple concurrent runs respect limits.

## 16. What rogue-one does NOT do

These are explicitly yavin-iv's job:

- Persist run state, events, gate decisions, or transcripts (it sends them; yavin-iv stores them)
- Render any UI
- Hold integration credentials (Jira tokens, Linear keys) — yavin-iv proxies ticket lookups
- Decide when a run is allowed to start (concurrency is yavin-iv's call)
- Authenticate humans

If you find yourself reaching for a database or building a web page in a rogue-one PR, stop and ask whether it should be a yavin-iv feature instead.

## 17. Open questions before phase 3

- **Plan output schema strictness.** Recommendation: strict required fields (steps array, files-touched, tests-to-add) plus a free-form `notes` per step. Coordinate the schema in `@yavin/protocol`.
- **Critic loop bound.** Critic → planner-revises → critic-rechecks could loop forever. **Recommendation:** one revision round in MVP, then ship `(plan, critique, revision)` to the human gate even if the critic still has objections.
- **Subagent isolation.** SDK runs subagents in-process. Acceptable on a trusted dev laptop; revisit when moving to shared infra.
- **Multi-repo tickets.** Out of scope for MVP. Hard error in `rogue-one start` if the cwd doesn't match a single registered repo.
- **Worktree GC policy.** Manual `rogue-one gc` for v1. Decide retention (7 days? 30?) before users start filling disks.
- **What if Claude Code is not the only invocation surface?** Today the slash command is the only entry. If you later want a "kick off from yavin-iv UI" button, the worker already supports it — it just claims any pending run, regardless of who created it. The CLI command is one path; yavin-iv's REST endpoint is another.