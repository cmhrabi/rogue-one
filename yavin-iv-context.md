# Integrating with yavin-iv

This document is the complete contract for a rogue-one worker that drives runs in yavin-iv. Read it top to bottom; you will not need to open the yavin-iv source to get a worker running.

---

## 1. What this is

**yavin-iv** is a dashboard and durable record for AI-driven SDLC runs. It owns a Postgres database, a REST API, a WebSocket server, and a web UI. It does **not** run agents.

**rogue-one** is the worker. It connects to yavin over a WebSocket, claims runs that yavin has accepted, executes the six stages (research → plan → plan_review → code → code_review → pr), and streams stage transitions, events, and agent messages back so the dashboard can show progress live and humans can approve at three gates.

```
                    +-----------------------+
                    |    yavin-iv (this)    |
                    |  Next.js + Postgres   |
                    +-----------+-----------+
                                |
        REST  /api/...    +-----+-----+   WS  /ws?role=worker
        (create runs,     |   HTTP    |  (stream stages,
         keys, whoami)    |  server   |   events, gates)
                          +-----+-----+
                                |
                +---------------+----------------+
                |                                |
       Human (browser)                    rogue-one (worker)
       reviews stages, decides            claims runs, drives
       gates over WS as `client`          stages, reports back

Flow per run:
  1. Human (or rogue-one via REST) creates a run     -> yavin row, status=pending
  2. yavin sends `run.start` to an available worker  -> status=researching
  3. Worker drives a stage, streams events           -> stage.started, event.append, agent.message
  4. Worker completes a stage                        -> stage.completed (status=awaiting_*_approval via gate.await)
  5. Human approves/rejects in the dashboard         -> server emits `gate.decided` to the worker
  6. Worker continues to next stage, repeats
  7. Final stage opens PR                            -> status=completed
```

---

## 2. Get the protocol types

Shared TypeScript types live in `@cmhrabi/yavin-protocol`, published to GitHub Packages. Use them in rogue-one so you cannot accidentally drift from the wire format.

### One-time setup in rogue-one

Create a GitHub personal access token with `read:packages` scope. Export it as `GITHUB_TOKEN`.

Add an `.npmrc` to the rogue-one repo root:

```
@cmhrabi:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Install:

```bash
pnpm add @cmhrabi/yavin-protocol
```

### Import

```ts
import type {
  // domain
  Run, Stage, Event, RepoConfig, Ticket,
  RunStatus, StageKind, StageStatus,
  GateKind, GateDecision,
  // wire envelopes
  WorkerToServer, ServerToWorker,
} from "@cmhrabi/yavin-protocol";

import {
  RUN_STATUSES, VALID_TRANSITIONS, canTransition,
  STAGE_KINDS, STAGE_STATUSES,
  GATE_KINDS, GATE_DECISIONS,
  // zod schemas for stage outputs:
  ResearchOutput, PlanOutput, CodeOutput, CodeReviewOutput, PrOutput,
} from "@cmhrabi/yavin-protocol";
```

The source of truth is `packages/protocol/src/` in this repo (`messages.ts`, `runStatus.ts`, `schemas.ts`). If you ever need to read it directly, that's where to look.

---

## 3. Authentication

### API key format

```
yvn_<8-hex-prefix>_<32-base64url-secret>
```

Example: `yvn_a1b2c3d4_jK-fL_mNoPqRsTuVwXyZAbCd1234`

Keys are minted in the yavin dashboard under **Settings** (or via `POST /api/keys`). The raw value is shown **once at creation**; only a bcrypt hash is stored, so you cannot recover a lost key. Each key is scoped to a single yavin user; any run a worker drives is created under that user.

### REST

Every authenticated REST call uses a bearer header:

```
Authorization: Bearer yvn_a1b2c3d4_<secret>
```

### WebSocket

The upgrade request accepts the same bearer header, or — more commonly — a `token` query param:

```
ws://localhost:3000/ws?role=worker&token=<urlencoded-key>
```

Close codes:

- `4400` — bad role, bad message envelope, or unhandled message kind.
- `4401` — unauthorized (no valid auth on the upgrade request).
- `1011` — server error.

---

## 4. REST endpoints rogue-one calls

Base URL is whatever the yavin deployment uses; in dev it's `http://localhost:3000`. Set this as `YAVIN_BASE_URL` in rogue-one.

### `GET /api/health` (no auth)

Liveness probe. Returns `{ ok: true }`. Use this in startup checks.

### `GET /api/whoami`

Returns the resolved caller — use this to sanity-check that your API key is valid and points at the right user before opening the WebSocket.

```jsonc
// 200 OK (API key)
{ "kind": "apiKey", "userId": "...", "keyId": "...", "label": "rogue-one-prod" }
```

### `POST /api/runs`

Create a new run. Typically the dashboard creates runs from a ticket; include this endpoint in rogue-one only if you want to create runs headlessly.

```jsonc
// Request
{
  "repoConfigId": "uuid",
  "ticketProvider": "jira" | "linear" | "github",
  "ticketId": "ENG-482",
  "ticketUrl": "https://...",
  "ticketTitle": "Add retries to webhook ingester",
  "instructions": ""    // optional
}

// 201 Created
{ "run": { ...Run }, "stages": [ ...Stage ] }
```

If a worker is already connected when this is called, yavin will immediately push `run.start` to it (no `run.claim` needed).

### `GET /api/runs/{id}`

Fetch a run with its stages (including their UUIDs) and the full ordered event log. Use this on worker startup to recover state after a reconnect or restart.

```jsonc
// 200 OK
{ "run": { ...Run }, "stages": [ ...Stage ], "events": [ ...Event ] }
```

You need this to learn stage UUIDs — `run.start` does not include them, and `agent.message` / `stage.failed` require a real stage UUID.

> Gate decisions (`POST /api/runs/{id}/gates/{kind}`) are made by humans in the dashboard — workers do not call this endpoint. Workers signal `gate.await` and wait for a `gate.decided` reply over the WebSocket.

---

## 5. WebSocket worker protocol

### Connect

```
ws://localhost:3000/ws?role=worker&token=<urlencoded-key>
```

Use `wss://` for any non-local deployment. The server attaches WS on the same HTTP port as the REST API.

### Heartbeat

The server sends `{ "kind": "ping" }` immediately on connect and every 30 seconds thereafter. You must respond with `{ "kind": "pong" }` within 60 seconds or the server will terminate the connection.

```ts
if (msg.kind === "ping") ws.send(JSON.stringify({ kind: "pong" }));
```

### Inbound messages (`ServerToWorker`)

```ts
type ServerToWorker =
  | { kind: "run.start"; run: Run; repoConfig: RepoConfig; ticket: Ticket }
  | { kind: "gate.decided"; runId: string; gateKind: GateKind;
      decision: GateDecision; feedback?: string }
  | { kind: "run.cancel"; runId: string }
  | { kind: "ping" };
```

- **`run.start`** — yavin is handing you a run. The run is already in status `researching` when you receive this; you do **not** need to send `run.claim`. Begin work on the `research` stage immediately.
- **`gate.decided`** — a human has resolved a gate you signalled with `gate.await`. Inspect `decision`:
  - `"approved"` → proceed to the next stage.
  - `"rejected"` → terminate the run (yavin has already moved it to `cancelled`/`failed` server-side; nothing more to do).
  - `"regenerate"` → re-run the current stage from scratch, taking `feedback` into account.
- **`run.cancel`** — a human cancelled the run. Stop work and release any local resources.
- **`ping`** — reply `pong`.

### Outbound messages (`WorkerToServer`)

```ts
type WorkerToServer =
  | { kind: "run.claim"; runId: string }
  | { kind: "run.status"; runId: string; status: RunStatus }
  | { kind: "stage.started"; runId: string; stage: Stage }
  | { kind: "stage.completed"; runId: string; stage: Stage }
  | { kind: "stage.failed"; runId: string; stageId: string; error: string }
  | { kind: "event.append"; event: EventInput }
  | { kind: "agent.message"; message: AgentMessageInput }
  | { kind: "gate.await"; runId: string; gateKind: GateKind; payload: unknown }
  | { kind: "pong" };
```

When to send each:

- **`run.claim`** — pull a specific pending run. Optional: if a worker is already connected when a run is created, yavin pushes `run.start` automatically. Use `run.claim` only when reconciling on startup (e.g., you crashed and want to pick a run back up).
- **`run.status`** — informational only; the server logs it but does not change state. You generally don't need to send this.
- **`stage.started`** — when you begin work on a stage. The server looks up the stage by `(runId, stage.kind)`, so the `stage.id` field can be anything (it is not used for upsert). Set `stage.status: "running"` and `startedAt`.
- **`stage.completed`** — when a stage finishes successfully. Include the stage `output` matching the schema for that kind (see §7). Server upserts by `(runId, kind)`.
- **`stage.failed`** — when a stage errors. Requires a real stage UUID (`stageId`) — fetch it from `GET /api/runs/{id}` on startup. This also transitions the run to `failed`.
- **`event.append`** — append one log/tool-call/tool-result/message event. The server assigns a monotonic `seq` per run; do **not** set it yourself. `stageId` is nullable — pass `null` if you don't have the UUID at hand.
- **`agent.message`** — record a Claude API turn (one user/assistant/system/tool message with token counts and cost). Requires a real stage UUID. Use `GET /api/runs/{id}` to learn it.
- **`gate.await`** — signal that a stage has completed and the run is now waiting for human approval. Pass the stage `output` as the `payload` so the dashboard can render it. yavin will transition the run to the matching `awaiting_*_approval` status and emit `gate.awaiting` to subscribed dashboard clients. Wait for `gate.decided` before proceeding.
- **`pong`** — reply to `ping`.

---

## 6. Run lifecycle

```ts
const STAGE_KINDS  = ["research", "plan", "plan_review", "code", "code_review", "pr"];
const STAGE_STATUSES = ["pending", "running", "completed", "failed", "superseded"];
const GATE_KINDS     = ["post_research", "post_plan", "pre_pr"];
const GATE_DECISIONS = ["approved", "rejected", "regenerate"];
```

**Gate kind → status the run enters when you send `gate.await`:**

| `gateKind`      | run status               | sent after stage |
| --------------- | ------------------------ | ---------------- |
| `post_research` | `awaiting_research_approval` | `research`   |
| `post_plan`     | `awaiting_plan_approval` | `plan_review`    |
| `pre_pr`        | `awaiting_pr_approval`   | `code_review`    |

**Run status flow (happy path):**

```
pending → researching → awaiting_research_approval → planning → reviewing_plan
   → awaiting_plan_approval → coding → reviewing_code → awaiting_pr_approval
   → opening_pr → completed
```

Failure / cancellation / human intervention branches exist from most states. The full `VALID_TRANSITIONS` map ships in `@cmhrabi/yavin-protocol` and is the authoritative contract — if you ever need to send `run.status` explicitly, validate with `canTransition(from, to)` first.

Notes:

- After `run.start`, the run is already in `researching` and `currentStage` is `research`. Yavin handles the transition to subsequent stages when gate decisions land; the worker drives the work, yavin owns the state machine.
- A worker missing the heartbeat is terminated server-side. The run is **not** automatically failed — it remains in whatever stage it was in. On reconnect, call `GET /api/runs/{id}` to find owned runs and resume.

---

## 7. Stage output schemas

Validate before sending with the Zod schemas exported from `@cmhrabi/yavin-protocol`.

| stage         | `stage.output` shape |
| ------------- | -------------------- |
| `research`    | `{ brief: string, citations: { url, title? }[], notes?: string }` |
| `plan`        | `{ summary: string, steps: { title, description, files: string[], notes? }[] }` |
| `plan_review` | `{ critique: string, revisedPlan?: PlanOutput, decision: "accept" \| "revise" }` |
| `code`        | `{ files: { path, status, oldPath?, diff }[], summary?: string }` — `status ∈ {added, modified, deleted, renamed}`; `diff` is a unified diff |
| `code_review` | `{ comments: { path, line, severity, message }[], summary: string, decision: "accept" \| "revise" }` — `severity ∈ {info, suggestion, issue, blocker}` |
| `pr`          | `{ title: string, body: string, url?: string, number?: number }` |

The dashboard renders these directly; if the shape is off, the UI will still display but with rough fallback formatting.

---

## 8. Worked example — research stage happy path

```ts
import WebSocket from "ws";
import type {
  ServerToWorker, WorkerToServer, Run,
} from "@cmhrabi/yavin-protocol";

const token = process.env.YAVIN_API_KEY!;
const baseUrl = process.env.YAVIN_BASE_URL ?? "http://localhost:3000";
const wsUrl = baseUrl.replace(/^http/, "ws") +
  `/ws?role=worker&token=${encodeURIComponent(token)}`;

const ws = new WebSocket(wsUrl);
const send = (msg: WorkerToServer) => ws.send(JSON.stringify(msg));

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerToWorker;
  switch (msg.kind) {
    case "ping":
      return send({ kind: "pong" });
    case "run.start":
      return void doResearch(msg.run);
    case "gate.decided":
      console.log(`gate ${msg.gateKind} -> ${msg.decision} on run=${msg.runId}`);
      // if approved, drive the next stage; if rejected/cancel, stop.
      return;
    case "run.cancel":
      console.log(`run cancelled: ${msg.runId}`);
      return;
  }
});

async function doResearch(run: Run) {
  // 1. Mark the stage running. Server upserts by (runId, kind) — stage.id is ignored.
  send({
    kind: "stage.started",
    runId: run.id,
    stage: {
      id: "ignored", runId: run.id, kind: "research", status: "running",
      attempt: 1, startedAt: new Date().toISOString(), endedAt: null,
      output: null, errorText: null,
    },
  });

  // 2. Stream a few events. seq is assigned server-side; do not set it.
  for (const beat of [
    { kind: "log",         payload: { message: `Reading ${run.ticketId}` } },
    { kind: "tool_call",   payload: { name: "fetch_ticket", args: { url: run.ticketUrl } } },
    { kind: "tool_result", payload: { name: "fetch_ticket", ok: true } },
  ]) {
    send({
      kind: "event.append",
      event: { runId: run.id, stageId: null, kind: beat.kind, payload: beat.payload },
    });
  }

  // 3. Complete the stage with a research brief.
  const output = {
    brief: `## Summary\n\nResearch for ${run.ticketTitle ?? run.ticketId}`,
    citations: [{ url: run.ticketUrl, title: run.ticketId }],
  };
  send({
    kind: "stage.completed",
    runId: run.id,
    stage: {
      id: "ignored", runId: run.id, kind: "research", status: "completed",
      attempt: 1, startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      output, errorText: null,
    },
  });

  // 4. Hand off to the human reviewer.
  send({
    kind: "gate.await", runId: run.id, gateKind: "post_research", payload: output,
  });
}
```

A reference implementation of the full lifecycle (research-only, but with realistic logging) lives at `scripts/stub-worker.ts` in this repo.

---

## 9. Reconnection and resume

The server does **not** replay anything automatically on reconnect. To resume:

1. Reconnect to `/ws?role=worker&token=...`.
2. For each run rogue-one believes it owns, call `GET /api/runs/{id}` to refetch the run, its stages (with UUIDs), and the full event log.
3. Inspect `run.status` and `run.currentStage`. If a stage is `running`, continue from there; if it's `awaiting_*_approval`, just wait for `gate.decided`.
4. Re-sending `stage.started` / `stage.completed` for an already-completed stage is safe — the server upserts by `(runId, kind)`.

If you need to pull a specific pending run that yavin hasn't dispatched to you yet, send `{ kind: "run.claim", runId }`. The server will transition it to `researching` and reply with `run.start`.

---

## 10. Configuration

| Env var | What it's for |
| --- | --- |
| `YAVIN_BASE_URL` | yavin's HTTP origin, e.g. `http://localhost:3000`. Used to derive both REST and WS URLs. |
| `YAVIN_API_KEY`  | The `yvn_…` token. Bearer for REST, `?token=` for WS. |
| `GITHUB_TOKEN`   | PAT with `read:packages` — only needed at install time for `pnpm add @cmhrabi/yavin-protocol`. |

---

## 11. Reference — where to look in yavin-iv if you need to dig deeper

| File | What's in it |
| --- | --- |
| `packages/protocol/src/messages.ts` | Domain types (`Run`, `Stage`, `Event`, ...) and wire envelopes (`ServerToWorker`, `WorkerToServer`). |
| `packages/protocol/src/runStatus.ts` | `RUN_STATUSES`, `VALID_TRANSITIONS`, `canTransition`. |
| `packages/protocol/src/schemas.ts` | Zod schemas for each stage's `output`. |
| `src/server/ws.ts` | WS upgrade, role dispatch, heartbeat, worker/client message handlers. |
| `src/server/ws-auth.ts` | How the upgrade request is authenticated. |
| `src/server/api-keys.ts` | Key format, generation, verification. |
| `src/server/runs.ts` | `createRun`, `claimRun`, `transitionStatus`, `updateStage` — the state machine. |
| `src/server/events.ts` | `appendEvent` and the per-run `seq` allocation (advisory lock). |
| `src/server/gates.ts` | Gate decision recording and resulting transitions. |
| `scripts/stub-worker.ts` | Working example of a research-stage worker. |
