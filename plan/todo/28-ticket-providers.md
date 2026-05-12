# 28 — All three ticket providers used in research

**Phase:** 4
**Depends on:** 10

## Goal

Research stage handles tickets from Jira, Linear, and GitHub Issues end-to-end.

## Scope

- Confirm the `Ticket` shape on `run.start` is provider-agnostic (per protocol). If extra fields are needed for any provider (e.g., comments, attachments), check whether yavin-iv exposes `GET /api/tickets/lookup` or includes the data in `run.start`.
- For each provider, run a real ticket through the worker and verify:
  - The research stage produces a brief that cites the real URL.
  - Tool calls (e.g., `fetch_ticket`) succeed if implemented as yavin-iv proxies — or the data is already in `run.start` and no provider-specific call is needed.
- Update the researcher prompt to mention provider differences only if they matter (usually they shouldn't — yavin-iv normalizes).

## Acceptance criteria

- Three demo runs in the dashboard, one per provider, each with a valid research brief and citation back to the ticket.

## Notes

- Per the implementation plan: rogue-one does NOT hold ticket-provider credentials. All provider access goes through yavin-iv. If the contract doesn't yet expose what you need, file an issue against yavin-iv rather than reaching out to Jira/Linear/GitHub APIs directly.
