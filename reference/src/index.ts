import http from "node:http";
import path from "node:path";
import { Engine } from "./engine.js";
import { SnapshotStore } from "./store.js";
import { ApiError, Reply, State } from "./types.js";

const port = Number(process.env.PORT ?? 8080);
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const engine = new Engine(new SnapshotStore<State>(dataDir));

type Handler = (m: RegExpMatchArray, body: unknown, req: http.IncomingMessage, url: URL) => Reply;

const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/health$/, () => ({ status: 200, body: { status: "ok" } })],
  ["GET", /^\/_test\/clock$/, () => engine.clock()],
  ["POST", /^\/_test\/clock\/advance$/, (_m, b) => engine.advance(b)],
  ["POST", /^\/workflows$/, (_m, b) => engine.createWorkflow(b)],
  ["GET", /^\/workflows\/([^/]+)$/, (m) => engine.getWorkflow(m[1])],
  [
    "POST",
    /^\/workflows\/([^/]+)\/runs$/,
    (m, b, req) => {
      const h = req.headers["idempotency-key"];
      return engine.startRun(m[1], Array.isArray(h) ? h[0] : h, b);
    },
  ],
  ["GET", /^\/runs\/([^/]+)$/, (m) => engine.getRun(m[1])],
  ["GET", /^\/runs\/([^/]+)\/events$/, (m, _b, _r, url) => engine.events(m[1], url.searchParams.get("after"))],
  ["POST", /^\/runs\/([^/]+)\/cancel$/, (m) => engine.cancel(m[1])],
  ["POST", /^\/leases$/, (_m, b) => engine.lease(b)],
  ["POST", /^\/leases\/([^/]+)\/heartbeat$/, (m) => engine.heartbeat(m[1])],
  ["POST", /^\/leases\/([^/]+)\/complete$/, (m, b) => engine.complete(m[1], b)],
  ["POST", /^\/leases\/([^/]+)\/fail$/, (m, b) => engine.fail(m[1], b)],
];

function send(res: http.ServerResponse, reply: Reply): void {
  if (reply.status === 204 || reply.body === undefined) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  const data = JSON.stringify(reply.body);
  res.writeHead(reply.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function handle(req: http.IncomingMessage, raw: string): Reply {
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m || method !== req.method) continue;
    let body: unknown = undefined;
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ApiError(400, "invalid_json", "body is not valid JSON");
      }
    }
    return handler(m, body, req, url);
  }
  throw new ApiError(404, "not_found", "no such route");
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    // Handlers are fully synchronous, so each request is applied atomically.
    try {
      send(res, handle(req, Buffer.concat(chunks).toString("utf8")));
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, { status: err.status, body: { error: { code: err.code, message: err.message } } });
      } else {
        console.error(err);
        send(res, { status: 500, body: { error: { code: "internal", message: String(err) } } });
      }
    }
  });
});

server.listen(port, () => console.log(`relay listening on ${port}, data in ${dataDir}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
