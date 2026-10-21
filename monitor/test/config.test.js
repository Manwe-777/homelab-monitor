import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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

test("the example config loads, with every check type", () => {
  const example = readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")
    .replace("owner: npub1...", `owner: ${owner}`);
  const config = configFrom(example);
  const types = new Set(config.channels.flatMap((c) => c.checks.map((check) => check.type)));
  for (const type of ["http", "tcp", "disk", "dns", "heartbeat", "event"]) assert.ok(types.has(type), type);
});

test("heartbeats need the status page, which is on unless turned off", () => {
  const heartbeat = `channels: [{ name: Jobs, checks: [{ name: Nightly, type: heartbeat, every: 1d }] }]`;
  const config = configFrom(`owner: ${owner}\n${heartbeat}`);
  assert.equal(config.statusPage.port, 3001);
  assert.equal(config.channels[0].checks[0].everyMs, 86400000);
  assert.throws(() => configFrom(`owner: ${owner}\nstatusPage: false\n${heartbeat}`), /status page/);
});

test("event checks take a cooldown, and need the status page too", () => {
  const event = (extra = "") => `channels: [{ name: Home, checks: [{ name: Camera, type: event${extra} }] }]`;
  assert.equal(configFrom(`owner: ${owner}\n${event()}`).channels[0].checks[0].cooldownMs, 60000);
  assert.equal(configFrom(`owner: ${owner}\n${event(", cooldown: 5m")}`).channels[0].checks[0].cooldownMs, 300000);
  assert.throws(() => configFrom(`owner: ${owner}\n${event(", cooldown: soon")}`), /isn't a duration/);
  assert.throws(() => configFrom(`owner: ${owner}\nstatusPage: false\n${event()}`), /event checks .* status page/);
});

test("owner takes one npub or a list, up to 3", () => {
  const others = [1, 2, 3].map(() => npubEncode(getPublicKey(generateSecretKey())));
  const channels = "channels: [{ name: a }]";
  assert.equal(configFrom(`owner: ${owner}\n${channels}`).owners.length, 1);
  const two = configFrom(`owner: [${owner}, ${others[0]}, ${owner}]\n${channels}`);
  assert.deepEqual(two.owners.length, 2);
  assert.throws(() => configFrom(`owner: [${owner}, ${others.join(", ")}]\n${channels}`), /up to 3/);
  assert.throws(() => configFrom(`owner: [${owner}, nope]\n${channels}`), /"nope"/);
});
