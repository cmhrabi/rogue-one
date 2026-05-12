# 03 — yavin-iv REST client

**Phase:** 1
**Depends on:** 02

## Goal

Thin REST client in `src/yavin/client.ts` covering the endpoints rogue-one needs.

## Scope

Implement, typed against `@cmhrabi/yavin-protocol` where possible:

- `getHealth(): Promise<{ ok: true }>` — `GET /api/health`, no auth.
- `whoami(): Promise<{ kind: "apiKey"; userId: string; keyId: string; label: string }>` — `GET /api/whoami`.
- `createRun(input): Promise<{ run: Run; stages: Stage[] }>` — `POST /api/runs` with body matching the contract §4.
- `getRun(id): Promise<{ run: Run; stages: Stage[]; events: Event[] }>` — `GET /api/runs/{id}` (needed for stage UUIDs on reconnect).

Cross-cutting:

- Reads `YAVIN_URL` (a.k.a. `YAVIN_BASE_URL`) and `YAVIN_API_KEY` from env on construction; takes them via constructor for tests.
- Bearer auth header on every authenticated call.
- One-shot retry on 5xx with 500ms jitter; surface 4xx as `YavinApiError` containing status, body.
- Use the global `fetch` (Node 20 has it native — no `node-fetch` dep).

## Acceptance criteria

- Unit tests with a stub fetch verify:
  - Bearer header is set on authenticated calls and absent on `/api/health`.
  - 5xx triggers exactly one retry, then throws.
  - 4xx throws `YavinApiError` immediately with parsed body.
- `pnpm typecheck` passes.

## Notes

- Gate decisions are NOT a worker endpoint. Do not add a `decideGate` method.
- Don't add endpoints not listed in the contract §4 unless a later task requires them.

## Implementation notes (2026-05-12)

- **Module:** `src/yavin/client.ts`. Exports:
  - `class YavinClient` — methods `getHealth`, `whoami`, `createRun`, `getRun`.
  - `class YavinApiError extends Error` — fields `status: number`, `body: unknown`.
  - `type FetchLike`, `type YavinClientOptions`, `type WhoAmI`, `type CreateRunInput`, `type CreateRunResponse`, `type GetRunResponse`.
- **Env-var precedence** in the constructor: `opts.baseUrl ?? YAVIN_URL ?? YAVIN_BASE_URL`, `opts.apiKey ?? YAVIN_API_KEY`. Missing either throws on construction.
- **Retry policy:** exactly one retry on `status >= 500`, with delay `retryBaseMs + random(0..200ms)`. Default `retryBaseMs = 500`. Tests pass `retryBaseMs: 1` to stay fast.
- **Request timeout:** 30s per attempt via `AbortController` + `setTimeout`. Override via `timeoutMs`.
- **Auth header:** `Authorization: Bearer <apiKey>` set only on `auth: true` calls. `/api/health` is unauthenticated.
- **Body parsing on error:** `readBodySafe` tries `JSON.parse` then falls back to plain text. The parsed value lands in `YavinApiError.body`.
- **`createRun` input shape** matches the contract §4 fields the worker can fill in: `ticketProvider, ticketId, ticketUrl, instructions`, plus optional `repoConfigId`. If yavin-iv needs more fields later (e.g., `branchPrefix`), extend `CreateRunInput`.
- **Tests:** `src/__sanity__/client.test.ts` — 5 cases: header presence absent on health, present on whoami; 5xx retry-once (asserts 2 fetch calls); 5xx → 200 succeeds; 4xx throws immediately with parsed body (1 fetch call).
