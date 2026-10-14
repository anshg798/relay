import { assert, check, expectError } from "../lib/harness.mjs";

const T = (name, extra = {}) => ({ name, ...extra });

check("VAL-01", "validation", "valid workflow is normalized with defaults", async (c) => {
  const r = await c.post("/workflows", {
    name: "etl",
    tasks: [T("extract", { type: "io", priority: 5 }), T("transform", { dependsOn: ["extract", "extract"] }), T("load", { dependsOn: ["transform", "extract"] })],
    unknownField: true,
  });
  assert.equal(r.status, 201);
  const expected = {
    id: "wf_1",
    name: "etl",
    createdAt: 0,
    leaseTimeoutMs: 30000,
    retry: { maxAttempts: 3, baseBackoffMs: 1000, multiplier: 2, maxBackoffMs: 60000 },
    tasks: [
      { name: "extract", type: "io", priority: 5, dependsOn: [] },
      { name: "transform", type: "default", priority: 0, dependsOn: ["extract"] },
      { name: "load", type: "default", priority: 0, dependsOn: ["extract", "transform"] },
    ],
  };
  assert.deepEqual(r.body, expected);
  const g = await c.get("/workflows/wf_1");
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, expected);
});

check("VAL-02", "validation", "explicit retry and lease settings are kept", async (c) => {
  const r = await c.post("/workflows", {
    name: "custom",
    tasks: [T("a")],
    retry: { maxAttempts: 5, multiplier: 1.5 },
    leaseTimeoutMs: 1234,
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.retry, { maxAttempts: 5, baseBackoffMs: 1000, multiplier: 1.5, maxBackoffMs: 60000 });
  assert.equal(r.body.leaseTimeoutMs, 1234);
});

check("VAL-03", "validation", "empty task list is rejected", async (c) => {
  expectError(await c.post("/workflows", { name: "x", tasks: [] }), 400, "empty_workflow");
});

check("VAL-04", "validation", "duplicate task names are rejected", async (c) => {
  expectError(await c.post("/workflows", { name: "x", tasks: [T("a"), T("b"), T("a")] }), 400, "duplicate_task");
});

check("VAL-05", "validation", "unknown dependency is rejected", async (c) => {
  expectError(await c.post("/workflows", { name: "x", tasks: [T("a", { dependsOn: ["ghost"] })] }), 400, "unknown_dependency");
});

check("VAL-06", "validation", "cycles and self-dependencies are rejected", async (c) => {
  expectError(
    await c.post("/workflows", {
      name: "x",
      tasks: [T("a", { dependsOn: ["c"] }), T("b", { dependsOn: ["a"] }), T("c", { dependsOn: ["b"] }), T("d")],
    }),
    400,
    "cycle_detected",
  );
  expectError(await c.post("/workflows", { name: "y", tasks: [T("a", { dependsOn: ["a"] })] }), 400, "cycle_detected");
  // A cycle that is not reachable from the first task.
  expectError(
    await c.post("/workflows", {
      name: "z",
      tasks: [T("root"), T("p", { dependsOn: ["q", "root"] }), T("q", { dependsOn: ["p"] })],
    }),
    400,
    "cycle_detected",
  );
});

check("VAL-07", "validation", "validation rules are applied in the specified order", async (c) => {
  expectError(await c.post("/workflows", { name: "BAD NAME", tasks: [] }), 400, "invalid_definition");
  expectError(
    await c.post("/workflows", { name: "x", tasks: [T("a", { dependsOn: ["ghost"] }), T("a")] }),
    400,
    "duplicate_task",
  );
  expectError(
    await c.post("/workflows", { name: "x", tasks: [T("a", { dependsOn: ["b"] }), T("b", { dependsOn: ["a", "ghost"] })] }),
    400,
    "unknown_dependency",
  );
  expectError(await c.post("/workflows", { name: "x", tasks: [], leaseTimeoutMs: 0 }), 400, "invalid_definition");
});

check("VAL-08", "validation", "out-of-range fields are invalid_definition", async (c) => {
  const bad = [
    { retry: { maxAttempts: 0 } },
    { retry: { maxAttempts: 21 } },
    { retry: { maxAttempts: 2.5 } },
    { retry: { multiplier: 0.5 } },
    { retry: { baseBackoffMs: -1 } },
    { retry: { baseBackoffMs: 70000 } }, // exceeds default maxBackoffMs
    { retry: { baseBackoffMs: 5000, maxBackoffMs: 4999 } },
    { retry: "fast" },
    { leaseTimeoutMs: 0 },
    { leaseTimeoutMs: 1.5 },
    { tasks: [T("a", { priority: 1.5 })] },
    { tasks: [T("a", { type: "" })] },
    { tasks: [T("a", { dependsOn: "b" })] },
    { tasks: [T("-a")] },
    { tasks: ["a"] },
    { tasks: { a: {} } },
  ];
  for (const patch of bad) {
    const r = await c.post("/workflows", { name: "x", tasks: [T("a")], ...patch });
    expectError(r, 400, "invalid_definition");
  }
  // Boundary values that are valid.
  const ok = await c.post("/workflows", {
    name: "edge",
    tasks: [T("a", { priority: -3 })],
    retry: { maxAttempts: 20, baseBackoffMs: 0, multiplier: 10, maxBackoffMs: 0 },
    leaseTimeoutMs: 86400000,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

check("VAL-09", "validation", "duplicate workflow names conflict; rejections consume no ids", async (c) => {
  await c.workflow({ name: "dup", tasks: [T("a")] });
  expectError(await c.post("/workflows", { name: "dup", tasks: [T("b")] }), 409, "workflow_exists");
  expectError(await c.post("/workflows", { name: "other", tasks: [] }), 400, "empty_workflow");
  const w = await c.workflow({ name: "other", tasks: [T("a")] });
  assert.equal(w.id, "wf_2");
});

check("VAL-10", "validation", "invalid JSON, unknown routes and unknown workflows", async (c) => {
  expectError(await c.post("/workflows", undefined, { raw: "{not json" }), 400, "invalid_json");
  expectError(await c.get("/nope"), 404, "not_found");
  expectError(await c.get("/workflows/wf_99"), 404, "not_found");
  expectError(await c.req("DELETE", "/workflows/wf_1"), 404, "not_found");
});
