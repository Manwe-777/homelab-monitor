import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ece from "http_ece";
import { ToolDb, MapCrdt, generateSecretKey, getPublicKey } from "tool-db";
import { ToolDbRelay } from "@tool-db/nostr-relay";
import {
  TOPIC,
  CONFIG_KEY,
  STATUS_KEY,
  alertsKey,
  devicesKey,
  namespaced,
  monthOf,
  encryptJson,
  decryptJson,
  decryptMap,
} from "@homelab-monitor/shared";
import { loadIdentity } from "../src/identity.js";
import { Monitor } from "../src/monitor.js";

// The fake push service uses a self-signed certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await condition();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("Timed out waiting for a condition");
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/**
 * A push service that decrypts what it gets, like a browser would
 */
async function fakePushService() {
  const dir = mkdtempSync(join(tmpdir(), "push-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const received = [];

  const server = https.createServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = ece.decrypt(Buffer.concat(chunks), {
          version: "aes128gcm",
          privateKey: ecdh,
          authSecret: authSecret.toString("base64url"),
        });
        received.push({ headers: req.headers, payload: JSON.parse(body.toString()) });
        res.writeHead(201);
        res.end();
      });
    }
  );
  const port = await listen(server);

  return {
    server,
    received,
    subscription: {
      endpoint: `https://127.0.0.1:${port}/push/device-1`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: authSecret.toString("base64url"),
      },
    },
  };
}

test("monitor reports to its owner and pushes alerts to their devices", async (t) => {
  // A plain relay, like a public one
  const relay = new ToolDbRelay({ topic: "unused", port: 0, host: "127.0.0.1", acceptForeignEvents: true });
  await relay.start();

  // A service we can take down
  let serviceUp = true;
  const service = http.createServer((req, res) => {
    res.writeHead(serviceUp ? 200 : 503);
    res.end();
  });
  const servicePort = await listen(service);
  const push = await fakePushService();

  const ownerKey = generateSecretKey();
  const owner = getPublicKey(ownerKey);
  const identity = loadIdentity(mkdtempSync(join(tmpdir(), "monitor-data-")));

  const config = {
    name: "Test lab",
    owner,
    relays: [relay.url],
    vapidSubject: "mailto:test@example.com",
    heartbeatMs: 60000,
    channels: [
      {
        id: "services",
        name: "Services",
        checks: [
          {
            id: "web",
            name: "Web",
            type: "http",
            url: `http://127.0.0.1:${servicePort}`,
            intervalMs: 200,
            timeoutMs: 1000,
            failuresBeforeAlert: 2,
          },
        ],
      },
      { id: "quiet", name: "Quiet", checks: [] },
    ],
  };

  // The owner's phone: enables notifications for "services" only
  const phone = new ToolDb({ relays: [relay.url], topic: TOPIC });
  await phone.ready;
  await phone.keysSignIn(ownerKey);
  await waitFor(() => phone.isConnected);
  const devices = new MapCrdt(owner);
  devices.SET(
    "phone-1",
    await encryptJson(phone.userAccount, identity.pubkey, {
      name: "Test phone",
      subscription: push.subscription,
      channels: ["services"],
      updatedAt: Date.now(),
    })
  );
  await phone.putCrdt(devicesKey(identity.pubkey), devices, true);

  const logs = [];
  const monitor = new Monitor(config, identity, { log: (...args) => logs.push(args.join(" ")) });
  t.after(async () => {
    await monitor.stop();
    await phone.close();
    await relay.close();
    service.close();
    push.server.close();
  });
  await monitor.start();

  const readFromMonitor = async (key) =>
    decryptJson(phone.userAccount, identity.pubkey, await phone.getData(namespaced(identity.pubkey, key)));

  // The owner can read the config, with the VAPID key the app subscribes with
  const published = await waitFor(() => readFromMonitor(CONFIG_KEY));
  assert.equal(published.name, "Test lab");
  assert.deepEqual(published.channels.map((c) => c.id), ["services", "quiet"]);
  assert.equal(published.vapidPublicKey, identity.vapid.publicKey);

  // Status: the check comes up, without alerting
  await waitFor(async () => (await readFromMonitor(STATUS_KEY))?.checks?.["services/web"]?.state === "up");
  assert.equal(push.received.length, 0);

  // The service goes down: one alert after two failures, pushed to the phone
  serviceUp = false;
  await waitFor(() => push.received.length === 1);
  const down = push.received[0];
  assert.equal(down.payload.state, "down");
  assert.equal(down.payload.channel, "services");
  assert.equal(down.payload.monitor, identity.pubkey);
  assert.match(down.payload.body, /HTTP 503/);
  assert.equal(down.headers.urgency, "high");

  // Still down: no more alerts
  await sleep(1000);
  assert.equal(push.received.length, 1);

  // Back up: a recovery alert
  serviceUp = true;
  await waitFor(() => push.received.length === 2);
  assert.equal(push.received[1].payload.state, "up");

  // The history has both alerts, encrypted for the owner
  const history = new MapCrdt(owner);
  await waitFor(async () => {
    await phone.getCrdt(namespaced(identity.pubkey, alertsKey(monthOf(Date.now()))), history);
    return Object.keys(history.value).length === 2;
  });
  const alerts = Object.values(await decryptMap(phone.userAccount, identity.pubkey, history.value));
  assert.deepEqual(alerts.map((a) => a.state).sort(), ["down", "up"]);

  // Alerts from channels the phone didn't enable are recorded but not pushed
  await monitor.sendAlert(config.channels[1], null, "test", "Quiet test", "");
  await sleep(500);
  assert.equal(push.received.length, 2);
});

test("monitor ignores devices that aren't the owner's", async (t) => {
  const relay = new ToolDbRelay({ topic: "unused", port: 0, host: "127.0.0.1", acceptForeignEvents: true });
  await relay.start();
  const push = await fakePushService();
  const owner = getPublicKey(generateSecretKey());
  const identity = loadIdentity(mkdtempSync(join(tmpdir(), "monitor-data-")));

  // A stranger writes a device in their own namespace, the monitor only reads the owner's
  const strangerKey = generateSecretKey();
  const stranger = new ToolDb({ relays: [relay.url], topic: TOPIC });
  await stranger.ready;
  await stranger.keysSignIn(strangerKey);
  await waitFor(() => stranger.isConnected);
  const devices = new MapCrdt(getPublicKey(strangerKey));
  devices.SET(
    "evil",
    await encryptJson(stranger.userAccount, identity.pubkey, {
      name: "Evil",
      subscription: push.subscription,
      channels: ["services"],
      updatedAt: Date.now(),
    })
  );
  await stranger.putCrdt(devicesKey(identity.pubkey), devices, true);

  const monitor = new Monitor(
    {
      name: "Test lab",
      owner,
      relays: [relay.url],
      vapidSubject: "mailto:test@example.com",
      heartbeatMs: 60000,
      channels: [{ id: "services", name: "Services", checks: [] }],
    },
    identity,
    { log: () => {} }
  );
  t.after(async () => {
    await monitor.stop();
    await stranger.close();
    await relay.close();
    push.server.close();
  });
  await monitor.start();
  await monitor.sendAlert({ id: "services", name: "Services" }, null, "test", "Test", "");
  await sleep(500);

  assert.deepEqual(monitor.devices, {});
  assert.equal(push.received.length, 0);
});
