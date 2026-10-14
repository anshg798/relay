# Relay — Durable Workflow Orchestrator

Build **Relay**, an HTTP service that coordinates multi-step workflows. A workflow is a
directed acyclic graph (DAG) of named tasks. Relay never executes task code itself:
external **workers** claim tasks through time-limited **leases** and report the outcome.
Relay tracks dependencies, retries failed attempts with backoff, supports cancellation and
idempotent run creation, and keeps an append-only event log per run.

All state must be **durable**: the process can be killed at any moment with `SIGKILL` and
restarted against the same data directory, and it must continue exactly where it left off.

The project lives in the current working directory (`/workspace`). A minimal TypeScript
skeleton is provided; you may restructure it freely, change languages within Node.js, or add
dependencies. Architecture and storage format are up to you.

---

## 1. Runtime contract

- Node.js 20+. The grader runs `npm install`, then `npm run build` (if a `build` script
  exists), then `npm start` from the project root.
- Only pure-JavaScript npm dependencies may be used (no native add-ons). Node built-ins are
  always available.
- Environment variables:
  - `PORT` — TCP port to listen on (default `8080`).
  - `DATA_DIR` — directory for all persistent state (default `./data`). Create it if missing.
    Never write state anywhere else.
- `GET /health` must return `200` with `{"status":"ok"}` once the server accepts requests.
  The server must be ready within 10 seconds of `npm start`.
- **Durability:** every request that changes state must have that change durably stored
  *before* the response is sent. After a `SIGKILL` and restart on the same `DATA_DIR`, all
  observable state (workflows, runs, tasks, leases, events, idempotency keys, ID counters and
  the clock) must be exactly as it was after the last response.
- Requests are processed one at a time in arrival order as far as observable behaviour is
  concerned: concurrent requests must never observe or produce interleaved partial updates.

## 2. Conventions

- Request and response bodies are JSON (`Content-Type: application/json`). A `204` response
  has an empty body.
- An empty request body is treated as "no body". A non-empty body that is not valid JSON is
  rejected with `400 invalid_json`.
- Every error response has the shape `{"error": {"code": "<code>", "message": "<text>"}}`.
  Only `code` is checked; `message` is free text.
- Precedence for every request: unknown path/method → `404 not_found`; then invalid JSON →
  `400 invalid_json`; then the endpoint-specific checks in the order they are listed below.
- IDs are assigned from global counters that start at 1 and never reuse values:
  workflows `wf_1, wf_2, …`, runs `run_1, run_2, …`, leases `lease_1, lease_2, …`.
  A request that is rejected must not consume an ID.
- "Name order" means ascending order by Unicode code point (plain string comparison).
- Unknown fields in request bodies are ignored.

## 3. Logical clock

Relay never reads wall-clock time. All times are integer milliseconds on a **logical
clock** that starts at `0` for a fresh data directory, is persisted, and only moves when the
test endpoint below advances it.

### `GET /_test/clock`
`200 {"now": <int>}`

### `POST /_test/clock/advance`
Body `{"ms": <int>}`. `ms` must be an integer `>= 0`, otherwise `400 invalid_request`.

Advancing from `t0` to `t1 = t0 + ms` performs, in order, every time-based transition
(lease expiries and retry wake-ups, see §6–§7) whose due time is `<= t1`. Transitions are
processed one at a time: repeatedly take the pending transition with the smallest
`(due time, run creation order, task name)`; it happens **at its due time** (events it emits
carry that time in `at`). Transitions created while processing (for example a retry with zero
backoff) take part in the same ordering. Afterwards the clock reads `t1`.

Response: `200 {"now": t1}`.

## 4. Workflows

### `POST /workflows`
```json
{
  "name": "etl",
  "tasks": [
    {"name": "extract", "type": "io", "priority": 5},
    {"name": "transform", "dependsOn": ["extract"]},
    {"name": "load", "type": "io", "dependsOn": ["transform"]}
  ],
  "retry": {"maxAttempts": 3, "baseBackoffMs": 1000, "multiplier": 2, "maxBackoffMs": 60000},
  "leaseTimeoutMs": 30000
}
```

Field rules (names match `^[a-z0-9][a-z0-9_-]{0,63}$`):

| Field | Rule | Default |
|---|---|---|
| `name` | required, name pattern | — |
| `tasks` | required array | — |
| `tasks[].name` | required, name pattern | — |
| `tasks[].type` | non-empty string | `"default"` |
| `tasks[].priority` | integer (may be negative) | `0` |
| `tasks[].dependsOn` | array of strings | `[]` |
| `retry` | object; each field optional | see below |
| `retry.maxAttempts` | integer 1–20 | `3` |
| `retry.baseBackoffMs` | integer 0–86400000 | `1000` |
| `retry.multiplier` | number 1–10 (may be fractional) | `2` |
| `retry.maxBackoffMs` | integer 0–86400000, and `>= baseBackoffMs` after defaults are applied | `60000` |
| `leaseTimeoutMs` | integer 1–86400000 | `30000` |

Validation, checked in this order (the first failing rule wins):

1. Body not an object, or any field above violates its rule → `400 invalid_definition`.
2. `tasks` is empty → `400 empty_workflow`.
3. Two tasks share a name → `400 duplicate_task`.
4. A `dependsOn` entry names a task not in the workflow → `400 unknown_dependency`.
5. The dependencies contain a cycle (including a task depending on itself) → `400 cycle_detected`.
6. A workflow with the same `name` already exists → `409 workflow_exists`.

On success `201` with the normalized workflow:
```json
{"id": "wf_1", "name": "etl", "createdAt": 0, "leaseTimeoutMs": 30000,
 "retry": {"maxAttempts": 3, "baseBackoffMs": 1000, "multiplier": 2, "maxBackoffMs": 60000},
 "tasks": [{"name": "extract", "type": "io", "priority": 5, "dependsOn": []}, ...]}
```
Tasks keep their submitted order; every default is filled in; each `dependsOn` is
de-duplicated and sorted in name order.

### `GET /workflows/:id`
`200` with the same object, or `404 not_found`.

## 5. Runs

### `POST /workflows/:id/runs`
Header `Idempotency-Key` (required). Body optional: `{"input": <any JSON>}`; `input` defaults
to `null`.

Checks in order:
1. Unknown workflow → `404 not_found`.
2. Header missing or empty after trimming whitespace → `400 missing_idempotency_key`.
3. Body present but not an object → `400 invalid_request`.
4. Idempotency (keys are global across all workflows; compare the trimmed key):
   - Key already used for **this workflow** with an **equal input** → `200` with the existing
     run in its *current* state. Nothing is created. Inputs are equal when they are the same
     JSON value; object key order does not matter, array order does.
   - Key already used otherwise (other workflow, or different input) → `409 idempotency_conflict`.
5. Otherwise create the run → `201` with the run.

A new run starts with status `running`. Tasks with no dependencies are `ready`; all others are
`blocked`. Events: `run.created`, then `task.ready` for each initially ready task in name order.

### Run representation (`GET /runs/:id`, `404 not_found` if unknown)
```json
{
  "id": "run_1", "workflowId": "wf_1", "status": "running",
  "input": {"day": "2026-10-01"}, "createdAt": 0, "finishedAt": null,
  "tasks": {
    "extract": {
      "status": "leased", "attempts": 1, "nextAttemptAt": null,
      "output": null, "error": null,
      "history": [{"attempt": 1, "leaseId": "lease_1", "workerId": "w1",
                   "startedAt": 0, "endedAt": null, "outcome": "running"}]
    }
  }
}
```

- `tasks` has one key per task.
- Task `status`: `blocked`, `ready`, `leased`, `waiting_retry`, `succeeded`, `failed`,
  `skipped`, `cancelled`. The last four are **terminal**.
- `attempts`: number of leases issued for the task.
- `nextAttemptAt`: the wake-up time while `waiting_retry`, otherwise `null`.
- `output`: the output from the successful completion, otherwise `null`.
- `error`: the error of the most recent failed or expired attempt, `null` if none.
- `history`: one entry per attempt in order. `outcome` is `running`, `succeeded`, `failed` or
  `expired`; `endedAt` is `null` while `running`.
- Run `status`: `running`, `succeeded`, `failed`, `cancelled`. When every task of a running
  run is terminal, the run finishes: `failed` if any task is `failed`, else `succeeded`.
  `finishedAt` is set when the run leaves `running`. A permanently failed task does **not**
  stop independent branches; the run keeps going until every task is terminal.

### `GET /runs/:id/events?after=N`
`200 {"events": [...]}` — events with `seq > N` (default `0`) in `seq` order. `after` must be a
non-negative integer, else `400 invalid_request`. Unknown run → `404 not_found`.

Each event: `{"seq": <int>, "at": <int>, "type": "<type>", "task": <name or null>, "data": {...}}`.
`seq` is per run, starts at 1 and has no gaps. `at` is the logical time the event happened.

| type | task | data |
|---|---|---|
| `run.created` | null | `{}` |
| `task.ready` | name | `{}` |
| `task.leased` | name | `{"attempt", "leaseId", "workerId"}` |
| `task.succeeded` | name | `{"attempt"}` |
| `task.attempt_failed` | name | `{"attempt", "error", "retryAt"}` |
| `task.failed` | name | `{"attempt", "error"}` |
| `task.lease_expired` | name | `{"attempt", "leaseId"}` |
| `task.skipped` | name | `{}` |
| `task.cancelled` | name | `{}` |
| `task.late_report` | name | `{"attempt", "leaseId", "outcome"}` (`"succeeded"` or `"failed"`) |
| `run.succeeded` / `run.failed` / `run.cancelled` | null | `{}` |

When one action produces several events they appear in this order: the event for the task the
action targeted, then any resulting `task.ready` / `task.skipped` / `task.cancelled` events in
name order, then the run-level event if the run finished.

### `POST /runs/:id/cancel`
1. Unknown run → `404 not_found`.
2. Run not `running` → `409 run_finalized`.
3. Otherwise every non-terminal task becomes `cancelled` (`nextAttemptAt` → `null`), emitting
   `task.cancelled` in name order, then `run.cancelled`. Returns `200` with the run.

Leases that are active at cancellation stay active until they are reported or expire (§6).

## 6. Leases

### `POST /leases`
Body `{"workerId": "<non-empty string>", "types": ["<non-empty string>", ...]}`; `types` is
optional but, if present, must be a non-empty array of non-empty strings. Invalid →
`400 invalid_request`.

Candidates are `ready` tasks of `running` runs (restricted to the given `types` if supplied).
The chosen task is the one with the **highest priority**, then the **earliest-created run**,
then the **first task in name order**. No candidate → `204`.

Leasing increments `attempts`, sets the task to `leased`, appends a `running` history entry,
emits `task.leased`, and sets `expiresAt = now + leaseTimeoutMs`. Response `200`:
```json
{"leaseId": "lease_1", "runId": "run_1", "workflowId": "wf_1", "task": "extract",
 "type": "io", "attempt": 1, "expiresAt": 30000,
 "input": {"day": "2026-10-01"}, "parentOutputs": {}}
```
`parentOutputs` maps each direct dependency's name to its output.

A lease is **active** until it is completed, failed, or expires. It expires when the clock
reaches `expiresAt` (i.e. it is active only while `now < expiresAt`).

### `POST /leases/:id/heartbeat`
1. Unknown lease → `404 not_found`.
2. Lease already completed or failed → `409 lease_finalized`.
3. Lease expired → `410 lease_expired`.
4. The lease's run is cancelled → `409 run_cancelled`.
5. Otherwise `expiresAt = now + leaseTimeoutMs`; `200 {"leaseId": "...", "expiresAt": <int>}`.
   No event is emitted.

### `POST /leases/:id/complete`
Body optional: `{"output": <any JSON>}` (default `null`).
1. Unknown lease → `404 not_found`.
2. Body present but not an object → `400 invalid_request`.
3. Lease already completed → `200` with exactly the body of the original response; nothing
   changes (a different `output` is ignored).
4. Lease already failed → `409 lease_finalized`.
5. Lease expired → `410 lease_expired`.
6. Run cancelled → the attempt is recorded (`outcome` `succeeded`, `endedAt` = now) but the task
   stays `cancelled` and its `output` stays `null`. Emits `task.late_report`. Response
   `200 {"leaseId": "...", "status": "completed", "applied": false}`.
7. Otherwise the task becomes `succeeded` with the output; emits `task.succeeded`. Every
   dependent task whose dependencies have now **all** succeeded becomes `ready`. Response
   `200 {"leaseId": "...", "status": "completed", "applied": true}`.

### `POST /leases/:id/fail`
Body `{"error": "<non-empty string>"}`.
1. Unknown lease → `404 not_found`.
2. Missing/invalid `error` → `400 invalid_request`.
3. Lease already failed → `200` with exactly the original response body; nothing changes.
4. Lease already completed → `409 lease_finalized`.
5. Lease expired → `410 lease_expired`.
6. Run cancelled → like complete step 6 with `outcome` `failed`; response
   `{"leaseId": "...", "status": "failed", "applied": false}`.
7. Otherwise the attempt fails (§7). Response
   `200 {"leaseId": "...", "status": "failed", "applied": true}`.

### Lease expiry
When an active lease expires (during a clock advance):
- Its history entry gets `outcome` `expired` and `endedAt` = `expiresAt`.
- If the run is `running`: emit `task.lease_expired`, then the attempt fails (§7) with
  error `"lease_expired"`.
- If the run is cancelled: nothing else happens and no event is emitted.

## 7. Failed attempts and retries

When attempt `n` of a task fails (reported failure or expiry), the task's `error` is set and:

- If `n < maxAttempts`: the task becomes `waiting_retry` with
  `nextAttemptAt = now + delay(n)` and emits `task.attempt_failed` (`retryAt` =
  `nextAttemptAt`), where
  `delay(n) = min(maxBackoffMs, floor(baseBackoffMs * multiplier^(n-1)))`.
  When the clock reaches `nextAttemptAt` the task becomes `ready` (emitting `task.ready`) and
  `nextAttemptAt` becomes `null`. With a delay of `0` this happens immediately, in the same
  request.
- Otherwise the task becomes `failed` and emits `task.failed`. Every **transitive** dependent
  that is not yet terminal becomes `skipped` (`task.skipped`, name order). The run then
  finishes if all of its tasks are terminal.

A task whose dependency failed can never become `ready`, even if its other dependencies
succeed later.

## 8. Summary of error codes

`not_found` (404), `invalid_json` (400), `invalid_request` (400), `invalid_definition` (400),
`empty_workflow` (400), `duplicate_task` (400), `unknown_dependency` (400),
`cycle_detected` (400), `workflow_exists` (409), `missing_idempotency_key` (400),
`idempotency_conflict` (409), `run_finalized` (409), `run_cancelled` (409),
`lease_finalized` (409), `lease_expired` (410).

Your implementation is evaluated only through this HTTP interface, including restarts of the
process with `SIGKILL`. Any file layout and storage format are acceptable as long as the
behaviour above holds.


---
You are working in the project directory (/workspace). Implement the service there. The grader will run `npm install`, `npm run build` and `npm start` in that directory. This is a single attempt: finish when your implementation is complete.
