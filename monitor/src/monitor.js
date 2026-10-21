import { ToolDb, MapCrdt, npubEncode } from "tool-db";
import webpush from "web-push";
import {
  TOPIC,
  configKey,
  statusKey,
  alertsKey,
  devicesKey,
  namespaced,
  checkRef,
  monthOf,
  encryptJson,
  decryptJson,
  decryptMap,
  deviceWantsChannel,
} from "@homelab-monitor/shared";
import { runCheck, CHECK_TYPES } from "./checks/index.js";
import { UptimeHistory } from "./history.js";
import { writeFileSync } from "node:fs";
import { heartbeatToken, heartbeatsEnv } from "./checks/heartbeat.js";
import { eventToken, eventsEnv, parseEvent } from "./checks/event.js";
import { createStatusServer } from "./statusPage.js";

const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const defaultLog = (...args) => console.log(timestamp(), ...args);

/**
 * Runs the checks of a config, and reports to its owners through tool-db:
 * config, status and alert history (a copy encrypted for each owner), and
 * Web Push notifications to the owners' devices.
 */
export class Monitor {
  /**
   * @param config from loadConfig
   * @param identity from loadIdentity
   * @param options.historyPath where to keep the uptime history (in memory if not set)
   * @param options.heartbeatsEnvPath where to write the heartbeat tokens for jobs (not written if not set)
   * @param options.eventsEnvPath where to write the event tokens for services (not written if not set)
   * @param options.toolDbOptions extra ToolDb options (tests)
   */
  constructor(
    config,
    identity,
    { log = defaultLog, historyPath = null, heartbeatsEnvPath = null, eventsEnvPath = null, toolDbOptions = {} } = {}
  ) {
    this.config = config;
    this.identity = identity;
    this.log = log;
    this.toolDbOptions = toolDbOptions;
    this.heartbeatsEnvPath = heartbeatsEnvPath;
    this.eventsEnvPath = eventsEnvPath;
    this.history = new UptimeHistory(historyPath);
    this.startedAt = Date.now();
    this.lastCheckAt = 0;

    // Heartbeat checks, by the token in their URL
    this.heartbeats = new Map();
    for (const channel of config.channels) {
      for (const check of channel.checks.filter((c) => c.type === "heartbeat")) {
        const ref = checkRef(channel.id, check.id);
        this.heartbeats.set(heartbeatToken(identity.heartbeatKey, ref), { channel, check, ref });
      }
    }

    // Event checks, by the token in their URL
    this.events = new Map();
    for (const channel of config.channels) {
      for (const check of channel.checks.filter((c) => c.type === "event")) {
        const ref = checkRef(channel.id, check.id);
        this.events.set(eventToken(identity.heartbeatKey, ref), { channel, check, ref });
      }
    }

    this.states = {};
    // { [owner]: { [deviceId]: Device } }
    this.devices = {};
    this.deadEndpoints = new Set();
    this.alertMaps = {};
    this.timers = [];
  }

  get pubkey() {
    return this.identity.pubkey;
  }

  get owners() {
    return this.config.owners;
  }

  get signer() {
    return this.db.userAccount;
  }

  /**
   * Connects to the relays, and publishes our config
   */
  async connect() {
    this.db = new ToolDb({
      relays: this.config.relays,
      topic: TOPIC,
      ...this.toolDbOptions,
    });
    await this.db.ready;
    await this.db.keysSignIn(this.identity.secretKey, this.config.name);

    webpush.setVapidDetails(
      this.config.vapidSubject,
      this.identity.vapid.publicKey,
      this.identity.vapid.privateKey
    );

    if (!(await this.waitForRelays())) {
      this.log("Not connected to any relay yet, will keep trying");
    }

    await this.publishConfig();
    await this.loadDevices();
    await this.syncAlerts(monthOf(Date.now()));
  }

  /**
   * Connects and runs the checks until stopped
   */
  async start() {
    if (this.heartbeatsEnvPath) {
      const refs = [...this.heartbeats.values()].map((heartbeat) => heartbeat.ref);
      writeFileSync(this.heartbeatsEnvPath, heartbeatsEnv(this.identity.heartbeatKey, refs), { mode: 0o600 });
    }
    if (this.eventsEnvPath && this.events.size) {
      const refs = [...this.events.values()].map((event) => event.ref);
      writeFileSync(this.eventsEnvPath, eventsEnv(this.identity.heartbeatKey, refs), { mode: 0o600 });
    }
    if (this.config.statusPage) await this.startStatusPage();
    await this.connect();
    await this.loadPreviousStatus();

    for (const channel of this.config.channels) {
      for (const check of channel.checks) {
        const run = () => this.runCheck(channel, check);
        run();
        this.timers.push(setInterval(run, check.intervalMs));
      }
    }

    // Right away too, for an owner who was just added
    this.scheduleStatus();
    this.timers.push(setInterval(() => this.publishStatus(), this.config.heartbeatMs));
    this.timers.push(setInterval(() => this.history.save(), 60000));
    this.log(`Monitoring ${this.checkCount()} checks in ${this.config.channels.length} channels`);
  }

  async stop() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.statusTimer);
    this.history.save();
    await new Promise((resolve) => (this.statusServer ? this.statusServer.close(resolve) : resolve()));
    await this.db?.close();
  }

  async startStatusPage() {
    const { port, host } = this.config.statusPage;
    this.statusServer = createStatusServer(this);
    await new Promise((resolve, reject) => {
      this.statusServer.once("error", reject);
      this.statusServer.listen(port, host, resolve);
    });
    this.log(`Status page on http://${host}:${this.statusServer.address().port}`);
  }

  /**
   * Whether the monitor works: checks keep running, and alerts can be
   * delivered (connected to a relay)
   */
  health(now = Date.now()) {
    const intervals = this.config.channels.flatMap((channel) =>
      channel.checks.map((check) => check.intervalMs + check.timeoutMs)
    );
    const checksRunning =
      intervals.length === 0 || now - (this.lastCheckAt || this.startedAt) < 3 * Math.min(...intervals);
    const relaysConnected = this.db?.relays.connected || 0;

    return {
      ok: checksRunning && relaysConnected > 0,
      checksRunning,
      relaysConnected,
      relaysTotal: this.config.relays.length,
      lastCheckAt: this.lastCheckAt || null,
      startedAt: this.startedAt,
    };
  }

  checkCount() {
    return this.config.channels.reduce((count, channel) => count + channel.checks.length, 0);
  }

  async waitForRelays(timeoutMs = 10000) {
    const started = Date.now();
    while (!this.db.isConnected && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.db.isConnected;
  }

  async publishConfig() {
    const config = {
      name: this.config.name,
      channels: this.config.channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        checks: channel.checks.map((check) => ({
          id: check.id,
          name: check.name,
          type: check.type,
          target: String(CHECK_TYPES[check.type].target(check)),
          intervalMs: check.intervalMs,
        })),
      })),
      vapidPublicKey: this.identity.vapid.publicKey,
      updatedAt: Date.now(),
    };
    await this.putForOwners(configKey, config);
  }

  /**
   * Writes a value once per owner, each copy encrypted for them
   * @param key owner => key
   */
  async putForOwners(key, value) {
    await Promise.all(
      this.owners.map(async (owner) =>
        this.db.putData(key(owner), await encryptJson(this.signer, owner, value), true)
      )
    );
  }

  /**
   * Picks up the states we published before a restart, so we don't alert
   * again for something that was already down
   */
  async loadPreviousStatus() {
    let previous = null;
    for (const owner of this.owners) {
      const payload = await this.db.getData(statusKey(owner), true, 3000).catch(() => null);
      previous = await decryptJson(this.signer, owner, payload);
      if (previous) break;
    }

    for (const channel of this.config.channels) {
      for (const check of channel.checks) {
        const ref = checkRef(channel.id, check.id);
        const before = previous?.checks?.[ref];
        this.states[ref] = {
          state: before?.state || "unknown",
          message: before?.message || "",
          since: before?.since || Date.now(),
          checkedAt: before?.checkedAt || 0,
          failures: 0,
        };
      }
    }
  }

  /**
   * Runs a check and alerts when its state changes. A check is down after
   * `failuresBeforeAlert` failures in a row, and up on its first success.
   */
  async runCheck(channel, check) {
    const ref = checkRef(channel.id, check.id);
    // Don't pile up runs behind one that hangs
    if (this.running?.has(ref)) return;
    (this.running ||= new Set()).add(ref);
    try {
      await this.evaluateCheck(channel, check, ref);
    } finally {
      this.running.delete(ref);
    }
  }

  async evaluateCheck(channel, check, ref) {
    const context =
      check.type === "heartbeat"
        ? { beat: this.history.beat(ref), waitingSince: this.startedAt }
        : check.type === "event"
          ? { last: this.history.lastEvent(ref) }
          : undefined;
    const result = await runCheck(check, context);
    const state = this.states[ref];
    const now = Date.now();
    const previous = state.state;

    // Nothing to judge yet (a heartbeat before its first run)
    if (result.pending) {
      state.message = result.message;
      return;
    }

    state.checkedAt = now;
    state.message = result.message;
    this.lastCheckAt = now;
    this.history.record(ref, result.ok, now);

    if (result.ok) {
      state.failures = 0;
      if (previous !== "up") {
        state.state = "up";
        state.since = now;
        this.log(`UP   ${ref}: ${result.message}`);
        if (previous === "down") {
          this.history.closeIncident(ref, now);
          await this.sendAlert(channel, check, "up", `✅ ${check.name} is back up`, result.message);
        }
      }
    } else {
      state.failures++;
      if (previous !== "down" && state.failures >= check.failuresBeforeAlert) {
        state.state = "down";
        state.since = now;
        this.log(`DOWN ${ref}: ${result.message}`);
        this.history.openIncident({ ref, channel: channel.id, checkName: check.name, message: result.message }, now);
        await this.sendAlert(channel, check, "down", `🔴 ${check.name} is down`, result.message);
      }
    }

    if (state.state !== previous) this.scheduleStatus();
  }

  /**
   * Publishes the status soon, batching changes that happen together
   */
  scheduleStatus() {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.publishStatus(), 2000);
  }

  async publishStatus() {
    const checks = {};
    for (const [ref, { failures: _failures, ...state }] of Object.entries(this.states)) {
      checks[ref] = state;
    }

    const heartbeatAt = Date.now();
    try {
      await Promise.all(
        this.owners.map(async (owner) => {
          // Each owner sees which of their devices lost their subscription
          const deadDevices = Object.entries(this.devices[owner] || {})
            .filter(([, device]) => this.deadEndpoints.has(device.subscription?.endpoint))
            .map(([id]) => id);
          const status = { checks, heartbeatAt, heartbeatMs: this.config.heartbeatMs, deadDevices };
          await this.db.putData(statusKey(owner), await encryptJson(this.signer, owner, status), true);
        })
      );
    } catch (err) {
      this.log("Could not publish status:", err.message);
    }
  }

  /**
   * Records an alert in the history, and notifies the devices that want it
   * @param extra more fields for the alert (an event's url)
   */
  async sendAlert(channel, check, state, title, body, extra = {}) {
    const ts = Date.now();
    const alert = {
      id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
      channel: channel.id,
      check: check?.id || "",
      checkName: check?.name || "",
      state,
      title,
      body,
      ts,
      ...extra,
    };

    try {
      await this.recordAlert(alert);
    } catch (err) {
      this.log("Could not record alert:", err.message);
    }
    await this.pushAlert(channel, alert);
    return alert;
  }

  async recordAlert(alert) {
    const month = monthOf(alert.ts);
    await Promise.all(this.owners.map((owner) => this.addAlerts(owner, month, [alert])));
  }

  /**
   * An owner's alert history for a month, loaded once
   */
  async alertMap(owner, month) {
    const key = alertsKey(month, owner);
    if (!this.alertMaps[key]) {
      const map = new MapCrdt(this.pubkey);
      await this.db.getCrdt(key, map, true).catch(() => null);
      this.alertMaps[key] = map;
    }
    return this.alertMaps[key];
  }

  async addAlerts(owner, month, alerts) {
    const map = await this.alertMap(owner, month);
    for (const alert of alerts) {
      map.SET(alert.id, await encryptJson(this.signer, owner, alert));
    }
    await this.db.putCrdt(alertsKey(month, owner), map, true);
  }

  /**
   * Gives every owner the month's alerts that any other owner has, so an
   * owner added to the config gets the history so far
   */
  async syncAlerts(month) {
    try {
      const known = {};
      for (const owner of this.owners) {
        known[owner] = await decryptMap(this.signer, owner, (await this.alertMap(owner, month)).value);
      }
      // The month's history from when it was kept in a single copy
      const single = new MapCrdt(this.pubkey);
      await this.db.getCrdt(`alerts-${month}`, single, true).catch(() => null);

      const all = {};
      for (const owner of this.owners) {
        Object.assign(all, await decryptMap(this.signer, owner, single.value), known[owner]);
      }
      for (const owner of this.owners) {
        const missing = Object.values(all).filter((alert) => !known[owner][alert.id]);
        if (missing.length) {
          await this.addAlerts(owner, month, missing);
          this.log(`Copied ${missing.length} alert(s) to the history of ${npubEncode(owner).slice(0, 16)}…`);
        }
      }
    } catch (err) {
      this.log("Could not copy the alert history:", err.message);
    }
  }

  async pushAlert(channel, alert) {
    const payload = JSON.stringify({
      monitor: this.pubkey,
      monitorName: this.config.name,
      channelName: channel.name,
      ...alert,
    });

    const targets = Object.values(this.devices).flatMap(Object.entries).filter(
      ([, device]) =>
        deviceWantsChannel(device, channel.id) &&
        !this.deadEndpoints.has(device.subscription.endpoint)
    );

    await Promise.all(
      targets.map(async ([id, device]) => {
        try {
          await webpush.sendNotification(device.subscription, payload, {
            TTL: 24 * 60 * 60,
            urgency: alert.state === "down" ? "high" : "normal",
          });
          this.log(`Pushed "${alert.title}" to ${device.name || id}`);
        } catch (err) {
          // The push service forgot this subscription, the device has to enable notifications again
          if (err.statusCode === 404 || err.statusCode === 410) {
            this.deadEndpoints.add(device.subscription.endpoint);
            this.scheduleStatus();
          }
          this.log(`Push to ${device.name || id} failed:`, err.statusCode || err.message);
        }
      })
    );
    return targets.length;
  }

  /**
   * A job reporting a run for a heartbeat check
   * @returns false for an unknown token
   */
  async receiveHeartbeat(token, { ok, message }) {
    const heartbeat = this.heartbeats.get(token);
    if (!heartbeat) return false;

    this.history.recordBeat(heartbeat.ref, { at: Date.now(), ok, message });
    this.log(`Heartbeat ${heartbeat.ref}: ${ok ? "ok" : `failed ${message}`}`);
    await this.runCheck(heartbeat.channel, heartbeat.check);
    return true;
  }

  /**
   * A service reporting an event: alerts right away, unless the check's
   * last alert was less than its cooldown ago
   * @returns { found: false } for an unknown token, else { found, sent }
   * @throws for an invalid event
   */
  async receiveEvent(token, input) {
    const target = this.events.get(token);
    if (!target) return { found: false };
    const { channel, check, ref } = target;
    const event = parseEvent(input);
    const now = Date.now();
    const last = this.history.lastEvent(ref);

    if (last && now - last.at < check.cooldownMs) {
      this.history.recordEvent(ref, { ...last, suppressed: (last.suppressed || 0) + 1 });
      this.log(`Event ${ref}: in cooldown, not sent`);
      await this.runCheck(channel, check);
      return { found: true, sent: false };
    }

    this.history.recordEvent(ref, { at: now, title: event.title || "", suppressed: 0 });
    this.log(`Event ${ref}: ${event.title || "(no title)"}`);
    await this.sendAlert(
      channel,
      check,
      "event",
      event.title || `🔔 ${check.name}`,
      event.message || "",
      event.url ? { url: event.url } : {}
    );
    await this.runCheck(channel, check);
    return { found: true, sent: true };
  }

  /**
   * Devices are written by each owner, in their namespace
   */
  async loadDevices() {
    await Promise.all(
      this.owners.map(async (owner) => {
        const key = namespaced(owner, devicesKey(this.pubkey));
        const map = new MapCrdt(this.pubkey);
        await this.db.getCrdt(key, map, false).catch(() => null);
        await this.setDevices(owner, map.value);

        this.db.subscribeData(key);
        this.db.addKeyListener(key, (msg) => {
          if (msg.c === "MAP" && Array.isArray(msg.v)) {
            this.setDevices(owner, new MapCrdt("", msg.v).value);
          }
        });
      })
    );
  }

  async setDevices(owner, encrypted) {
    this.devices[owner] = await decryptMap(this.signer, owner, encrypted);
    const enabled = Object.values(this.devices)
      .flatMap(Object.values)
      .filter((device) => device.subscription);
    this.log(`${enabled.length} device(s) with notifications enabled`);
  }
}
