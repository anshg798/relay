import { assert, brief, check, expectError } from "../lib/harness.mjs";

check("LEA-01", "leases", "lease expires exactly at expiresAt and counts as an attempt", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 1000, retry: { baseBackoffMs: 200 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  assert.equal((await c.mustLease("w")).expiresAt, 1000);
  await c.advance(999);
  assert.equal((await c.task("run_1", "a")).status, "leased");
  const n = (await c.events("run_1")).length;
  await c.advance(1);
  assert.deepEqual(await c.task("run_1", "a"), {
    status: "waiting_retry",
    attempts: 1,
    nextAttemptAt: 1200,
    output: null,
    error: "lease_expired",
    history: [{ attempt: 1, leaseId: "lease_1", workerId: "w", startedAt: 0, endedAt: 1000, outcome: "expired" }],
  });
  assert.deepEqual((await c.events("run_1")).slice(n), [
    { seq: n + 1, at: 1000, type: "task.lease_expired", task: "a", data: { attempt: 1, leaseId: "lease_1" } },
    { seq: n + 2, at: 1000, type: "task.attempt_failed", task: "a", data: { attempt: 1, error: "lease_expired", retryAt: 1200 } },
  ]);
});

check("LEA-02", "leases", "reports on an expired lease are rejected with 410 and change nothing", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 100, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.advance(100);
  const before = await c.getRun("run_1");
  const nEv = (await c.events("run_1")).length;
  expectError(await c.post("/leases/lease_1/complete", { output: 1 }), 410, "lease_expired");
  expectError(await c.post("/leases/lease_1/fail", { error: "x" }), 410, "lease_expired");
  expectError(await c.post("/leases/lease_1/heartbeat"), 410, "lease_expired");
  assert.deepEqual(await c.getRun("run_1"), before);
  assert.equal((await c.events("run_1")).length, nEv);
});

check("LEA-03", "leases", "heartbeat extends the lease from the current time", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 1000, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.advance(600);
  const hb = await c.post("/leases/lease_1/heartbeat");
  assert.equal(hb.status, 200);
  assert.deepEqual(hb.body, { leaseId: "lease_1", expiresAt: 1600 });
  await c.advance(999);
  assert.equal((await c.task("run_1", "a")).status, "leased");
  await c.advance(1);
  const t = await c.task("run_1", "a");
  assert.equal(t.status, "waiting_retry");
  assert.equal(t.history[0].endedAt, 1600);
  const ev = await c.events("run_1");
  assert.deepEqual(brief(ev.slice(-2)), [
    ["task.lease_expired", "a", 1600],
    ["task.attempt_failed", "a", 1600],
  ]);
});

check("LEA-04", "leases", "expiry on the final attempt fails the task and the run", async (c) => {
  await c.workflow({
    name: "w",
    leaseTimeoutMs: 100,
    retry: { maxAttempts: 2, baseBackoffMs: 0, maxBackoffMs: 0 },
    tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }],
  });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  let n = (await c.events("run_1")).length;
  await c.advance(100);
  assert.deepEqual(brief((await c.events("run_1")).slice(n)), [
    ["task.lease_expired", "a", 100],
    ["task.attempt_failed", "a", 100],
    ["task.ready", "a", 100],
  ]);
  const l2 = await c.mustLease("w");
  assert.deepEqual([l2.attempt, l2.expiresAt], [2, 200]);
  n = (await c.events("run_1")).length;
  await c.advance(150);
  const ev = (await c.events("run_1")).slice(n);
  assert.deepEqual(ev, [
    { seq: n + 1, at: 200, type: "task.lease_expired", task: "a", data: { attempt: 2, leaseId: "lease_2" } },
    { seq: n + 2, at: 200, type: "task.failed", task: "a", data: { attempt: 2, error: "lease_expired" } },
    { seq: n + 3, at: 200, type: "task.skipped", task: "b", data: {} },
    { seq: n + 4, at: 200, type: "run.failed", task: null, data: {} },
  ]);
  const run = await c.getRun("run_1");
  assert.deepEqual([run.status, run.finishedAt, run.tasks.a.status, run.tasks.b.status], ["failed", 200, "failed", "skipped"]);
  assert.equal(await c.now(), 250);
});

check("LEA-05", "leases", "old lease is rejected after the task is re-leased", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 100, retry: { baseBackoffMs: 0, maxBackoffMs: 0 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w1");
  await c.advance(100);
  const l2 = await c.mustLease("w2");
  assert.equal(l2.leaseId, "lease_2");
  expectError(await c.post("/leases/lease_1/complete", { output: "stale" }), 410, "lease_expired");
  assert.deepEqual(await c.complete("lease_2", "fresh"), { leaseId: "lease_2", status: "completed", applied: true });
  const t = await c.task("run_1", "a");
  assert.deepEqual([t.status, t.attempts, t.output], ["succeeded", 2, "fresh"]);
});

check("LEA-06", "leases", "duplicate completion is idempotent; later fail/heartbeat conflict", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  const first = await c.complete("lease_1", { v: 1 });
  const n = (await c.events("run_1")).length;
  await c.advance(5);
  const again = await c.post("/leases/lease_1/complete", { output: { v: 2 } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first);
  assert.deepEqual((await c.task("run_1", "a")).output, { v: 1 });
  assert.equal((await c.events("run_1")).length, n);
  expectError(await c.post("/leases/lease_1/fail", { error: "late" }), 409, "lease_finalized");
  expectError(await c.post("/leases/lease_1/heartbeat"), 409, "lease_finalized");
  assert.equal((await c.task("run_1", "b")).status, "ready");
});

check("LEA-07", "leases", "duplicate failure is idempotent and consumes no extra attempt", async (c) => {
  await c.workflow({ name: "w", retry: { maxAttempts: 2 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  const first = await c.fail("lease_1", "e");
  const snapshot = await c.getRun("run_1");
  const n = (await c.events("run_1")).length;
  const again = await c.post("/leases/lease_1/fail", { error: "e2" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first);
  assert.deepEqual(await c.getRun("run_1"), snapshot);
  assert.equal((await c.events("run_1")).length, n);
  assert.equal(snapshot.tasks.a.status, "waiting_retry");
  expectError(await c.post("/leases/lease_1/complete"), 409, "lease_finalized");
  expectError(await c.post("/leases/lease_1/heartbeat"), 409, "lease_finalized");
});

check("LEA-08", "leases", "lease endpoint errors and precedence", async (c) => {
  for (const op of ["heartbeat", "complete"]) expectError(await c.post(`/leases/lease_9/${op}`), 404, "not_found");
  expectError(await c.post("/leases/lease_9/fail", { error: "x" }), 404, "not_found");
  expectError(await c.post("/leases/lease_9/fail", {}), 404, "not_found");
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  expectError(await c.post("/leases/lease_1/fail", {}), 400, "invalid_request");
  expectError(await c.post("/leases/lease_1/fail", { error: "" }), 400, "invalid_request");
  expectError(await c.post("/leases/lease_1/fail", { error: 5 }), 400, "invalid_request");
  expectError(await c.post("/leases/lease_1/complete", [1]), 400, "invalid_request");
  assert.equal((await c.task("run_1", "a")).status, "leased");
});

check("LEA-09", "leases", "one advance processes several transitions at their own due times", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 1000, retry: { baseBackoffMs: 500 }, tasks: [{ name: "a" }, { name: "b" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.advance(300);
  await c.mustLease("w");
  const n = (await c.events("run_1")).length;
  assert.equal(await c.advance(10000), 10300);
  assert.deepEqual(
    (await c.events("run_1")).slice(n).map((e) => [e.type, e.task, e.at, e.data.retryAt ?? null]),
    [
      ["task.lease_expired", "a", 1000, null],
      ["task.attempt_failed", "a", 1000, 1500],
      ["task.lease_expired", "b", 1300, null],
      ["task.attempt_failed", "b", 1300, 1800],
      ["task.ready", "a", 1500, null],
      ["task.ready", "b", 1800, null],
    ],
  );
  assert.equal(await c.now(), 10300);
});

check("LEA-10", "leases", "clock endpoints and advance validation", async (c) => {
  assert.equal(await c.now(), 0);
  assert.equal(await c.advance(0), 0);
  for (const body of [{ ms: -1 }, { ms: 1.5 }, { ms: "10" }, {}, [5]]) {
    expectError(await c.post("/_test/clock/advance", body), 400, "invalid_request");
  }
  expectError(await c.post("/_test/clock/advance"), 400, "invalid_request");
  assert.equal(await c.advance(250), 250);
  assert.equal(await c.now(), 250);
  const w = await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  assert.equal(w.createdAt, 250);
});

check("LEA-11", "leases", "transitions created during an advance join the same ordering", async (c) => {
  await c.workflow({
    name: "w",
    leaseTimeoutMs: 100,
    retry: { baseBackoffMs: 0, maxBackoffMs: 0 },
    tasks: [{ name: "a" }, { name: "b" }],
  });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.mustLease("w");
  const n = (await c.events("run_1")).length;
  await c.advance(100);
  assert.deepEqual(brief((await c.events("run_1")).slice(n)), [
    ["task.lease_expired", "a", 100],
    ["task.attempt_failed", "a", 100],
    ["task.ready", "a", 100],
    ["task.lease_expired", "b", 100],
    ["task.attempt_failed", "b", 100],
    ["task.ready", "b", 100],
  ]);
});
