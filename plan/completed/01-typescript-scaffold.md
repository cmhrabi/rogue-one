# 01 — TypeScript scaffold

**Phase:** 1 (Worker skeleton)
**Depends on:** —

## Goal

Stand up the `rogue-one` Node.js + TypeScript project so subsequent tasks have a buildable, lintable, runnable baseline.

## Scope

- `package.json` with name `rogue-one`, Node 20+ engines field, `type: "module"`.
- `tsconfig.json` (strict, ESM, target ES2022, `outDir: dist`, `rootDir: src`).
- Repo layout from §4 of the implementation plan, created as empty placeholder files or `index.ts` stubs:
  ```
  src/{cli,worker,pipeline/stages,agents/prompts,agents/tools,env,git,github,yavin,util}
  bin/rogue-one
  ```
- Scripts: `build`, `dev` (tsx watch), `lint` (eslint), `typecheck`, `start` (node dist/...).
- Dev deps: `typescript`, `tsx`, `@types/node`, `eslint`, `@typescript-eslint/*`, `prettier`.
- Runtime deps installed but unused yet: `commander`, `pino`, `zod`. (Add `ws`, `simple-git`, `@octokit/rest`, `@anthropic-ai/claude-agent-sdk`, `@cmhrabi/yavin-protocol` in later tasks.)
- `.gitignore` for `node_modules`, `dist`, `.env`, `.yavin/`.
- `bin/rogue-one` shim that requires the built CLI entrypoint and forwards argv.

## Acceptance criteria

- `pnpm install` succeeds.
- `pnpm build` produces `dist/` with no errors.
- `pnpm typecheck` passes.
- `node bin/rogue-one --help` runs (can print a stub `commander` help screen).

## Notes

- pnpm is the package manager (matches yavin-iv install instructions in the contract).
- Don't add prod dependencies you won't use this task — keep the lockfile tight.

## Implementation notes (2026-05-12)

- **Versions actually installed** (Node 24.6.0 on the dev box; engines field still `>=20`):
  - TypeScript 5.9.3, tsx 4.21.0, ESLint 9.39.4 (flat config), Prettier 3.8.3
  - `@types/node` 22.19.19, `@typescript-eslint/*` 8.59.3
  - Runtime: commander 12.1.0, pino 9.14.0, zod 3.25.76
- **ESLint config style:** flat config in `eslint.config.js` (ESLint 9 default). No `.eslintrc.cjs`.
- **Test runner:** `tsx --test "src/**/*.test.ts"` — no jest, no separate config. Tests use `node:test` + `node:assert/strict`.
- **`tsconfig.json` quirks worth knowing:**
  - `module`/`moduleResolution` = `NodeNext` → relative imports inside `src/` must use `.js` suffix, e.g. `import "../protocol.js"`. The compiled JS already lives at that path.
  - Test files and `src/__sanity__/**` are excluded from build output (`tsc -p .`), but `tsx --test` still runs them (it transpiles on the fly).
  - `noUncheckedIndexedAccess: true` is on; tests already use `!` post-fix in a few places.
- **Bin shim** at `bin/rogue-one` is a Node ESM script that dynamically imports `dist/cli/index.js`. Requires `pnpm build` first.
- **CLI subcommands** (`start`, `worker`) are stubs that exit non-zero with "not implemented yet (task NN)" — placeholders are clearly labeled so the next tasks know what to wire.
- **`pnpm` warning** `Failed to replace env in config: ${GITHUB_TOKEN}` is harmless during typecheck/test — only `pnpm install` actually needs the token. Ignore unless `pnpm install` itself fails.
