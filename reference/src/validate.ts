import { ApiError, Json, RetryPolicy, TaskDef } from "./types.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_MS = 86_400_000;

export function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isName(v: unknown): v is string {
  return typeof v === "string" && NAME_RE.test(v);
}

export interface WorkflowDraft {
  name: string;
  tasks: TaskDef[];
  retry: RetryPolicy;
  leaseTimeoutMs: number;
}

export function validateWorkflow(body: unknown): WorkflowDraft {
  const bad = (msg: string) => new ApiError(400, "invalid_definition", msg);

  if (!isObject(body)) throw bad("body must be an object");
  if (!isName(body.name)) throw bad("invalid workflow name");
  if (!Array.isArray(body.tasks)) throw bad("tasks must be an array");

  const tasks: TaskDef[] = [];
  for (const raw of body.tasks) {
    if (!isObject(raw)) throw bad("task must be an object");
    if (!isName(raw.name)) throw bad("invalid task name");
    let type = "default";
    if (raw.type !== undefined) {
      if (typeof raw.type !== "string" || raw.type.length === 0) throw bad("invalid task type");
      type = raw.type;
    }
    let priority = 0;
    if (raw.priority !== undefined) {
      if (!isInt(raw.priority)) throw bad("priority must be an integer");
      priority = raw.priority;
    }
    let deps: string[] = [];
    if (raw.dependsOn !== undefined) {
      if (!Array.isArray(raw.dependsOn) || !raw.dependsOn.every((d) => typeof d === "string")) {
        throw bad("dependsOn must be an array of strings");
      }
      deps = [...new Set(raw.dependsOn as string[])].sort();
    }
    tasks.push({ name: raw.name, type, priority, dependsOn: deps });
  }

  const retry: RetryPolicy = { maxAttempts: 3, baseBackoffMs: 1000, multiplier: 2, maxBackoffMs: 60000 };
  if (body.retry !== undefined) {
    const r = body.retry;
    if (!isObject(r)) throw bad("retry must be an object");
    if (r.maxAttempts !== undefined) {
      if (!isInt(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > 20) throw bad("maxAttempts");
      retry.maxAttempts = r.maxAttempts;
    }
    if (r.baseBackoffMs !== undefined) {
      if (!isInt(r.baseBackoffMs) || r.baseBackoffMs < 0 || r.baseBackoffMs > MAX_MS) throw bad("baseBackoffMs");
      retry.baseBackoffMs = r.baseBackoffMs;
    }
    if (r.multiplier !== undefined) {
      const m = r.multiplier;
      if (typeof m !== "number" || !Number.isFinite(m) || m < 1 || m > 10) throw bad("multiplier");
      retry.multiplier = m;
    }
    if (r.maxBackoffMs !== undefined) {
      if (!isInt(r.maxBackoffMs) || r.maxBackoffMs < 0 || r.maxBackoffMs > MAX_MS) throw bad("maxBackoffMs");
      retry.maxBackoffMs = r.maxBackoffMs;
    }
  }
  if (retry.maxBackoffMs < retry.baseBackoffMs) throw bad("maxBackoffMs must be >= baseBackoffMs");

  let leaseTimeoutMs = 30000;
  if (body.leaseTimeoutMs !== undefined) {
    const l = body.leaseTimeoutMs;
    if (!isInt(l) || l < 1 || l > MAX_MS) throw bad("leaseTimeoutMs");
    leaseTimeoutMs = l;
  }

  if (tasks.length === 0) throw new ApiError(400, "empty_workflow", "workflow has no tasks");

  const names = new Set<string>();
  for (const t of tasks) {
    if (names.has(t.name)) throw new ApiError(400, "duplicate_task", `duplicate task ${t.name}`);
    names.add(t.name);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!names.has(d)) throw new ApiError(400, "unknown_dependency", `${t.name} depends on unknown ${d}`);
    }
  }
  assertAcyclic(tasks);

  return { name: body.name, tasks, retry, leaseTimeoutMs };
}

function assertAcyclic(tasks: TaskDef[]): void {
  const deps = new Map(tasks.map((t) => [t.name, t.dependsOn]));
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (n: string): void => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) throw new ApiError(400, "cycle_detected", `cycle through ${n}`);
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) visit(d);
    state.set(n, 2);
  };
  for (const t of tasks) visit(t.name);
}

/** JSON value with object keys sorted, for order-insensitive equality. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (isObject(x)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) out[k] = norm(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}
