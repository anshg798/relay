import http from "node:http";

// Relay starter. Replace this with your implementation (see the task instructions).
const port = Number(process.env.PORT ?? 8080);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code: "not_implemented", message: "TODO" } }));
});

server.listen(port, () => {
  console.log(`relay listening on ${port}`);
});
