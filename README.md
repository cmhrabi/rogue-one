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
