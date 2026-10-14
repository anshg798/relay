export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  baseBackoffMs: number;
  multiplier: number;
  maxBackoffMs: number;
}

export interface TaskDef {
  name: string;
  type: string;
  priority: number;
  dependsOn: string[];
}

export interface Workflow {
  id: string;
  name: string;
  tasks: TaskDef[];
  retry: RetryPolicy;
  leaseTimeoutMs: number;
  createdAt: number;
}

export type TaskStatus =
  | "blocked"
  | "ready"
  | "leased"
  | "waiting_retry"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "skipped", "cancelled"]);

export interface Attempt {
  attempt: number;
  leaseId: string;
  workerId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "running" | "succeeded" | "failed" | "expired";
}

export interface TaskState {
  status: TaskStatus;
  attempts: number;
  nextAttemptAt: number | null;
  output: Json;
  error: string | null;
  history: Attempt[];
}

export interface RunEvent {
  seq: number;
  at: number;
  type: string;
  task: string | null;
  data: Record<string, Json>;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface Run {
  id: string;
  seq: number;
  workflowId: string;
  status: RunStatus;
  input: Json;
  createdAt: number;
  finishedAt: number | null;
  tasks: Record<string, TaskState>;
  events: RunEvent[];
}

export interface Lease {
  id: string;
  runId: string;
  task: string;
  attempt: number;
  workerId: string;
  expiresAt: number;
  state: "active" | "completed" | "failed" | "expired";
  result: Json;
}

export interface State {
  now: number;
  counters: { wf: number; run: number; lease: number };
  workflows: Record<string, Workflow>;
  workflowByName: Record<string, string>;
  runs: Record<string, Run>;
  leases: Record<string, Lease>;
  idempotency: Record<string, { workflowId: string; runId: string; canon: string }>;
}

export interface Reply {
  status: number;
  body?: Json;
}
