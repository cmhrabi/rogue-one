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
ANTHROPIC_API_KEY=…
GITHUB_TOKEN=…                            # for @cmhrabi/yavin-protocol + PR creation
ROGUE_ONE_WORKER_LABEL=laptop
ROGUE_ONE_STUCK_TIMEOUT_MS=300000
REVIEWER=claude-adversarial
```

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

