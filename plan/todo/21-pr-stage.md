# 21 — PR stage

**Phase:** 3
**Depends on:** 18, 19, 20

## Goal

Push the branch and open a GitHub PR with a templated body referencing the run.

## Scope

- `pnpm add @octokit/rest`.
- `src/github/pr.ts`:
  ```ts
  async function openPR(args: {
    run: Run; repoConfig: RepoConfig;
    branch: string;
    ticket: Ticket;
    plan: PlanOutput;
    planReview: PlanReviewOutput;
    code: CodeOutput;
    codeReview: CodeReviewOutput;
  }): Promise<PrOutput>;
  ```
- Steps:
  1. `git push origin <branch>` from the worktree.
  2. Build PR body from a template that includes: plan summary, critique trail, review trail, test output excerpt, link to `${YAVIN_URL}/runs/${run.id}`.
  3. `octokit.pulls.create(...)`.
  4. Return `PrOutput` (`title`, `body`, `url`, `number`).
- `src/pipeline/stages/pr.ts` wraps `openPR` so it fits the orchestrator's stage shape — no SDK session needed.

## Acceptance criteria

- Against a test GitHub repo, the stage pushes the branch and opens a PR whose body contains the dashboard link.
- `PrOutput` validates against the zod schema.

## Notes

- `GITHUB_TOKEN` must scope to `repo` for this org's repos.
- Don't add merge/label/assign logic — keep this stage minimal.
