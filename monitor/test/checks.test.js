import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { runCheck } from "../src/checks/index.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("http check", async (t) => {
  let status = 200;
  const server = http.createServer((req, res) => {
    res.writeHead(status);
    res.end("<title>Glance</title>");
  });
  const port = await listen(server);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}`;

  assert.equal((await runCheck({ type: "http", url, timeoutMs: 2000 })).ok, true);
  assert.equal((await runCheck({ type: "http", url, contains: "Glance", timeoutMs: 2000 })).ok, true);
  assert.equal((await runCheck({ type: "http", url, contains: "Grafana", timeoutMs: 2000 })).ok, false);

  status = 502;
  const down = await runCheck({ type: "http", url, timeoutMs: 2000 });
  assert.deepEqual(down, { ok: false, message: "HTTP 502" });
  assert.equal((await runCheck({ type: "http", url, expectStatus: [502], timeoutMs: 2000 })).ok, true);
});

test("http check times out", async (t) => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  t.after(() => server.close(() => {}) || server.closeAllConnections());
  const result = await runCheck({ type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.match(result.message, /Timed out/);
});

test("tcp check", async (t) => {
  const server = net.createServer((socket) => socket.end());
  const port = await listen(server);
  assert.equal((await runCheck({ type: "tcp", host: "127.0.0.1", port, timeoutMs: 2000 })).ok, true);
  server.close();
  await new Promise((r) => server.on("close", r));
  const closed = await runCheck({ type: "tcp", host: "127.0.0.1", port, timeoutMs: 2000 });
  assert.deepEqual(closed, { ok: false, message: "ECONNREFUSED" });
});

test("docker check reports a missing socket", async () => {
  const result = await runCheck({ type: "docker", container: "x", socket: "/nonexistent.sock", timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.message, /Docker: ENOENT/);
});

test("a check that never answers times out", async () => {
  const { CHECK_TYPES } = await import("../src/checks/index.js");
  CHECK_TYPES.hang = { run: () => new Promise(() => {}), target: () => "", required: [] };
  const started = Date.now();
  const result = await runCheck({ type: "hang", timeoutMs: 100 });
  assert.deepEqual(result, { ok: false, message: "No answer after 1100 ms" });
  assert.ok(Date.now() - started < 2000);
  delete CHECK_TYPES.hang;
});
