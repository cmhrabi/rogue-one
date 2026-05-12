# 06 — `rogue-one start` CLI

**Phase:** 1
**Depends on:** 03

## Goal

Short-lived CLI that POSTs `/api/runs`, prints a dashboard link, exits. This is what the slash command invokes.

## Scope

- `commander` subcommand: `rogue-one start <instructions> <ticket-url> [--repo-config-id <id>]`.
- Behavior:
  1. Validate env (`YAVIN_URL`, `YAVIN_API_KEY`).
  2. Determine `repoConfigId`:
     - If `--repo-config-id` given, use it.
     - Otherwise, infer from `cwd` — for Phase 1 this can be a TODO that errors with "pass --repo-config-id". Proper repo matching is a later task once yavin-iv exposes a lookup endpoint.
  3. Parse `--ticket-provider` (default `jira`) and pass through `ticketId`, `ticketUrl`, optional `ticketTitle`.
  4. Call `createRun()` from the REST client.
  5. Print `Run created: <YAVIN_URL>/runs/<id>` and the run status.
  6. Exit 0 on success, non-zero on error with a clear message.
- No long-lived behavior, no WS connection.

## Acceptance criteria

- `rogue-one start "fix the thing" "https://jira/ENG-1" --repo-config-id <uuid>` against a dev yavin-iv creates a run row.
- If the worker is already connected, that worker sees `run.start` shortly after.
- Errors (bad token, bad repoConfigId) print a usable message and exit non-zero.

## Notes

- Don't poll the run — the dashboard is the source of truth for status.
- Resist adding "wait for completion" flags here. Keep `start` synchronous-and-out.
