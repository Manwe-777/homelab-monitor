import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../src/checks/index.js";
import { checkHeartbeat, parseDuration, heartbeatToken } from "../src/checks/heartbeat.js";

test("disk check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "disk-"));
  const ok = await runCheck({ type: "disk", path: dir, maxUsedPercent: 100 });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /^\d+% used, [\d.]+ (GB|TB) free$/);

  assert.equal((await runCheck({ type: "disk", path: dir, maxUsedPercent: 0 })).ok, false);
  assert.equal((await runCheck({ type: "disk", path: dir, maxUsedPercent: 100, minFreeGb: 1e9 })).ok, false);

  // A share that isn't mounted: its marker is missing
  const unmounted = await runCheck({ type: "disk", path: dir, marker: "MOUNTED" });
  assert.deepEqual(unmounted, { ok: false, message: "Not mounted (MOUNTED is missing)" });
  writeFileSync(join(dir, "MOUNTED"), "");
  assert.equal((await runCheck({ type: "disk", path: dir, marker: "MOUNTED", maxUsedPercent: 100 })).ok, true);
});

/**
 * A DNS server answering A queries for one name
 */
async function fakeDns(name, address) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (query, rinfo) => {
    // Question name, from offset 12
    const labels = [];
    let i = 12;
    while (query[i]) {
      labels.push(query.subarray(i + 1, i + 1 + query[i]).toString());
      i += query[i] + 1;
    }
    const questionEnd = i + 5;
    const found = labels.join(".") === name;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(found ? 0x8180 : 0x8183, 2); // response, NXDOMAIN when not found
    header.writeUInt16BE(found ? 1 : 0, 6);
    const answer = found
      ? Buffer.concat([
          Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]),
          Buffer.from(address.split(".").map(Number)),
        ])
      : Buffer.alloc(0);
    socket.send(Buffer.concat([header, query.subarray(12, questionEnd), answer]), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return socket;
}

test("dns check", async (t) => {
  const server = await fakeDns("dashboard.example.test", "192.0.2.10");
  t.after(() => server.close());
  const base = { type: "dns", server: "127.0.0.1", port: server.address().port, timeoutMs: 1000 };

  const ok = await runCheck({ ...base, domain: "dashboard.example.test", expect: "192.0.2.10" });
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /dashboard\.example\.test → 192\.0\.2\.10/);

  const wrong = await runCheck({ ...base, domain: "dashboard.example.test", expect: "10.0.0.1" });
  assert.match(wrong.message, /expected 10\.0\.0\.1/);

  const missing = await runCheck({ ...base, domain: "nope.example.test" });
  assert.deepEqual(missing, { ok: false, message: "nope.example.test: ENOTFOUND" });
});

test("heartbeat check", () => {
  const check = { everyMs: parseDuration("1d"), graceMs: parseDuration("3h") };
  const now = Date.UTC(2026, 9, 18, 12);
  const hour = 3600000;

  assert.equal(checkHeartbeat(check, { waitingSince: now - hour, now }).pending, true);
  assert.match(checkHeartbeat(check, { waitingSince: now - 30 * hour, now }).message, /No run reported in 30 h/);
  assert.deepEqual(checkHeartbeat(check, { beat: { at: now - 2 * hour, ok: true }, now }), { ok: true, message: "Last run 2 h ago" });
  assert.equal(checkHeartbeat(check, { beat: { at: now - 28 * hour, ok: true }, now }).ok, false);
  assert.deepEqual(
    checkHeartbeat(check, { beat: { at: now - hour, ok: false, message: "exit-code (exit 1)" }, now }),
    { ok: false, message: "Last run failed: exit-code (exit 1)" }
  );

  assert.equal(parseDuration("30m"), 1800000);
  assert.equal(parseDuration(90), 90000);
  assert.throws(() => parseDuration("soon"), /isn't a duration/);
  assert.notEqual(heartbeatToken("a".repeat(64), "jobs/backup"), heartbeatToken("a".repeat(64), "jobs/other"));
});

test("heartbeats.env holds a token per heartbeat check", async () => {
  const { heartbeatsEnv, heartbeatVariable } = await import("../src/checks/heartbeat.js");
  const env = heartbeatsEnv("k".repeat(64), ["backups/immich-database-backup", "jobs/nightly"]);
  assert.equal(heartbeatVariable("backups/immich-database-backup"), "HEARTBEAT_BACKUPS_IMMICH_DATABASE_BACKUP");
  assert.match(env, new RegExp(`^HEARTBEAT_BACKUPS_IMMICH_DATABASE_BACKUP=${heartbeatToken("k".repeat(64), "backups/immich-database-backup")}$`, "m"));
  assert.match(env, /^HEARTBEAT_JOBS_NIGHTLY=[0-9a-f]{32}$/m);
});
