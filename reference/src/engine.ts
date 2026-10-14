import { SnapshotStore } from "./store.js";
import {
  ApiError,
  Json,
  Lease,
  Reply,
  Run,
  State,
  TERMINAL,
  TaskDef,
  Workflow,
} from "./types.js";
import { canonical, isObject, validateWorkflow } from "./validate.js";

function freshState(): State {
  return {
    now: 0,
    counters: { wf: 0, run: 0, lease: 0 },
    workflows: {},
    workflowByName: {},
    runs: {},
    leases: {},
    idempotency: {},
  };
}

interface Transition {
  due: number;
  runSeq: number;
  task: string;
  apply: () => void;
}

export class Engine {
  private state: State;

  constructor(private readonly store: SnapshotStore<State>) {
    this.state = store.load() ?? freshState();
  }

  private commit(): void {
    this.store.save(this.state);
  }

  // ---------------------------------------------------------------- clock

  clock(): Reply {
    return { status: 200, body: { now: this.state.now } };
  }

  advance(body: unknown): Reply {
    if (!isObject(body) || typeof body.ms !== "number" || !Number.isInteger(body.ms) || body.ms < 0) {
      throw new ApiError(400, "invalid_request", "ms must be a non-negative integer");
    }
    this.processDue(this.state.now + body.ms);
    this.commit();
    return { status: 200, body: { now: this.state.now } };
  }

  /** Apply every time-based transition due at or before `target`, in spec order. */
  private processDue(target: number): void {
    for (;;) {
      let best: Transition | null = null;
      const consider = (t: Transition) => {
        if (t.due > target) return;
        if (
          best === null ||
          t.due < best.due ||
          (t.due === best.due && (t.runSeq < best.runSeq || (t.runSeq === best.runSeq && t.task < best.task)))
        ) {
          best = t;
        }
      };
      for (const run of Object.values(this.state.runs)) {
        if (run.status !== "running") continue;
        for (const [name, ts] of Object.entries(run.tasks)) {
          if (ts.status === "waiting_retry" && ts.nextAttemptAt !== null) {
            consider({ due: ts.nextAttemptAt, runSeq: run.seq, task: name, apply: () => this.wake(run, name) });
          }
        }
      }
      for (const lease of Object.values(this.state.leases)) {
        if (lease.state !== "active") continue;
        const run = this.state.runs[lease.runId];
        consider({ due: lease.expiresAt, runSeq: run.seq, task: lease.task, apply: () => this.expire(lease) });
      }
      if (best === null) break;
      const t: Transition = best;
      if (t.due > this.state.now) this.state.now = t.due;
      t.apply();
    }
    if (target > this.state.now) this.state.now = target;
  }

  private wake(run: Run, name: string): void {
    const ts = run.tasks[name];
    ts.status = "ready";
    ts.nextAttemptAt = null;
    this.emit(run, "task.ready", name, {});
  }

  private expire(lease: Lease): void {
    lease.state = "expired";
    const run = this.state.runs[lease.runId];
    const ts = run.tasks[lease.task];
    const entry = ts.history[lease.attempt - 1];
    entry.outcome = "expired";
    entry.endedAt = lease.expiresAt;
    if (run.status !== "running") return;
    this.emit(run, "task.lease_expired", lease.task, { attempt: lease.attempt, leaseId: lease.id });
    this.attemptFailed(run, lease.task, lease.attempt, "lease_expired");
  }

  // ------------------------------------------------------------ workflows

  createWorkflow(body: unknown): Reply {
    const draft = validateWorkflow(body);
    if (this.state.workflowByName[draft.name]) {
      throw new ApiError(409, "workflow_exists", `workflow ${draft.name} exists`);
    }
    const id = `wf_${++this.state.counters.wf}`;
    const wf: Workflow = { id, ...draft, createdAt: this.state.now };
    this.state.workflows[id] = wf;
    this.state.workflowByName[wf.name] = id;
    this.commit();
    return { status: 201, body: this.workflowView(wf) };
  }

  getWorkflow(id: string): Reply {
    const wf = this.state.workflows[id];
    if (!wf) throw new ApiError(404, "not_found", "workflow not found");
    return { status: 200, body: this.workflowView(wf) };
  }

  private workflowView(wf: Workflow): Json {
    return {
      id: wf.id,
      name: wf.name,
      createdAt: wf.createdAt,
      leaseTimeoutMs: wf.leaseTimeoutMs,
      retry: { ...wf.retry },
      tasks: wf.tasks.map((t) => ({ name: t.name, type: t.type, priority: t.priority, dependsOn: [...t.dependsOn] })),
    };
  }

  // ----------------------------------------------------------------- runs

  startRun(workflowId: string, key: string | undefined, body: unknown): Reply {
    const wf = this.state.workflows[workflowId];
    if (!wf) throw new ApiError(404, "not_found", "workflow not found");
    const k = (key ?? "").trim();
    if (k === "") throw new ApiError(400, "missing_idempotency_key", "Idempotency-Key required");
    if (body !== undefined && !isObject(body)) throw new ApiError(400, "invalid_request", "body must be an object");
    const input: Json = body === undefined || body.input === undefined ? null : (body.input as Json);
    const canon = canonical(input);

    const prior = this.state.idempotency[k];
    if (prior) {
      if (prior.workflowId === workflowId && prior.canon === canon) {
        return { status: 200, body: this.runView(this.state.runs[prior.runId]) };
      }
      throw new ApiError(409, "idempotency_conflict", "key reused with different request");
    }

    const seq = ++this.state.counters.run;
    const run: Run = {
      id: `run_${seq}`,
      seq,
      workflowId,
      status: "running",
      input,
      createdAt: this.state.now,
      finishedAt: null,
      tasks: {},
      events: [],
    };
    for (const t of wf.tasks) {
      run.tasks[t.name] = {
        status: t.dependsOn.length === 0 ? "ready" : "blocked",
        attempts: 0,
        nextAttemptAt: null,
        output: null,
        error: null,
        history: [],
      };
    }
    this.state.runs[run.id] = run;
    this.state.idempotency[k] = { workflowId, runId: run.id, canon };
    this.emit(run, "run.created", null, {});
    for (const name of wf.tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.name).sort()) {
      this.emit(run, "task.ready", name, {});
    }
    this.commit();
    return { status: 201, body: this.runView(run) };
  }

  getRun(id: string): Reply {
    return { status: 200, body: this.runView(this.mustRun(id)) };
  }

  events(id: string, after: string | null): Reply {
    const run = this.mustRun(id);
    let n = 0;
    if (after !== null) {
      if (!/^\d+$/.test(after)) throw new ApiError(400, "invalid_request", "after must be a non-negative integer");
      n = Number(after);
    }
    return { status: 200, body: { events: run.events.filter((e) => e.seq > n) as unknown as Json } };
  }

  cancel(id: string): Reply {
    const run = this.mustRun(id);
    if (run.status !== "running") throw new ApiError(409, "run_finalized", "run already finished");
    for (const name of Object.keys(run.tasks).sort()) {
      const ts = run.tasks[name];
      if (TERMINAL.has(ts.status)) continue;
      ts.status = "cancelled";
      ts.nextAttemptAt = null;
      this.emit(run, "task.cancelled", name, {});
    }
    run.status = "cancelled";
    run.finishedAt = this.state.now;
    this.emit(run, "run.cancelled", null, {});
    this.commit();
    return { status: 200, body: this.runView(run) };
  }

  private mustRun(id: string): Run {
    const run = this.state.runs[id];
    if (!run) throw new ApiError(404, "not_found", "run not found");
    return run;
  }

  private runView(run: Run): Json {
    const tasks: Record<string, Json> = {};
    for (const [name, ts] of Object.entries(run.tasks)) {
      tasks[name] = {
        status: ts.status,
        attempts: ts.attempts,
        nextAttemptAt: ts.nextAttemptAt,
        output: ts.output,
        error: ts.error,
        history: ts.history.map((h) => ({ ...h })),
      };
    }
    return {
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      input: run.input,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      tasks,
    };
  }

  // --------------------------------------------------------------- leases

  lease(body: unknown): Reply {
    const b = body === undefined ? {} : body;
    if (!isObject(b) || typeof b.workerId !== "string" || b.workerId.length === 0) {
      throw new ApiError(400, "invalid_request", "workerId required");
    }
    let types: string[] | null = null;
    if (b.types !== undefined) {
      if (
        !Array.isArray(b.types) ||
        b.types.length === 0 ||
        !b.types.every((t) => typeof t === "string" && t.length > 0)
      ) {
        throw new ApiError(400, "invalid_request", "types must be a non-empty array of strings");
      }
      types = b.types as string[];
    }

    let pick: { run: Run; def: TaskDef } | null = null;
    for (const run of Object.values(this.state.runs)) {
      if (run.status !== "running") continue;
      const wf = this.state.workflows[run.workflowId];
      for (const def of wf.tasks) {
        if (run.tasks[def.name].status !== "ready") continue;
        if (types && !types.includes(def.type)) continue;
        if (
          pick === null ||
          def.priority > pick.def.priority ||
          (def.priority === pick.def.priority &&
            (run.seq < pick.run.seq || (run.seq === pick.run.seq && def.name < pick.def.name)))
        ) {
          pick = { run, def };
        }
      }
    }
    if (pick === null) return { status: 204 };

    const { run, def } = pick;
    const wf = this.state.workflows[run.workflowId];
    const ts = run.tasks[def.name];
    const workerId = b.workerId;
    const leaseId = `lease_${++this.state.counters.lease}`;
    ts.attempts += 1;
    ts.status = "leased";
    ts.history.push({
      attempt: ts.attempts,
      leaseId,
      workerId,
      startedAt: this.state.now,
      endedAt: null,
      outcome: "running",
    });
    const lease: Lease = {
      id: leaseId,
      runId: run.id,
      task: def.name,
      attempt: ts.attempts,
      workerId,
      expiresAt: this.state.now + wf.leaseTimeoutMs,
      state: "active",
      result: null,
    };
    this.state.leases[leaseId] = lease;
    this.emit(run, "task.leased", def.name, { attempt: lease.attempt, leaseId, workerId });
    const parentOutputs: Record<string, Json> = {};
    for (const d of def.dependsOn) parentOutputs[d] = run.tasks[d].output;
    this.commit();
    return {
      status: 200,
      body: {
        leaseId,
        runId: run.id,
        workflowId: wf.id,
        task: def.name,
        type: def.type,
        attempt: lease.attempt,
        expiresAt: lease.expiresAt,
        input: run.input,
        parentOutputs,
      },
    };
  }

  heartbeat(id: string): Reply {
    const lease = this.mustLease(id);
    if (lease.state === "completed" || lease.state === "failed") {
      throw new ApiError(409, "lease_finalized", "lease already reported");
    }
    if (lease.state === "expired") throw new ApiError(410, "lease_expired", "lease expired");
    const run = this.state.runs[lease.runId];
    if (run.status === "cancelled") throw new ApiError(409, "run_cancelled", "run cancelled");
    lease.expiresAt = this.state.now + this.state.workflows[run.workflowId].leaseTimeoutMs;
    this.commit();
    return { status: 200, body: { leaseId: lease.id, expiresAt: lease.expiresAt } };
  }

  complete(id: string, body: unknown): Reply {
    const lease = this.mustLease(id);
    if (body !== undefined && !isObject(body)) throw new ApiError(400, "invalid_request", "body must be an object");
    const output: Json = body === undefined || body.output === undefined ? null : (body.output as Json);

    if (lease.state === "completed") return { status: 200, body: lease.result };
    if (lease.state === "failed") throw new ApiError(409, "lease_finalized", "lease already failed");
    if (lease.state === "expired") throw new ApiError(410, "lease_expired", "lease expired");

    const run = this.state.runs[lease.runId];
    const ts = run.tasks[lease.task];
    const entry = ts.history[lease.attempt - 1];
    lease.state = "completed";
    entry.outcome = "succeeded";
    entry.endedAt = this.state.now;

    if (run.status === "cancelled") {
      this.emit(run, "task.late_report", lease.task, {
        attempt: lease.attempt,
        leaseId: lease.id,
        outcome: "succeeded",
      });
      lease.result = { leaseId: lease.id, status: "completed", applied: false };
    } else {
      ts.status = "succeeded";
      ts.output = output;
      this.emit(run, "task.succeeded", lease.task, { attempt: lease.attempt });
      const wf = this.state.workflows[run.workflowId];
      const ready = wf.tasks
        .filter(
          (t) =>
            t.dependsOn.includes(lease.task) &&
            run.tasks[t.name].status === "blocked" &&
            t.dependsOn.every((d) => run.tasks[d].status === "succeeded"),
        )
        .map((t) => t.name)
        .sort();
      for (const name of ready) {
        run.tasks[name].status = "ready";
        this.emit(run, "task.ready", name, {});
      }
      this.maybeFinish(run);
      lease.result = { leaseId: lease.id, status: "completed", applied: true };
    }
    this.commit();
    return { status: 200, body: lease.result };
  }

  fail(id: string, body: unknown): Reply {
    const lease = this.mustLease(id);
    if (!isObject(body) || typeof body.error !== "string" || body.error.length === 0) {
      throw new ApiError(400, "invalid_request", "error must be a non-empty string");
    }
    const error = body.error;

    if (lease.state === "failed") return { status: 200, body: lease.result };
    if (lease.state === "completed") throw new ApiError(409, "lease_finalized", "lease already completed");
    if (lease.state === "expired") throw new ApiError(410, "lease_expired", "lease expired");

    const run = this.state.runs[lease.runId];
    const ts = run.tasks[lease.task];
    const entry = ts.history[lease.attempt - 1];
    lease.state = "failed";
    entry.outcome = "failed";
    entry.endedAt = this.state.now;

    if (run.status === "cancelled") {
      this.emit(run, "task.late_report", lease.task, {
        attempt: lease.attempt,
        leaseId: lease.id,
        outcome: "failed",
      });
      lease.result = { leaseId: lease.id, status: "failed", applied: false };
    } else {
      this.attemptFailed(run, lease.task, lease.attempt, error);
      lease.result = { leaseId: lease.id, status: "failed", applied: true };
      // A zero backoff makes the task ready again within this request.
      this.processDue(this.state.now);
    }
    this.commit();
    return { status: 200, body: lease.result };
  }

  private mustLease(id: string): Lease {
    const lease = this.state.leases[id];
    if (!lease) throw new ApiError(404, "not_found", "lease not found");
    return lease;
  }

  // ------------------------------------------------------------- internals

  private attemptFailed(run: Run, name: string, attempt: number, error: string): void {
    const wf = this.state.workflows[run.workflowId];
    const ts = run.tasks[name];
    ts.error = error;
    const { maxAttempts, baseBackoffMs, multiplier, maxBackoffMs } = wf.retry;
    if (attempt < maxAttempts) {
      const delay = Math.min(maxBackoffMs, Math.floor(baseBackoffMs * Math.pow(multiplier, attempt - 1)));
      ts.status = "waiting_retry";
      ts.nextAttemptAt = this.state.now + delay;
      this.emit(run, "task.attempt_failed", name, { attempt, error, retryAt: ts.nextAttemptAt });
      return;
    }
    ts.status = "failed";
    ts.nextAttemptAt = null;
    this.emit(run, "task.failed", name, { attempt, error });
    for (const d of this.descendants(wf, name)) {
      const ds = run.tasks[d];
      if (TERMINAL.has(ds.status)) continue;
      ds.status = "skipped";
      ds.nextAttemptAt = null;
      this.emit(run, "task.skipped", d, {});
    }
    this.maybeFinish(run);
  }

  private descendants(wf: Workflow, name: string): string[] {
    const out = new Set<string>();
    const stack = [name];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const t of wf.tasks) {
        if (t.dependsOn.includes(cur) && !out.has(t.name)) {
          out.add(t.name);
          stack.push(t.name);
        }
      }
    }
    return [...out].sort();
  }

  private maybeFinish(run: Run): void {
    const all = Object.values(run.tasks);
    if (!all.every((t) => TERMINAL.has(t.status))) return;
    run.status = all.some((t) => t.status === "failed") ? "failed" : "succeeded";
    run.finishedAt = this.state.now;
    this.emit(run, run.status === "failed" ? "run.failed" : "run.succeeded", null, {});
  }

  private emit(run: Run, type: string, task: string | null, data: Record<string, Json>): void {
    run.events.push({ seq: run.events.length + 1, at: this.state.now, type, task, data });
  }
}
