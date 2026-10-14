import { assert, brief, check, expectError } from "../lib/harness.mjs";

check("SCH-01", "scheduling", "new run: ready/blocked tasks and initial events", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "c" }, { name: "b", dependsOn: ["a"] }, { name: "a" }] });
  const run = await c.run("wf_1", "k1", { day: "2026-10-01" });
  const fresh = { attempts: 0, nextAttemptAt: null, output: null, error: null, history: [] };
  assert.deepEqual(run, {
    id: "run_1",
    workflowId: "wf_1",
    status: "running",
    input: { day: "2026-10-01" },
    createdAt: 0,
    finishedAt: null,
    tasks: {
      a: { status: "ready", ...fresh },
      b: { status: "blocked", ...fresh },
      c: { status: "ready", ...fresh },
    },
  });
  assert.deepEqual(await c.getRun("run_1"), run);
  assert.deepEqual(await c.events("run_1"), [
    { seq: 1, at: 0, type: "run.created", task: null, data: {} },
    { seq: 2, at: 0, type: "task.ready", task: "a", data: {} },
    { seq: 3, at: 0, type: "task.ready", task: "c", data: {} },
  ]);
});

check("SCH-02", "scheduling", "lease returns 204 when nothing is ready", async (c) => {
  const r = await c.post("/leases", { workerId: "w1" });
  assert.equal(r.status, 204);
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k");
  await c.mustLease("w1");
  assert.equal((await c.post("/leases", { workerId: "w1" })).status, 204);
});

check("SCH-03", "scheduling", "lease order: priority, then run age, then task name", async (c) => {
  await c.workflow({ name: "low", tasks: [{ name: "y" }, { name: "x" }, { name: "a", priority: -1 }] });
  await c.workflow({ name: "high", tasks: [{ name: "b" }, { name: "h", priority: 10 }] });
  await c.run("wf_1", "k1");
  await c.run("wf_2", "k2");
  const got = [];
  for (let i = 0; i < 5; i++) {
    const l = await c.mustLease("w1");
    got.push([l.runId, l.task, l.leaseId]);
  }
  assert.deepEqual(got, [
    ["run_2", "h", "lease_1"],
    ["run_1", "x", "lease_2"],
    ["run_1", "y", "lease_3"],
    ["run_2", "b", "lease_4"],
    ["run_1", "a", "lease_5"],
  ]);
  assert.equal(await c.lease("w1"), null);
});

check("SCH-04", "scheduling", "lease payload, parent outputs and chain progression", async (c) => {
  await c.workflow({ name: "w", leaseTimeoutMs: 5000, tasks: [{ name: "a", type: "io" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k", { n: 7 });
  await c.advance(100);
  const la = await c.mustLease("w1");
  assert.deepEqual(la, {
    leaseId: "lease_1",
    runId: "run_1",
    workflowId: "wf_1",
    task: "a",
    type: "io",
    attempt: 1,
    expiresAt: 5100,
    input: { n: 7 },
    parentOutputs: {},
  });
  assert.equal(await c.lease("w2"), null);
  assert.deepEqual(await c.complete("lease_1", { rows: 3 }), { leaseId: "lease_1", status: "completed", applied: true });
  const lb = await c.mustLease("w2");
  assert.equal(lb.task, "b");
  assert.deepEqual(lb.parentOutputs, { a: { rows: 3 } });
});

check("SCH-05", "scheduling", "diamond: join task waits for all parents", async (c) => {
  await c.workflow({
    name: "w",
    tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }, { name: "c", dependsOn: ["a"] }, { name: "d", dependsOn: ["b", "c"] }],
  });
  await c.run("wf_1", "k");
  await c.complete((await c.mustLease("w")).leaseId, 1);
  const lb = await c.mustLease("w");
  const lc = await c.mustLease("w");
  assert.deepEqual([lb.task, lc.task], ["b", "c"]);
  await c.complete(lb.leaseId, "B");
  assert.equal((await c.task("run_1", "d")).status, "blocked");
  assert.equal(await c.lease("w"), null);
  const before = (await c.events("run_1")).length;
  await c.complete(lc.leaseId, "C");
  assert.deepEqual(brief((await c.events("run_1")).slice(before)), [
    ["task.succeeded", "c", 0],
    ["task.ready", "d", 0],
  ]);
  const ld = await c.mustLease("w");
  assert.deepEqual(ld.parentOutputs, { b: "B", c: "C" });
});

check("SCH-06", "scheduling", "type filter and lease request validation", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "io1", type: "io" }, { name: "cpu1", type: "cpu", priority: 10 }] });
  await c.run("wf_1", "k");
  assert.equal((await c.mustLease("w", ["io"])).task, "io1");
  assert.equal(await c.lease("w", ["gpu"]), null);
  assert.equal((await c.mustLease("w", ["gpu", "cpu"])).task, "cpu1");
  expectError(await c.post("/leases", { workerId: "w", types: [] }), 400, "invalid_request");
  expectError(await c.post("/leases", { workerId: "w", types: ["", "x"] }), 400, "invalid_request");
  expectError(await c.post("/leases", { workerId: "" }), 400, "invalid_request");
  expectError(await c.post("/leases", {}), 400, "invalid_request");
  expectError(await c.post("/leases"), 400, "invalid_request");
});

check("SCH-07", "scheduling", "complete event log for a successful run", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k");
  await c.advance(10);
  await c.mustLease("w1");
  await c.advance(5);
  await c.complete("lease_1");
  await c.advance(5);
  await c.mustLease("w2");
  await c.complete("lease_2", "done");
  const run = await c.getRun("run_1");
  assert.equal(run.status, "succeeded");
  assert.equal(run.finishedAt, 20);
  assert.deepEqual(await c.events("run_1"), [
    { seq: 1, at: 0, type: "run.created", task: null, data: {} },
    { seq: 2, at: 0, type: "task.ready", task: "a", data: {} },
    { seq: 3, at: 10, type: "task.leased", task: "a", data: { attempt: 1, leaseId: "lease_1", workerId: "w1" } },
    { seq: 4, at: 15, type: "task.succeeded", task: "a", data: { attempt: 1 } },
    { seq: 5, at: 15, type: "task.ready", task: "b", data: {} },
    { seq: 6, at: 20, type: "task.leased", task: "b", data: { attempt: 1, leaseId: "lease_2", workerId: "w2" } },
    { seq: 7, at: 20, type: "task.succeeded", task: "b", data: { attempt: 1 } },
    { seq: 8, at: 20, type: "run.succeeded", task: null, data: {} },
  ]);
});

check("SCH-08", "scheduling", "task output and attempt history", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w9");
  assert.deepEqual(await c.task("run_1", "a"), {
    status: "leased",
    attempts: 1,
    nextAttemptAt: null,
    output: null,
    error: null,
    history: [{ attempt: 1, leaseId: "lease_1", workerId: "w9", startedAt: 0, endedAt: null, outcome: "running" }],
  });
  await c.advance(7);
  await c.complete("lease_1", { k: [1, 2] });
  assert.deepEqual(await c.task("run_1", "a"), {
    status: "succeeded",
    attempts: 1,
    nextAttemptAt: null,
    output: { k: [1, 2] },
    error: null,
    history: [{ attempt: 1, leaseId: "lease_1", workerId: "w9", startedAt: 0, endedAt: 7, outcome: "succeeded" }],
  });
  await c.mustLease("w");
  await c.complete("lease_2", false);
  assert.equal((await c.task("run_1", "b")).output, false);
  await c.mustLease("w");
  await c.complete("lease_3");
  assert.equal((await c.task("run_1", "c")).output, null);
});

check("SCH-09", "scheduling", "event paging with after; run/event lookup errors", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  const tail = await c.events("run_1", 2);
  assert.deepEqual(tail.map((e) => e.seq), [3, 4]);
  assert.deepEqual(await c.events("run_1", 4), []);
  assert.deepEqual(await c.events("run_1", 99), []);
  expectError(await c.get("/runs/run_1/events?after=abc"), 400, "invalid_request");
  expectError(await c.get("/runs/run_1/events?after=-1"), 400, "invalid_request");
  expectError(await c.get("/runs/run_9/events"), 404, "not_found");
  expectError(await c.get("/runs/run_9"), 404, "not_found");
});

check("SCH-10", "scheduling", "concurrent lease requests never share a task", async (c) => {
  await c.workflow({ name: "w", tasks: ["t1", "t2", "t3", "t4", "t5"].map((name) => ({ name })) });
  await c.run("wf_1", "k");
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => c.post("/leases", { workerId: `w${i}` })));
  const ok = results.filter((r) => r.status === 200).map((r) => r.body);
  assert.equal(ok.length, 5);
  assert.equal(results.filter((r) => r.status === 204).length, 15);
  assert.deepEqual(ok.map((l) => l.task).sort(), ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(ok.map((l) => l.leaseId).sort(), ["lease_1", "lease_2", "lease_3", "lease_4", "lease_5"]);
  const run = await c.getRun("run_1");
  for (const t of Object.values(run.tasks)) assert.equal(t.attempts, 1);
  const leasedEvents = (await c.events("run_1")).filter((e) => e.type === "task.leased");
  assert.equal(leasedEvents.length, 5);
});

check("SCH-11", "scheduling", "independent branch keeps running after another branch fails", async (c) => {
  await c.workflow({
    name: "w",
    retry: { maxAttempts: 1 },
    tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }, { name: "c" }, { name: "d", dependsOn: ["c"] }],
  });
  await c.run("wf_1", "k");
  const la = await c.mustLease("w");
  assert.equal(la.task, "a");
  const before = (await c.events("run_1")).length;
  await c.fail(la.leaseId, "bad");
  assert.deepEqual(brief((await c.events("run_1")).slice(before)), [
    ["task.failed", "a", 0],
    ["task.skipped", "b", 0],
  ]);
  let run = await c.getRun("run_1");
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, null);
  await c.advance(3);
  await c.complete((await c.mustLease("w")).leaseId);
  const ld = await c.mustLease("w");
  assert.equal(ld.task, "d");
  await c.complete(ld.leaseId);
  run = await c.getRun("run_1");
  assert.equal(run.status, "failed");
  assert.equal(run.finishedAt, 3);
  const ev = await c.events("run_1");
  assert.deepEqual(brief(ev.slice(-2)), [
    ["task.succeeded", "d", 3],
    ["run.failed", null, 3],
  ]);
});

check("SCH-12", "scheduling", "failure skips transitive dependents; join never becomes ready", async (c) => {
  await c.workflow({
    name: "w",
    retry: { maxAttempts: 1 },
    tasks: [{ name: "a" }, { name: "b" }, { name: "c", dependsOn: ["a", "b"] }, { name: "e", dependsOn: ["c"] }],
  });
  await c.run("wf_1", "k");
  const la = await c.mustLease("w");
  const lb = await c.mustLease("w");
  assert.deepEqual([la.task, lb.task], ["a", "b"]);
  const n = (await c.events("run_1")).length;
  await c.fail(la.leaseId, "x");
  assert.deepEqual(brief((await c.events("run_1")).slice(n)), [
    ["task.failed", "a", 0],
    ["task.skipped", "c", 0],
    ["task.skipped", "e", 0],
  ]);
  await c.complete(lb.leaseId);
  const run = await c.getRun("run_1");
  assert.equal(run.tasks.c.status, "skipped");
  assert.equal(run.tasks.e.status, "skipped");
  assert.equal(run.status, "failed");
  assert.equal(await c.lease("w"), null);
});
