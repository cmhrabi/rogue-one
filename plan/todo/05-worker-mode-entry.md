# 05 — `rogue-one worker` entrypoint

**Phase:** 1
**Depends on:** 03, 04

## Goal

`rogue-one worker` boots, validates config, connects to yavin-iv, claims any in-flight runs from the previous process, and stub-completes the research stage for any `run.start` it receives.

## Scope

- `src/cli/index.ts` registers `commander` commands; add a `worker` subcommand that calls `src/worker/index.ts:startWorker()`.
- `startWorker()`:
  1. Reads + validates env (`YAVIN_URL`, `YAVIN_API_KEY`, optional `ROGUE_ONE_WORKER_LABEL`). Bail with a clear message if missing.
  2. `getHealth()` and `whoami()` to fail fast on bad config.
  3. Constructs `YavinConnection` and connects.
  4. On `run.start`, send a stub flow:
     - `stage.started` for `research`
     - one `event.append` of kind `log` saying "stub worker received run X"
     - `stage.completed` for `research` with a placeholder `ResearchOutput`
     - `gate.await` `post_research` with that output as payload
  5. On `gate.decided`, log it. Do nothing else (real pipeline lands in Phase 3).
  6. On `run.cancel`, log it.
  7. SIGINT/SIGTERM: close the connection cleanly and exit 0.
- Reconciliation on startup: not yet — handled in task 23. For now, just log if `whoami` succeeds.

## Acceptance criteria

- `node bin/rogue-one worker` against a running yavin-iv dev server:
  - Connects, prints whoami label.
  - Stays alive answering pings.
  - Responds to a manually-created run with a `gate.await` visible in the yavin-iv UI.
- Ctrl-C exits cleanly.

## Notes

- Use `pino` for logs. Include `runId` field on every relevant log line.
- Don't validate the stub research output yet — validation tightens up in task 10.
