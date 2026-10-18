import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "tool-db";
import { ToolDbRelay } from "@tool-db/nostr-relay";
import { loadIdentity } from "../src/identity.js";
import { Monitor } from "../src/monitor.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("status page shows public channels without targets, and health", async (t) => {
  const relay = new ToolDbRelay({ topic: "unused", port: 0, host: "127.0.0.1", acceptForeignEvents: true });
  await relay.start();

  let up = true;
  const service = http.createServer((req, res) => {
    res.writeHead(up ? 200 : 500);
    res.end();
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${service.address().port}/secret-path`;
  const check = (id, name) => ({ id, name, type: "http", url, intervalMs: 150, timeoutMs: 1000, failuresBeforeAlert: 1 });

  const monitor = new Monitor(
    {
      name: "Lab",
      owner: getPublicKey(generateSecretKey()),
      relays: [relay.url],
      vapidSubject: "mailto:test@example.com",
      heartbeatMs: 60000,
      statusPage: { port: 0, host: "127.0.0.1", title: "Lab status", showTargets: false },
      channels: [
        { id: "web", name: "Web", public: true, checks: [check("site", "Website"), check("api", "API")] },
        { id: "private", name: "Private stuff", public: false, checks: [check("nas", "NAS")] },
      ],
    },
    loadIdentity(mkdtempSync(join(tmpdir(), "monitor-data-"))),
    { log: () => {} }
  );
  t.after(async () => {
    await monitor.stop();
    await relay.close();
    service.close();
  });
  await monitor.start();
  const base = `http://127.0.0.1:${monitor.statusServer.address().port}`;
  await sleep(600);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).relaysConnected, 1);

  let status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.title, "Lab status");
  assert.equal(status.overall, "operational");
  assert.deepEqual(status.channels.map((c) => c.id), ["web"]);
  assert.equal(status.channels[0].checks[0].days.length, 90);
  assert.equal(status.channels[0].checks[0].uptime, 1);

  const html = await (await fetch(base)).text();
  assert.match(html, /All systems operational/);
  assert.match(html, /Website/);
  assert.doesNotMatch(html, /Private stuff|NAS|secret-path/);

  // Everything goes down: a major outage with incidents
  up = false;
  await sleep(600);
  status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.overall, "major");
  assert.deepEqual(status.incidents.map((i) => i.checkName).sort(), ["API", "Website"]);
  assert.match(await (await fetch(base)).text(), /Major outage/);
});

test("jobs report runs to their heartbeat URL", async (t) => {
  const { heartbeatToken } = await import("../src/checks/heartbeat.js");
  const relay = new ToolDbRelay({ topic: "unused", port: 0, host: "127.0.0.1", acceptForeignEvents: true });
  await relay.start();
  const identity = loadIdentity(mkdtempSync(join(tmpdir(), "monitor-data-")));
  const alerts = [];

  const monitor = new Monitor(
    {
      name: "Lab",
      owner: getPublicKey(generateSecretKey()),
      relays: [relay.url],
      vapidSubject: "mailto:test@example.com",
      heartbeatMs: 60000,
      statusPage: { port: 0, host: "127.0.0.1", showTargets: false },
      channels: [
        {
          id: "jobs",
          name: "Jobs",
          checks: [
            { id: "backup", name: "Backup", type: "heartbeat", every: "1d", everyMs: 86400000, graceMs: 3600000, intervalMs: 60000, timeoutMs: 1000, failuresBeforeAlert: 1 },
          ],
        },
      ],
    },
    identity,
    { log: () => {} }
  );
  monitor.sendAlert = async (channel, check, state, title) => alerts.push({ state, title });
  t.after(async () => {
    await monitor.stop();
    await relay.close();
  });
  await monitor.start();
  const base = `http://127.0.0.1:${monitor.statusServer.address().port}`;
  const url = `${base}/heartbeat/${heartbeatToken(identity.secretKey, "jobs/backup")}`;

  // Before any run: waiting, not down
  await sleep(200);
  assert.equal(monitor.states["jobs/backup"].state, "unknown");
  assert.equal(monitor.states["jobs/backup"].message, "Waiting for the first run");

  assert.equal((await fetch(`${url}?status=success&exit=0`)).status, 200);
  assert.equal(monitor.states["jobs/backup"].state, "up");

  // A failed run alerts right away
  assert.equal((await fetch(`${url}?status=exit-code&exit=1`, { method: "POST" })).status, 200);
  assert.equal(monitor.states["jobs/backup"].state, "down");
  assert.match(monitor.states["jobs/backup"].message, /failed: exit-code \(exit 1\)/);
  assert.deepEqual(alerts.map((a) => a.state), ["down"]);

  assert.equal((await fetch(`${base}/heartbeat/${"0".repeat(32)}`)).status, 404);
});
