import { assert, brief, check, expectError } from "../lib/harness.mjs";

check("CAN-01", "cancellation", "cancel moves every non-terminal task to cancelled", async (c) => {
  await c.workflow({
    name: "w",
    retry: { baseBackoffMs: 100 },
    tasks: [
      { name: "a" },
      { name: "b", dependsOn: ["a"] },
      { name: "c", type: "slow" },
      { name: "d", dependsOn: ["c"] },
      { name: "e", type: "flaky" },
    ],
  });
  await c.run("wf_1", "k");
  await c.complete((await c.mustLease("w", ["default"])).leaseId, "A");
  assert.equal((await c.mustLease("w", ["slow"])).task, "c");
  const le = await c.mustLease("w", ["flaky"]);
  await c.fail(le.leaseId, "f");
  await c.advance(10);
  const n = (await c.events("run_1")).length;
  const r = await c.post("/runs/run_1/cancel");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "cancelled");
  assert.equal(r.body.finishedAt, 10);
  const st = Object.fromEntries(Object.entries(r.body.tasks).map(([k, v]) => [k, [v.status, v.nextAttemptAt]]));
  assert.deepEqual(st, {
    a: ["succeeded", null],
    b: ["cancelled", null],
    c: ["cancelled", null],
    d: ["cancelled", null],
    e: ["cancelled", null],
  });
  assert.deepEqual(r.body, await c.getRun("run_1"));
  assert.deepEqual(brief((await c.events("run_1")).slice(n)), [
    ["task.cancelled", "b", 10],
    ["task.cancelled", "c", 10],
    ["task.cancelled", "d", 10],
    ["task.cancelled", "e", 10],
    ["run.cancelled", null, 10],
  ]);
  // The in-flight attempt of c is still recorded as running.
  assert.equal(r.body.tasks.c.history[0].outcome, "running");
});

check("CAN-02", "cancellation", "cancelled runs hand out no leases", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a", priority: 1 }, { name: "b" }] });
  await c.run("wf_1", "k1");
  await c.run("wf_1", "k2");
  await c.post("/runs/run_1/cancel");
  const l = await c.mustLease("w");
  assert.deepEqual([l.runId, l.task], ["run_2", "a"]);
  assert.equal((await c.mustLease("w")).runId, "run_2");
  assert.equal(await c.lease("w"), null);
});

check("CAN-03", "cancellation", "retry timers of a cancelled run never fire", async (c) => {
  await c.workflow({ name: "w", retry: { baseBackoffMs: 100 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.fail((await c.mustLease("w")).leaseId, "x");
  await c.post("/runs/run_1/cancel");
  const n = (await c.events("run_1")).length;
  await c.advance(1000);
  assert.equal((await c.events("run_1")).length, n);
  const t = await c.task("run_1", "a");
  assert.deepEqual([t.status, t.nextAttemptAt], ["cancelled", null]);
  assert.equal(await c.lease("w"), null);
});

check("CAN-04", "cancellation", "late reports are recorded but do not change the outcome", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b" }, { name: "z", dependsOn: ["a"] }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.mustLease("w");
  await c.post("/runs/run_1/cancel");
  await c.advance(20);
  const n = (await c.events("run_1")).length;
  const lc = await c.post("/leases/lease_1/complete", { output: "late" });
  assert.equal(lc.status, 200);
  assert.deepEqual(lc.body, { leaseId: "lease_1", status: "completed", applied: false });
  const lf = await c.post("/leases/lease_2/fail", { error: "late-fail" });
  assert.equal(lf.status, 200);
  assert.deepEqual(lf.body, { leaseId: "lease_2", status: "failed", applied: false });
  const run = await c.getRun("run_1");
  assert.equal(run.status, "cancelled");
  assert.equal(run.finishedAt, 0);
  assert.deepEqual([run.tasks.a.status, run.tasks.a.output], ["cancelled", null]);
  assert.deepEqual(run.tasks.a.history[0], { attempt: 1, leaseId: "lease_1", workerId: "w", startedAt: 0, endedAt: 20, outcome: "succeeded" });
  assert.deepEqual([run.tasks.b.status, run.tasks.b.history[0].outcome, run.tasks.b.history[0].endedAt], ["cancelled", "failed", 20]);
  assert.equal(run.tasks.z.status, "cancelled");
  assert.deepEqual((await c.events("run_1")).slice(n), [
    { seq: n + 1, at: 20, type: "task.late_report", task: "a", data: { attempt: 1, leaseId: "lease_1", outcome: "succeeded" } },
    { seq: n + 2, at: 20, type: "task.late_report", task: "b", data: { attempt: 1, leaseId: "lease_2", outcome: "failed" } },
  ]);
  const dup = await c.post("/leases/lease_1/complete", { output: "again" });
  assert.deepEqual([dup.status, dup.body], [200, lc.body]);
  assert.equal((await c.events("run_1")).length, n + 2);
});

check("CAN-05", "cancellation", "active lease of a cancelled run: heartbeat refused, silent expiry", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 500, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.advance(100);
  await c.post("/runs/run_1/cancel");
  expectError(await c.post("/leases/lease_1/heartbeat"), 409, "run_cancelled");
  const n = (await c.events("run_1")).length;
  await c.advance(400);
  assert.equal((await c.events("run_1")).length, n);
  const t = await c.task("run_1", "a");
  assert.equal(t.status, "cancelled");
  assert.deepEqual([t.history[0].outcome, t.history[0].endedAt], ["expired", 500]);
  assert.equal(t.error, null);
  expectError(await c.post("/leases/lease_1/complete"), 410, "lease_expired");
});

check("CAN-06", "cancellation", "cancel on missing or finished runs", async (c) => {
  expectError(await c.post("/runs/run_1/cancel"), 404, "not_found");
  await c.workflow({ name: "w", retry: { maxAttempts: 1 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k1");
  await c.complete((await c.mustLease("w")).leaseId);
  expectError(await c.post("/runs/run_1/cancel"), 409, "run_finalized");
  await c.run("wf_1", "k2");
  await c.fail((await c.mustLease("w")).leaseId, "x");
  expectError(await c.post("/runs/run_2/cancel"), 409, "run_finalized");
  await c.run("wf_1", "k3");
  assert.equal((await c.post("/runs/run_3/cancel")).status, 200);
  expectError(await c.post("/runs/run_3/cancel"), 409, "run_finalized");
});
