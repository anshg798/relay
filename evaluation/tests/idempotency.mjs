import { assert, check, expectError } from "../lib/harness.mjs";

const start = (c, wf, key, body) =>
  c.post(`/workflows/${wf}/runs`, body, { headers: key === undefined ? {} : { "Idempotency-Key": key } });

check("IDM-01", "idempotency", "missing or blank Idempotency-Key is rejected; nothing created", async (c) => {
  expectError(await start(c, "wf_1", undefined), 404, "not_found");
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  expectError(await start(c, "wf_1", undefined, { input: 1 }), 400, "missing_idempotency_key");
  expectError(await start(c, "wf_1", "   ", { input: 1 }), 400, "missing_idempotency_key");
  expectError(await start(c, "wf_1", "k", [1]), 400, "invalid_request");
  const r = await start(c, "wf_1", "k", { input: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, "run_1");
});

check("IDM-02", "idempotency", "replay returns the existing run in its current state", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }, { name: "b", dependsOn: ["a"] }] });
  await c.run("wf_1", "k1", { x: 1 });
  await c.complete((await c.mustLease("w")).leaseId, "A");
  const n = (await c.events("run_1")).length;
  const r = await start(c, "wf_1", "k1", { input: { x: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, await c.getRun("run_1"));
  assert.equal(r.body.tasks.a.status, "succeeded");
  assert.equal((await c.events("run_1")).length, n);
  const r2 = await start(c, "wf_1", "k2", { input: { x: 1 } });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.id, "run_2");
});

check("IDM-03", "idempotency", "input comparison ignores object key order", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  await c.run("wf_1", "k", { a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } });
  const r = await start(c, "wf_1", "k", { input: { b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, "run_1");
});

check("IDM-04", "idempotency", "same key with a different input conflicts", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  await c.run("wf_1", "k", { list: [1, 2], s: "x" });
  expectError(await start(c, "wf_1", "k", { input: { list: [2, 1], s: "x" } }), 409, "idempotency_conflict");
  expectError(await start(c, "wf_1", "k", { input: { list: [1, 2], s: "x", extra: null } }), 409, "idempotency_conflict");
  expectError(await start(c, "wf_1", "k", { input: { list: [1, 2], s: "X" } }), 409, "idempotency_conflict");
  expectError(await start(c, "wf_1", "k"), 409, "idempotency_conflict");
  const r = await start(c, "wf_1", "k2", { input: 1 });
  assert.equal(r.body.id, "run_2");
});

check("IDM-05", "idempotency", "keys are global across workflows", async (c) => {
  await c.workflow({ name: "one", tasks: [{ name: "a" }] });
  await c.workflow({ name: "two", tasks: [{ name: "a" }] });
  await c.run("wf_1", "shared", { v: 1 });
  expectError(await start(c, "wf_2", "shared", { input: { v: 1 } }), 409, "idempotency_conflict");
  expectError(await start(c, "wf_99", "shared", { input: { v: 1 } }), 404, "not_found");
});

check("IDM-06", "idempotency", "omitted input equals null; key is trimmed", async (c) => {
  await c.workflow({ name: "w", tasks: [{ name: "a" }] });
  const r1 = await start(c, "wf_1", "k");
  assert.equal(r1.status, 201);
  assert.equal(r1.body.input, null);
  assert.equal((await start(c, "wf_1", "k", { input: null })).status, 200);
  assert.equal((await start(c, "wf_1", "k", {})).status, 200);
  assert.equal((await start(c, "wf_1", "  k  ", {})).status, 200);
  expectError(await start(c, "wf_1", "k", { input: 0 }), 409, "idempotency_conflict");
  expectError(await start(c, "wf_1", "k", { input: "" }), 409, "idempotency_conflict");
});
