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
