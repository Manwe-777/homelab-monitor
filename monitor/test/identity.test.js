import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "../src/identity.js";

test("creates the keys once, readable only by us", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "identity-")), "data");
  const first = loadIdentity(dir);
  const again = loadIdentity(dir);
  assert.equal(first.pubkey, again.pubkey);
  assert.equal(first.heartbeatKey, again.heartbeatKey);
  for (const file of ["monitor.key", "vapid.json", "heartbeat.key"]) {
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600, file);
  }
});

test("explains a data directory it can't write", { skip: process.getuid?.() === 0 && "root can write anywhere" }, () => {
  const parent = mkdtempSync(join(tmpdir(), "identity-"));
  chmodSync(parent, 0o500);
  assert.throws(() => loadIdentity(join(parent, "data")), /chown 1000:1000/);
  chmodSync(parent, 0o700);
});
