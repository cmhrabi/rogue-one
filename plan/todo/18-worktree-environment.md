# 18 — Worktree environment

**Phase:** 3
**Depends on:** 01

## Goal

`Environment` interface + `WorktreeEnvironment` implementation for the code stage.

## Scope

- `pnpm add simple-git`.
- `src/env/environment.ts`:
  ```ts
  interface Environment {
    setup(run: Run, repoConfig: RepoConfig): Promise<{ cwd: string; branch: string }>;
    teardown(run: Run): Promise<void>;
  }
  ```
- `src/env/worktreeEnvironment.ts`:
  - Branch name: `${repo.branchPrefix}${run.ticketId}-${slug(run.instructions)}`.
  - Path: `${repo.repoPath}/.yavin/worktrees/${run.id}`.
  - `git fetch origin <baseBranch>` then `git worktree add <path> -b <branch> origin/<baseBranch>`.
  - `teardown` is a no-op for MVP (humans inspect post-hoc; a separate GC command handles cleanup later).
- `src/git/branch.ts`: `slug()` helper, `push(branch)` wrapper.
- `src/git/worktree.ts`: thin shell-outs for `worktree add` / `worktree remove` / `worktree list`.

## Acceptance criteria

- Unit test using a tmp git repo: `setup()` creates the worktree at the expected path on a new branch off `origin/<baseBranch>`.
- Idempotency: calling `setup()` for the same run when a worktree already exists either reuses or fails with a clear error (decide; documenting reuse is fine).

## Notes

- Worktrees can pile up — don't add cleanup-on-success here; that's a deliberate later command.
- Use `simple-git` for porcelain ops and raw shell for `worktree` subcommands.
