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

## Implementation notes (2026-05-12)

- **Module:** `src/cli/index.ts`. `main(argv, deps?)` is now `async` and uses `program.parseAsync(...)` so commander awaits the action.
- **Surface change:** `main` now accepts a `CliDeps` second arg with `createClient?` and `startWorker?` factories — used by tests; production callers pass nothing.
- **`start` flags:**
  - `--repo-config-id <id>` — accepted as an option (not a required positional) for flexibility, but the action errors with `"--repo-config-id is required (auto-detection lands in a later task)."` when absent.
  - `--ticket-provider <provider>` — default `"jira"`. Validated against `TICKET_PROVIDERS` from `@cmhrabi/yavin-protocol`; invalid value exits non-zero with the allowed list.
  - **No `--ticket-id` flag** (user preference, 2026-05-12): the CLI takes only `<instructions> <ticket-url>` from callers. `ticketId` is derived silently.
  - **No `--ticket-title` flag** — the protocol's `CreateRunInput` doesn't carry it, so adding the flag was deferred to keep this task minimal.
- **`deriveTicketId(url)`** is exported (used by tests + reused elsewhere later if needed): parses the URL, takes the last non-empty `pathname` segment, falls back to the URL string when there's no usable path. Throws if `new URL()` rejects; caller surfaces a clear error.
- **Output:**
  - Success: `Run created: <baseUrl>/runs/<id>` + `Status: <status>`, exit 0.
  - `YavinApiError`: `rogue-one start: HTTP <status> — <body summary>` (body summary trimmed to 500 chars), exit 1.
  - Other errors (bad URL, missing env via `YavinClient` constructor): `rogue-one start: <message>`, exit 1.
- **Tests:** `src/__sanity__/cli-start.test.ts` — 6 cases:
  1. `deriveTicketId` extracts the last path segment for jira/github/linear-shaped URLs.
  2. `deriveTicketId` falls back to the URL when the path is empty.
  3. Happy path: POSTs `createRun` with the derived `ticketId`, prints the dashboard URL and status.
  4. Missing `--repo-config-id` exits 1 with the helpful message.
  5. Invalid `--ticket-provider` exits 1 listing allowed values.
  6. `YavinApiError` from the server is surfaced as `HTTP 400` + body summary.
- **Test plumbing:** tests stub `console.log/error` and override `process.exit` (which throws an `__exit_N__` sentinel) so we can assert exit codes without actually exiting the test process. Fetch is mocked by injecting a `FetchLike` into a custom `YavinClient` via `createClient`.
- **Out of scope (intentional):**
  - Repo-config auto-detection from `cwd` — waiting on a yavin-iv lookup endpoint.
  - `--ticket-title` pass-through — wait until the protocol's `CreateRunInput` carries it.
  - `--wait` / polling — explicitly off-limits per the task spec.
