# 07 — Claude Code slash command registration

**Phase:** 1
**Depends on:** 06

## Goal

`/rogue-one <instructions> <ticket-url>` works inside Claude Code by shelling to `rogue-one start`.

## Scope

- Add `.claude/commands/rogue-one.md` to the repo with the right frontmatter / body for Claude Code to register the command and forward `$ARGUMENTS` to a shell command.
- The command body invokes `rogue-one start "$@"` (or the equivalent that preserves quoted args).
- README section "Using the slash command":
  - prerequisite: `npm i -g rogue-one` or local link
  - prerequisite: worker process running
  - example usage

## Acceptance criteria

- After `npm link` (or equivalent), running `/rogue-one "fix the thing" "https://jira/ENG-1"` in Claude Code produces a run in yavin-iv.
- The slash command returns within ~1s (no long blocking on Claude Code's side).

## Notes

- The command file is committed alongside the package so any clone gets the slash command on `.claude/` load. User-level config is documented but not required.
- If Claude Code's slash-command format changes, update this file — it is the only contact point.

## Implementation notes (2026-05-12)

- **File:** `.claude/commands/rogue-one.md`. Frontmatter:
  - `description` — single-line, includes usage hint for the slash-command picker.
  - `allowed-tools: Bash(rogue-one:*)` — restricts the Bash use to the `rogue-one` binary so the slash command is auto-approved.
  - `argument-hint` — visible UX hint while typing `/rogue-one`.
- **Body:** `!rogue-one start $ARGUMENTS`. The leading `!` is Claude Code's bash-prefix; `$ARGUMENTS` preserves quoted args from the slash-command invocation so `"<instructions>" "<ticket-url>"` arrive intact.
- **README addition:** new `## CLI` and `## Using the slash command` sections under the existing `## Environment` block. Documents:
  - `rogue-one worker` vs. `rogue-one start` modes.
  - `--repo-config-id` / `--ticket-provider` flags.
  - That `ticketId` is derived silently from the URL.
  - The two prerequisites: worker process running + `rogue-one` on `PATH` (`pnpm build && npm link`).
  - That the slash command returns in ~1s; the dashboard is the source of truth.
- **No code change** — purely repo content. The CLI plumbing was completed by task 06.
- **Manual verification (not automated):** the slash command file format is whatever Claude Code expects today; the task itself flags this as the canary update point if the format changes.
- **Out of scope (intentional):**
  - Auto-installing the binary on `.claude/` load.
  - User-level (`~/.claude/commands/`) installation — documented as optional, not automated.
  - Per-repo `repoConfigId` autodetection that would let the slash command run without the `--repo-config-id` flag — that lands when yavin-iv exposes a lookup endpoint, and at that point the slash command can drop the flag entirely.
