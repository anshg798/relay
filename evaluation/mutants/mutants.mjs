// Mutant definitions: each is a realistic bug injected into the reference solution.
// `edits` are exact find/replace pairs applied to reference/<file>; every `find`
// must occur exactly once. `npm run check:mutants -- --regen` rewrites the .patch files.
export const mutants = [
  {
    id: "M01-attempt-off-by-one",
    description: "Retries one time too many: compares attempt <= maxAttempts.",
    file: "src/engine.ts",
    edits: [["if (attempt < maxAttempts) {", "if (attempt <= maxAttempts) {"]],
  },
  {
    id: "M02-uncapped-backoff",
    description: "Backoff ignores maxBackoffMs.",
    file: "src/engine.ts",
    edits: [
      [
        "const delay = Math.min(maxBackoffMs, Math.floor(baseBackoffMs * Math.pow(multiplier, attempt - 1)));",
        "const delay = Math.floor(baseBackoffMs * Math.pow(multiplier, attempt - 1));",
      ],
    ],
  },
  {
    id: "M03-rounded-backoff",
    description: "Backoff rounds instead of flooring fractional delays.",
    file: "src/engine.ts",
    edits: [
      [
        "Math.min(maxBackoffMs, Math.floor(baseBackoffMs * Math.pow(multiplier, attempt - 1)))",
        "Math.min(maxBackoffMs, Math.round(baseBackoffMs * Math.pow(multiplier, attempt - 1)))",
      ],
    ],
  },
  {
    id: "M04-ready-on-any-parent",
    description: "A dependent becomes ready when any (not all) parent succeeded.",
    file: "src/engine.ts",
    edits: [['t.dependsOn.every((d) => run.tasks[d].status === "succeeded"),', 't.dependsOn.some((d) => run.tasks[d].status === "succeeded"),']],
  },
  {
    id: "M05-expired-lease-accepted",
    description: "complete() accepts a lease that already expired.",
    file: "src/engine.ts",
    edits: [
      [
        '    if (lease.state === "failed") throw new ApiError(409, "lease_finalized", "lease already failed");\n    if (lease.state === "expired") throw new ApiError(410, "lease_expired", "lease expired");\n',
        '    if (lease.state === "failed") throw new ApiError(409, "lease_finalized", "lease already failed");\n',
      ],
    ],
  },
  {
    id: "M06-expiry-not-an-attempt",
    description: "An expired lease silently requeues the task instead of counting as a failed attempt.",
    file: "src/engine.ts",
    edits: [
      [
        '    this.attemptFailed(run, lease.task, lease.attempt, "lease_expired");',
        '    ts.status = "ready";\n    this.emit(run, "task.ready", lease.task, {});',
      ],
    ],
  },
  {
    id: "M07-shallow-skip",
    description: "Skip propagation stops at direct dependents.",
    file: "src/engine.ts",
    edits: [["          out.add(t.name);\n          stack.push(t.name);", "          out.add(t.name);"]],
  },
  {
    id: "M08-seq-not-persisted",
    description: "Event sequence numbers come from an in-memory counter that resets on restart.",
    file: "src/engine.ts",
    edits: [
      ["  private state: State;\n", "  private state: State;\n  private seqs: Record<string, number> = {};\n"],
      [
        "run.events.push({ seq: run.events.length + 1, at:",
        "run.events.push({ seq: (this.seqs[run.id] = (this.seqs[run.id] ?? 0) + 1), at:",
      ],
    ],
  },
  {
    id: "M09-idempotency-ignores-input",
    description: "Idempotent replay only compares the workflow, not the input.",
    file: "src/engine.ts",
    edits: [["if (prior.workflowId === workflowId && prior.canon === canon) {", "if (prior.workflowId === workflowId) {"]],
  },
  {
    id: "M10-lease-after-cancel",
    description: "Cancel leaves ready tasks untouched and lease selection does not exclude cancelled runs.",
    file: "src/engine.ts",
    edits: [
      ["      if (TERMINAL.has(ts.status)) continue;\n      ts.status = \"cancelled\";", "      if (TERMINAL.has(ts.status) || ts.status === \"ready\") continue;\n      ts.status = \"cancelled\";"],
      [
        '    for (const run of Object.values(this.state.runs)) {\n      if (run.status !== "running") continue;\n      const wf = this.state.workflows[run.workflowId];\n      for (const def of wf.tasks) {',
        '    for (const run of Object.values(this.state.runs)) {\n      if (run.status === "succeeded" || run.status === "failed") continue;\n      const wf = this.state.workflows[run.workflowId];\n      for (const def of wf.tasks) {',
      ],
    ],
  },
  {
    id: "M11-heartbeat-from-old-expiry",
    description: "Heartbeat extends from the previous expiry instead of from now.",
    file: "src/engine.ts",
    edits: [["lease.expiresAt = this.state.now + this.state.workflows", "lease.expiresAt = lease.expiresAt + this.state.workflows"]],
  },
  {
    id: "M12-due-boundary",
    description: "Time-based transitions only fire strictly after their due time.",
    file: "src/engine.ts",
    edits: [["if (t.due > target) return;", "if (t.due >= target) return;"]],
  },
  {
    id: "M13-heartbeat-not-durable",
    description: "Heartbeat updates memory but is never persisted.",
    file: "src/engine.ts",
    edits: [
      [
        "    lease.expiresAt = this.state.now + this.state.workflows[run.workflowId].leaseTimeoutMs;\n    this.commit();\n",
        "    lease.expiresAt = this.state.now + this.state.workflows[run.workflowId].leaseTimeoutMs;\n",
      ],
    ],
  },
  {
    id: "M14-clock-not-durable",
    description: "Advancing the clock is not persisted.",
    file: "src/engine.ts",
    edits: [["    this.processDue(this.state.now + body.ms);\n    this.commit();\n", "    this.processDue(this.state.now + body.ms);\n"]],
  },
  {
    id: "M15-ignores-run-age",
    description: "Priority ties are broken by task name only, ignoring run creation order.",
    file: "src/engine.ts",
    edits: [
      [
        "(run.seq < pick.run.seq || (run.seq === pick.run.seq && def.name < pick.def.name)))",
        "(def.name < pick.def.name || (def.name === pick.def.name && run.seq < pick.run.seq)))",
      ],
    ],
  },
  {
    id: "M16-events-at-advance-start",
    description: "Transitions during an advance are stamped with the start time, not their due time.",
    file: "src/engine.ts",
    edits: [["      if (t.due > this.state.now) this.state.now = t.due;\n", ""]],
  },
  {
    id: "M17-late-report-applies-output",
    description: "A late completion on a cancelled run stores its output on the task.",
    file: "src/engine.ts",
    edits: [
      [
        '    if (run.status === "cancelled") {\n      this.emit(run, "task.late_report", lease.task, {\n        attempt: lease.attempt,\n        leaseId: lease.id,\n        outcome: "succeeded",',
        '    if (run.status === "cancelled") {\n      ts.output = output;\n      this.emit(run, "task.late_report", lease.task, {\n        attempt: lease.attempt,\n        leaseId: lease.id,\n        outcome: "succeeded",',
      ],
    ],
  },
  {
    id: "M18-duplicate-complete-conflicts",
    description: "A repeated completion of the same lease is rejected instead of being idempotent.",
    file: "src/engine.ts",
    edits: [
      [
        '    if (lease.state === "completed") return { status: 200, body: lease.result };',
        '    if (lease.state === "completed") throw new ApiError(409, "lease_finalized", "lease already completed");',
      ],
    ],
  },
  {
    id: "M19-cycle-check-from-first-task",
    description: "Cycle detection only walks the graph from the first task.",
    file: "src/validate.ts",
    edits: [["  for (const t of tasks) visit(t.name);", "  visit(tasks[0].name);"]],
  },
  {
    id: "M20-key-order-sensitive-input",
    description: "Idempotent input comparison is sensitive to object key order.",
    file: "src/validate.ts",
    edits: [["  return JSON.stringify(norm(v));", "  return JSON.stringify(v);"]],
  },
];
