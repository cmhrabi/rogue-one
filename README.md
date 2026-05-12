# rogue-one

Headless SDLC workflow engine — the Claude Code worker that drives the
yavin-iv pipeline (research → plan → plan_review → code → code_review → pr).

See `implementation-plan.md` for the architecture overview and
`plan/README.md` for the task breakdown.

## Setup

Requires Node.js 20+ and pnpm.

`@cmhrabi/yavin-protocol` is published to **GitHub Packages**, so `pnpm install`
needs an auth token. Export a `GITHUB_TOKEN` (a PAT with `read:packages`, or
`gh auth token` if your gh CLI is signed in with that scope) **before**
running install:

```sh
export GITHUB_TOKEN=$(gh auth token)
pnpm install
```

If your gh token does not already have `read:packages`, add it:

```sh
gh auth refresh -s read:packages
```

## Scripts

| Command           | Purpose                                                  |
|-------------------|----------------------------------------------------------|
| `pnpm build`      | Compile TypeScript to `dist/`.                           |
| `pnpm typecheck`  | `tsc --noEmit`.                                          |
| `pnpm lint`       | ESLint.                                                  |
| `pnpm test`       | Run `*.test.ts` under `tsx --test`.                      |
| `pnpm dev`        | Watch + run `src/worker/index.ts`.                       |
| `pnpm start`      | Run the built worker (`dist/worker/index.js`).           |

## Environment

```
YAVIN_URL=http://localhost:3000          # or YAVIN_BASE_URL
YAVIN_API_KEY=yvn_…
GITHUB_TOKEN=…                            # for @cmhrabi/yavin-protocol + PR creation
ROGUE_ONE_WORKER_LABEL=laptop
ROGUE_ONE_STUCK_TIMEOUT_MS=300000
REVIEWER=claude-adversarial
```

Auth for the agent goes through the `claude` CLI's own session — `claude login`
once and the worker picks up that auth via the Claude Agent SDK. **Do not set
`ANTHROPIC_API_KEY`** unless you want to bill via the Anthropic API instead of
your Claude Code subscription; the worker warns if it sees one.

## CLI

```sh
# Long-lived worker — connects to yavin-iv and executes runs.
rogue-one worker

# Short-lived — creates a run via the REST API and exits.
rogue-one start "<instructions>" "<ticket-url>" --repo-config-id <uuid>
```

`rogue-one start` flags:

| Flag                       | Default | Notes                                                  |
|----------------------------|---------|--------------------------------------------------------|
| `--repo-config-id <uuid>`  | —       | Required for now. Auto-detection lands in a later task. |
| `--ticket-provider <p>`    | `jira`  | One of `jira`, `linear`, `github`.                      |

The `ticketId` is derived from the URL's last path segment (e.g. `https://jira/browse/ENG-1` → `ENG-1`).

## Using the slash command

The repo ships a Claude Code slash command at `.claude/commands/rogue-one.md`.
Inside any Claude Code session opened on a clone of this repo it registers
`/rogue-one`, which shells to `rogue-one start "$ARGUMENTS"`.

Prerequisites:

1. A `rogue-one worker` process is already running and connected to yavin-iv
   (otherwise the run row will sit at `pending` until a worker picks it up).
2. The `rogue-one` binary is on `PATH`. From inside this repo:
   ```sh
   pnpm build
   npm link        # or: pnpm link --global
   ```

Usage:

```
/rogue-one "fix the thing" "https://jira.example.com/browse/ENG-1"
```

The command returns within ~1s with a dashboard URL — watch the yavin-iv UI
for status updates rather than waiting on the slash command itself.

## Manual testing the research stage

End-to-end smoke test for the Phase 2 demo target: real ticket → real
research brief → human approves → pipeline pauses.

### 1. Prereqs

- A running yavin-iv dev server (`http://localhost:3000` is the default).
- A yavin-iv API key (`yvn_…`) issued to your user. Generate one in the
  dashboard; the key is shown once.
- The `claude` CLI on `PATH`, signed in via `claude login`. The Claude Agent
  SDK delegates to that CLI, so your Claude Code subscription is what funds
  the run — no Anthropic API key required.
- A repo config already created in yavin-iv. Note the `repoConfigId` (UUID)
  and confirm its `repoPath` points at a local clone you've checked out —
  the research agent reads files relative to that path.
- A ticket whose ID/URL you'll feed in (Jira, Linear, or GitHub).

### 2. Set env

```sh
export YAVIN_URL=http://localhost:3000
export YAVIN_API_KEY=yvn_…
export GITHUB_TOKEN=$(gh auth token)     # needed for pnpm install
export ROGUE_ONE_WORKER_LABEL=laptop     # optional, shows in worker logs
```

Run `claude login` once on this machine so the agent SDK has subscription auth
to ride on. The worker logs `claude CLI: ok` at startup if it finds the CLI; it
warns and lets you continue if not, but the first run will then fail.

### 3. Build + link

```sh
pnpm install
pnpm build
npm link        # makes `rogue-one` available on PATH
```

### 4. Start the worker

In one terminal:

```sh
rogue-one worker
```

You should see, in order:

- `rogue-one worker: starting`
- `yavin: whoami ok` (with your key label)
- `yavin ws: open`

The worker is now waiting for `run.start` over the WebSocket.

### 5. Kick off a run

In a second terminal (or via `/rogue-one` inside Claude Code):

```sh
rogue-one start "investigate where rate limits are enforced" \
  "https://your-jira/browse/ENG-42" \
  --repo-config-id <your-repo-config-uuid>
```

The CLI prints a dashboard URL within ~1s and exits.

### 6. Watch yavin-iv

Open the run page. Within seconds the worker should:

1. Mark the `research` stage `running`.
2. Stream interleaved `log` / `tool_call` / `tool_result` / `message`
   events into the run's event log as Claude reads files, greps, and (if
   needed) hits the web.
3. Emit `stage.completed` with the validated research output:
   `{ brief, citations[], notes? }`.
4. Transition the run to `awaiting_research_approval` and open the
   `post_research` gate.

The worker logs `post_research gate decided` once you act on the gate.

### 7. Approve the gate

Click **Approve** in the yavin-iv UI. The worker prints the decision in its
log. The pipeline stays paused after the gate — subsequent stages (plan,
plan_review, code, code_review, pr) land in later tasks (14+). For now the
demo ends here.

### 8. Negative paths to spot-check

- **Bad JSON.** Temporarily replace the body of
  `src/agents/prompts/researcher.md` with text that drops the JSON
  contract. Rebuild, restart the worker, kick off another run. The
  dashboard should show `stage.failed` with `error` mentioning
  `StageOutputInvalidError`. Restore the prompt when done.
- **Cancel.** While a run is mid-research, click **Cancel** in the yavin-iv
  UI. The worker logs `run.cancel: aborting in-flight run` and never sends
  `stage.completed`. The agent session shuts down within a few seconds.
- **Reconnect.** Kill the worker (`Ctrl-C`) mid-run, then restart it. The
  worker reconnects to yavin-iv but the in-flight stage is lost — currently
  expected. Full reconnect/replay hardening lands in task 23. For now,
  cancel the orphaned run in the UI and start a fresh one.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `whoami` fails with 401 | `YAVIN_API_KEY` is wrong, revoked, or missing the `worker` scope. |
| WS connects then closes immediately | Token in the WS URL got truncated or URL-decoded. Check the worker logs for `yavin ws: error`. |
| Run sits at `pending` forever | No worker is connected, or the worker is connected to a different yavin-iv instance. |
| `stage.failed` with `StageOutputInvalidError` | The model returned something that didn't match the `ResearchOutput` zod schema. Re-run; if it persists, the prompt may have regressed. |
| `agent.message queue overflow` in worker logs | `findStageUuid` exhausted its retries. Yavin-iv may have rejected `stage.started`. Check yavin-iv's logs. |

