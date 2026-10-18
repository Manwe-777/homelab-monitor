import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, npubEncode } from "tool-db";
import { loadConfig } from "../src/config.js";

const owner = npubEncode(getPublicKey(generateSecretKey()));

function configFrom(yaml) {
  const dir = mkdtempSync(join(tmpdir(), "monitor-config-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return loadConfig(join(dir, "config.yaml"));
}

test("applies defaults and ids", () => {
  const config = configFrom(`
owner: ${owner}
interval: 30
channels:
  - name: Media Stuff
    checks:
      - name: Jellyfin Web
        type: http
        url: http://localhost:8096
        interval: 10
      - type: tcp
        host: 127.0.0.1
        port: 22
`);
  assert.equal(config.name, "Homelab");
  assert.equal(config.channels[0].id, "media-stuff");
  const [web, ssh] = config.channels[0].checks;
  assert.equal(web.id, "jellyfin-web");
  assert.equal(web.intervalMs, 10000);
  assert.equal(ssh.id, "127-0-0-1-22");
  assert.equal(ssh.intervalMs, 30000);
  assert.equal(ssh.failuresBeforeAlert, 2);
});

test("rejects bad configs with a clear message", () => {
  assert.throws(() => configFrom(`owner: nope\nchannels: [{ name: a }]`), /owner/);
  assert.throws(() => configFrom(`owner: ${owner}\nchannels: []`), /at least one channel/);
  assert.throws(
    () => configFrom(`owner: ${owner}\nchannels: [{ name: a, checks: [{ type: ping }] }]`),
    /unknown type "ping"/
  );
  assert.throws(
    () => configFrom(`owner: ${owner}\nchannels: [{ name: a, checks: [{ type: tcp, host: x }] }]`),
    /needs `port`/
  );
});
