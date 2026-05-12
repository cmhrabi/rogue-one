# rogue-one build plan

Breakdown of `implementation-plan.md` into discrete, individually completable tasks.

## Layout

- `context.md` — shared yavin-iv integration context (read first before any task)
- `todo/` — pending tasks, prefixed with phase + ordering (`01-…`, `02-…`)
- `completed/` — move task files here when done

## Workflow

1. Pick the lowest-numbered unblocked file in `todo/`.
2. Read `context.md` plus the task file.
3. Implement against the acceptance criteria.
4. `git mv plan/todo/<file>.md plan/completed/<file>.md` when done.

## Phases

### Phase 1 — Worker skeleton (week 1)
- `01-typescript-scaffold.md`
- `02-protocol-dependency-setup.md`
- `03-yavin-rest-client.md`
- `04-websocket-client.md`
- `05-worker-mode-entry.md`
- `06-cli-start-command.md`
- `07-slash-command-registration.md`

**Phase 1 demo target:** worker connects to yavin-iv, `/rogue-one "test" <url>` from Claude Code produces a run in the dashboard, worker emits a stub `stage.completed` for research.

### Phase 2 — Research stage real (week 2)
- `08-claude-agent-sdk-wrapper.md`
- `09-research-stage-prompt.md`
- `10-research-stage-execution.md`
- `11-event-streaming-pipeline.md`
- `12-await-gate-mechanism.md`
- `13-stuck-detector.md`

**Phase 2 demo target:** real ticket → real research brief → human approves → pipeline pauses.

### Phase 3 — Full pipeline (weeks 3-4)
- `14-pipeline-orchestrator.md`
- `15-plan-stage.md`
- `16-reviewer-abstraction.md`
- `17-plan-review-stage.md`
- `18-worktree-environment.md`
- `19-code-stage.md`
- `20-code-review-stage.md`
- `21-pr-stage.md`
- `22-retry-on-failure.md`

**Phase 3 demo target:** end-to-end happy path on one repo with all three gates.

### Phase 4 — Reliability for daily use (week 5)
- `23-reconnect-replay-hardening.md`
- `24-cancel-handling.md`
- `25-human-intervention-flow.md`
- `26-cost-tracking.md`
- `27-concurrency-cooperation.md`
- `28-ticket-providers.md`

**Phase 4 demo target:** team uses daily, cancels work, costs visible, concurrency respected.
