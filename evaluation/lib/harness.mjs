// Black-box harness: every check gets its own server process and empty DATA_DIR.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";

export const checks = [];

/** Register a verifier check. */
export function check(id, category, title, fn) {
  if (checks.some((c) => c.id === id)) throw new Error(`duplicate check id ${id}`);
  checks.push({ id, category, title, fn });
}

// Ports are handed out by the harness itself (never by the OS) so two concurrent
// checks can never be given the same port. The range sits below Linux's ephemeral
// range so client sockets cannot collide with it either.
const PORT_MIN = 20000;
const PORT_SPAN = 9000;
const portsInUse = new Set();
let portCursor = (process.pid * 37) % PORT_SPAN;

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function allocPort() {
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = PORT_MIN + (portCursor++ % PORT_SPAN);
    if (portsInUse.has(port)) continue;
    portsInUse.add(port);
    if (await canBind(port)) return port;
    portsInUse.delete(port);
  }
  throw new Error("no free port available");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Server {
  constructor({ root, solutionDir, workDir }) {
    this.root = root;
    this.solutionDir = solutionDir;
    this.dataDir = path.join(workDir, "data");
    this.logFile = path.join(workDir, "server.log");
    this.proc = null;
    this.port = null;
  }

  async start() {
    this.port = await allocPort();
    const log = fs.openSync(this.logFile, "a");
    this.proc = spawn("bash", [path.join(this.root, "app-setup", "start.sh")], {
      env: { ...process.env, SOLUTION_DIR: this.solutionDir, PORT: String(this.port), DATA_DIR: this.dataDir },
      detached: true,
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.exited = exited;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1000) });
        // Only accept the probe if the process we spawned is still alive.
        if (res.status === 200 && this.proc.exitCode === null) return;
      } catch {
        /* not up yet */
      }
      await sleep(50);
    }
    await this.kill();
    throw new Error("server did not become healthy within 15s");
  }

  /** Hard kill the whole process group (simulates a crash). */
  async kill() {
    if (!this.proc) return;
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([this.exited, sleep(5000)]);
    this.proc = null;
    portsInUse.delete(this.port);
  }

  async restart() {
    await this.kill();
    await this.start();
  }
}

export class Client {
  constructor(server) {
    this.server = server;
  }

  async req(method, url, body, { headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(10000) };
    if (raw !== undefined) {
      init.body = raw;
      init.headers["content-type"] = "application/json";
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
    const res = await fetch(`http://127.0.0.1:${this.server.port}${url}`, init);
    const text = await res.text();
    let json = null;
    if (text.length) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { __unparsable: text };
      }
    }
    return { status: res.status, body: json };
  }
  get(url) {
    return this.req("GET", url);
  }
  post(url, body, opts) {
    return this.req("POST", url, body, opts);
  }

  // ---- convenience wrappers that assert success -------------------------
  async workflow(def) {
    const r = await this.post("/workflows", def);
    assert.equal(r.status, 201, `create workflow: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async run(workflowId, key, input) {
    const body = input === undefined ? undefined : { input };
    const r = await this.post(`/workflows/${workflowId}/runs`, body, { headers: { "Idempotency-Key": key } });
    assert.equal(r.status, 201, `start run: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async lease(workerId = "w1", types) {
    const body = types ? { workerId, types } : { workerId };
    const r = await this.post("/leases", body);
    if (r.status === 204) return null;
    assert.equal(r.status, 200, `lease: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async mustLease(workerId, types) {
    const l = await this.lease(workerId, types);
    assert.ok(l, "expected a lease but got 204");
    return l;
  }
  async complete(leaseId, output) {
    const r = await this.post(`/leases/${leaseId}/complete`, output === undefined ? undefined : { output });
    assert.equal(r.status, 200, `complete ${leaseId}: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async fail(leaseId, error = "boom") {
    const r = await this.post(`/leases/${leaseId}/fail`, { error });
    assert.equal(r.status, 200, `fail ${leaseId}: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async advance(ms) {
    const r = await this.post("/_test/clock/advance", { ms });
    assert.equal(r.status, 200, `advance: ${JSON.stringify(r.body)}`);
    return r.body.now;
  }
  async now() {
    const r = await this.get("/_test/clock");
    assert.equal(r.status, 200);
    return r.body.now;
  }
  async getRun(id) {
    const r = await this.get(`/runs/${id}`);
    assert.equal(r.status, 200, `get run: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async task(runId, name) {
    const run = await this.getRun(runId);
    assert.ok(run.tasks && run.tasks[name], `task ${name} missing`);
    return run.tasks[name];
  }
  async events(runId, after) {
    const r = await this.get(`/runs/${runId}/events${after === undefined ? "" : `?after=${after}`}`);
    assert.equal(r.status, 200, `events: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.events), "events must be an array");
    return r.body.events;
  }
}

// ---- assertion helpers --------------------------------------------------

export function expectError(res, status, code) {
  assert.equal(res.status, status, `expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(res.body && res.body.error, `missing error envelope: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error.code, code);
}

/** Compact [type, task, at] view of an event list. */
export function brief(events) {
  return events.map((e) => [e.type, e.task, e.at]);
}

export function assertSeqs(events) {
  events.forEach((e, i) => assert.equal(e.seq, i + 1, `event seq gap at index ${i}`));
}

export { assert };
