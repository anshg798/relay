import { assert, brief, check } from "../lib/harness.mjs";

async function delays(c, retry, n) {
  await c.workflow({ name: "w", retry, leaseTimeoutMs: 86400000, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  const out = [];
  for (let i = 0; i < n; i++) {
    const l = await c.mustLease("w");
    assert.equal(l.attempt, i + 1);
    await c.fail(l.leaseId, `e${i + 1}`);
    const now = await c.now();
    const t = await c.task("run_1", "a");
    assert.equal(t.status, "waiting_retry");
    const d = t.nextAttemptAt - now;
    out.push(d);
    await c.advance(d);
  }
  return out;
}

check("RET-01", "retries", "failed attempt waits exactly the backoff before becoming ready", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.advance(500);
  assert.deepEqual(await c.fail("lease_1", "disk full"), { leaseId: "lease_1", status: "failed", applied: true });
  assert.deepEqual(await c.task("run_1", "a"), {
    status: "waiting_retry",
    attempts: 1,
    nextAttemptAt: 1500,
    output: null,
    error: "disk full",
    history: [{ attempt: 1, leaseId: "lease_1", workerId: "w", startedAt: 0, endedAt: 500, outcome: "failed" }],
  });
  const ev = await c.events("run_1");
  assert.deepEqual(ev[ev.length - 1], {
    seq: 4,
    at: 500,
    type: "task.attempt_failed",
    task: "a",
    data: { attempt: 1, error: "disk full", retryAt: 1500 },
  });
  assert.equal(await c.lease("w"), null);
  await c.advance(999);
  assert.equal(await c.lease("w"), null);
  await c.advance(1);
  const t = await c.task("run_1", "a");
  assert.equal(t.status, "ready");
  assert.equal(t.nextAttemptAt, null);
  const l2 = await c.mustLease("w");
  assert.equal(l2.attempt, 2);
  assert.deepEqual((await c.events("run_1")).slice(4, 6).map((e) => [e.type, e.at]), [
    ["task.ready", 1500],
    ["task.leased", 1500],
  ]);
});

check("RET-02", "retries", "exponential backoff", async (c) => {
  assert.deepEqual(await delays(c, { maxAttempts: 4, baseBackoffMs: 1000, multiplier: 2 }, 3), [1000, 2000, 4000]);
});

check("RET-03", "retries", "backoff is capped at maxBackoffMs", async (c) => {
  assert.deepEqual(
    await delays(c, { maxAttempts: 5, baseBackoffMs: 1000, multiplier: 3, maxBackoffMs: 5000 }, 4),
    [1000, 3000, 5000, 5000],
  );
});

check("RET-04", "retries", "fractional multiplier delays are floored", async (c) => {
  assert.deepEqual(await delays(c, { maxAttempts: 5, baseBackoffMs: 333, multiplier: 1.5 }, 4), [333, 499, 749, 1123]);
});

check("RET-05", "retries", "exhausted attempts fail the task and skip descendants", async (c) => {
  await c.workflow({
    name: "w",
    retry: { maxAttempts: 2, baseBackoffMs: 100 },
    tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }, { name: "c", dependsOn: ["b"] }, { name: "x" }],
  });
  await c.run("wf_1", "k");
  assert.equal((await c.mustLease("w")).task, "a");
  await c.fail("lease_1", "first");
  await c.advance(100);
  const l2 = await c.mustLease("w");
  assert.deepEqual([l2.task, l2.attempt], ["a", 2]);
  const n = (await c.events("run_1")).length;
  await c.fail(l2.leaseId, "second");
  const ev = (await c.events("run_1")).slice(n);
  assert.deepEqual(ev, [
    { seq: n + 1, at: 100, type: "task.failed", task: "a", data: { attempt: 2, error: "second" } },
    { seq: n + 2, at: 100, type: "task.skipped", task: "b", data: {} },
    { seq: n + 3, at: 100, type: "task.skipped", task: "c", data: {} },
  ]);
  const a = await c.task("run_1", "a");
  assert.deepEqual([a.status, a.attempts, a.nextAttemptAt, a.error], ["failed", 2, null, "second"]);
  assert.equal((await c.getRun("run_1")).status, "running");
  const lx = await c.mustLease("w");
  assert.equal(lx.task, "x");
  await c.complete(lx.leaseId);
  const run = await c.getRun("run_1");
  assert.equal(run.status, "failed");
  assert.equal(run.finishedAt, 100);
});

check("RET-06", "retries", "zero backoff makes the task ready within the same request", async (c) => {
  await c.workflow({ name: "w", retry: { baseBackoffMs: 0, maxBackoffMs: 0 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.advance(42);
  await c.mustLease("w");
  await c.fail("lease_1", "flaky");
  const t = await c.task("run_1", "a");
  assert.equal(t.status, "ready");
  assert.equal(t.nextAttemptAt, null);
  assert.deepEqual((await c.events("run_1")).slice(3), [
    { seq: 4, at: 42, type: "task.attempt_failed", task: "a", data: { attempt: 1, error: "flaky", retryAt: 42 } },
    { seq: 5, at: 42, type: "task.ready", task: "a", data: {} },
  ]);
  assert.equal((await c.mustLease("w")).attempt, 2);
});

check("RET-07", "retries", "maxAttempts 1 fails on the first failure", async (c) => {
  await c.workflow({ name: "w", retry: { maxAttempts: 1 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w");
  await c.fail("lease_1", "nope");
  const run = await c.getRun("run_1");
  assert.equal(run.status, "failed");
  assert.equal(run.tasks.a.status, "failed");
  assert.deepEqual(brief((await c.events("run_1")).slice(3)), [
    ["task.failed", "a", 0],
    ["run.failed", null, 0],
  ]);
});

check("RET-08", "retries", "error and history across a failure followed by success", async (c) => {
  await c.workflow({ name: "w", retry: { baseBackoffMs: 10 }, tasks: [{ name: "a" }] });
  await c.run("wf_1", "k");
  await c.mustLease("w1");
  await c.fail("lease_1", "e1");
  await c.advance(10);
  await c.mustLease("w2");
  await c.advance(5);
  await c.complete("lease_2", "ok");
  assert.deepEqual(await c.task("run_1", "a"), {
    status: "succeeded",
    attempts: 2,
    nextAttemptAt: null,
    output: "ok",
    error: "e1",
    history: [
      { attempt: 1, leaseId: "lease_1", workerId: "w1", startedAt: 0, endedAt: 0, outcome: "failed" },
      { attempt: 2, leaseId: "lease_2", workerId: "w2", startedAt: 10, endedAt: 15, outcome: "succeeded" },
    ],
  });
});

check("RET-09", "retries", "retry wake-ups happen at their due times in name order", async (c) => {
  await c.workflow({ name: "w", retry: { baseBackoffMs: 100 }, tasks: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  await c.run("wf_1", "k");
  const la = await c.mustLease("w");
  const lb = await c.mustLease("w");
  await c.fail(lb.leaseId, "b1");
  await c.fail(la.leaseId, "a1");
  await c.advance(50);
  const lc = await c.mustLease("w");
  await c.fail(lc.leaseId, "c1"); // retry at 150
  const n = (await c.events("run_1")).length;
  assert.equal(await c.advance(5000), 5050);
  assert.deepEqual(brief((await c.events("run_1")).slice(n)), [
    ["task.ready", "a", 100],
    ["task.ready", "b", 100],
    ["task.ready", "c", 150],
  ]);
});
