import { assert, assertSeqs, check, expectError } from "../lib/harness.mjs";

// `c.restart()` sends SIGKILL to the whole server process group and starts it
// again on the same DATA_DIR.

check("REC-01", "recovery", "workflows, runs, events and clock survive a kill -9", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k", { day: 1 });
  await c.advance(5);
  await c.complete((await c.mustLease("w1")).leaseId, { rows: 9 });
  await c.mustLease("w2");
  await c.advance(50);
  const wf = (await c.get("/workflows/wf_1")).body;
  const run = await c.getRun("run_1");
  const ev = await c.events("run_1");
  await c.restart();
  assert.equal(await c.now(), 55);
  assert.deepEqual((await c.get("/workflows/wf_1")).body, wf);
  assert.deepEqual(await c.getRun("run_1"), run);
  assert.deepEqual(await c.events("run_1"), ev);
});

check("REC-02", "recovery", "id counters continue after restart", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b" }] });
  await c.run("wf_1", "k1");
  await c.mustLease("w");
  await c.restart();
  assert.equal((await c.workflow({ name: "w2", tasks: [{ name: "a" }] })).id, "wf_2");
  assert.equal((await c.run("wf_2", "k2")).id, "run_2");
  assert.equal((await c.mustLease("w")).leaseId, "lease_2");
  expectError(await c.post("/workflows", { name: "w", tasks: [{ name: "a" }] }), 409, "workflow_exists");
});

check("REC-03", "recovery", "event sequence continues without gaps after restart", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.restart();
  await c.complete("lease_1");
  await c.restart();
  await c.complete((await c.mustLease("w")).leaseId);
  const ev = await c.events("run_1");
  assertSeqs(ev);
  assert.deepEqual(ev.map((e) => e.type), [
    "run.created",
    "task.ready",
    "task.leased",
    "task.succeeded",
    "task.ready",
    "task.leased",
    "task.succeeded",
    "run.succeeded",
  ]);
});

check("REC-04", "recovery", "active leases keep their expiry across a restart", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 1000, tasks: [{ name: "a" }, { name: "b" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.mustLease("w");
  await c.advance(400);
  await c.restart();
  assert.equal(await c.now(), 400);
  assert.deepEqual(await c.complete("lease_2", "B"), { leaseId: "lease_2", status: "completed", applied: true });
  await c.advance(599);
  assert.equal((await c.task("run_1", "a")).status, "leased");
  await c.advance(1);
  const a = await c.task("run_1", "a");
  assert.deepEqual([a.status, a.history[0].outcome, a.history[0].endedAt], ["waiting_retry", "expired", 1000]);
});

check("REC-05", "recovery", "heartbeat extension is durable", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 1000, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.advance(900);
  assert.equal((await c.post("/leases/lease_1/heartbeat")).body.expiresAt, 1900);
  await c.restart();
  await c.advance(999);
  assert.equal((await c.task("run_1", "a")).status, "leased");
  await c.advance(1);
  assert.equal((await c.task("run_1", "a")).history[0].endedAt, 1900);
});

check("REC-06", "recovery", "idempotency keys still deduplicate after restart", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  await c.run("wf_1", "k1", { x: [1, 2] });
  await c.restart();
  const same = await c.post("/workflows/wf_1/runs", { input: { x: [1, 2] } }, { headers: { "Idempotency-Key": "k1" } });
  assert.deepEqual([same.status, same.body.id], [200, "run_1"]);
  expectError(
    await c.post("/workflows/wf_1/runs", { input: { x: [2, 1] } }, { headers: { "Idempotency-Key": "k1" } }),
    409,
    "idempotency_conflict",
  );
  assert.equal((await c.run("wf_1", "k2")).id, "run_2");
});

check("REC-07", "recovery", "waiting retries survive a restart and wake on time", async (c) => {
  await c.workflow({ name: "w", retry: { baseBackoffMs: 1000 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.fail((await c.mustLease("w")).leaseId, "x");
  await c.restart();
  const t = await c.task("run_1", "a");
  assert.deepEqual([t.status, t.attempts, t.nextAttemptAt, t.error], ["waiting_retry", 1, 1000, "x"]);
  await c.advance(999);
  assert.equal(await c.lease("w"), null);
  await c.advance(1);
  const l = await c.mustLease("w");
  assert.deepEqual([l.attempt, l.leaseId], [2, "lease_2"]);
});

check("REC-08", "recovery", "completed work is not redone after a restart", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b" }] });
  await c.run("wf_1", "k");
  const first = await c.complete((await c.mustLease("w")).leaseId, "A");
  await c.restart();
  const n = (await c.events("run_1")).length;
  const dup = await c.post("/leases/lease_1/complete", { output: "A2" });
  assert.deepEqual([dup.status, dup.body], [200, first]);
  assert.equal((await c.events("run_1")).length, n);
  assert.equal((await c.mustLease("w")).task, "b");
  assert.equal(await c.lease("w"), null);
  const a = await c.task("run_1", "a");
  assert.deepEqual([a.status, a.attempts, a.output], ["succeeded", 1, "A"]);
});

check("REC-09", "recovery", "cancellation is durable", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.post("/runs/run_1/cancel");
  await c.restart();
  assert.equal((await c.getRun("run_1")).status, "cancelled");
  assert.equal(await c.lease("w"), null);
  const r = await c.post("/leases/lease_1/complete", { output: 1 });
  assert.deepEqual([r.status, r.body.applied], [200, false]);
});

check("REC-10", "recovery", "end-to-end run with a crash after every step", async (c) => {
  const step = async (fn) => {
    const v = await fn();
    await c.restart();
    return v;
  };
  await step(() =>
    c.workflow({
      name: "w",
      leaseTimeoutMs: 500,
      retry: { maxAttempts: 2, baseBackoffMs: 100 },
      tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }, { name: "c", dependsOn: ["a"] }, { name: "d", dependsOn: ["b", "c"] }],
    }),
  );
  await step(() => c.run("wf_1", "k", { job: 1 }));
  await step(() => c.mustLease("w1"));
  await step(() => c.advance(50));
  await step(() => c.complete("lease_1", "A"));
  await step(() => c.mustLease("w2"));
  await step(() => c.mustLease("w3"));
  await step(() => c.fail("lease_2", "oops"));
  await step(() => c.advance(100));
  await step(() => c.complete("lease_3", "C"));
  const l4 = await step(() => c.mustLease("w4"));
  assert.deepEqual([l4.task, l4.attempt, l4.expiresAt], ["b", 2, 650]);
  await step(() => c.advance(600));
  const L = (attempt, leaseId, workerId) => ({ attempt, leaseId, workerId });
  const E = (seq, at, type, task, data = {}) => ({ seq, at, type, task, data });
  assert.deepEqual(await c.events("run_1"), [
    E(1, 0, "run.created", null),
    E(2, 0, "task.ready", "a"),
    E(3, 0, "task.leased", "a", L(1, "lease_1", "w1")),
    E(4, 50, "task.succeeded", "a", { attempt: 1 }),
    E(5, 50, "task.ready", "b"),
    E(6, 50, "task.ready", "c"),
    E(7, 50, "task.leased", "b", L(1, "lease_2", "w2")),
    E(8, 50, "task.leased", "c", L(1, "lease_3", "w3")),
    E(9, 50, "task.attempt_failed", "b", { attempt: 1, error: "oops", retryAt: 150 }),
    E(10, 150, "task.ready", "b"),
    E(11, 150, "task.succeeded", "c", { attempt: 1 }),
    E(12, 150, "task.leased", "b", L(2, "lease_4", "w4")),
    E(13, 650, "task.lease_expired", "b", { attempt: 2, leaseId: "lease_4" }),
    E(14, 650, "task.failed", "b", { attempt: 2, error: "lease_expired" }),
    E(15, 650, "task.skipped", "d"),
    E(16, 650, "run.failed", null),
  ]);
  const run = await c.getRun("run_1");
  assert.deepEqual([run.status, run.finishedAt], ["failed", 650]);
  assert.equal(await c.now(), 750);
});

check("REC-11", "recovery", "state from the very last response is durable", async (c) => {
  await c.advance(1234);
  await c.restart();
  assert.equal(await c.now(), 1234);
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  await c.restart();
  assert.equal((await c.get("/workflows/wf_1")).status, 200);
  await c.run("wf_1", "k");
  await c.restart();
  await c.restart();
  assert.equal((await c.getRun("run_1")).status, "running");
  assert.equal((await c.mustLease("w")).leaseId, "lease_1");
});
