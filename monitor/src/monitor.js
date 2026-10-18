import { ToolDb, MapCrdt } from "tool-db";
import webpush from "web-push";
import {
  TOPIC,
  CONFIG_KEY,
  STATUS_KEY,
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
import { createStatusServer } from "./statusPage.js";

const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const defaultLog = (...args) => console.log(timestamp(), ...args);

/**
 * Runs the checks of a config, and reports to the owner through tool-db:
 * config, status and alert history (encrypted for the owner), and Web Push
 * notifications to the owner's devices.
 */
export class Monitor {
  /**
   * @param config from loadConfig
   * @param identity from loadIdentity
   * @param options.historyPath where to keep the uptime history (in memory if not set)
   * @param options.toolDbOptions extra ToolDb options (tests)
   */
  constructor(config, identity, { log = defaultLog, historyPath = null, toolDbOptions = {} } = {}) {
    this.config = config;
    this.identity = identity;
    this.log = log;
    this.toolDbOptions = toolDbOptions;
    this.history = new UptimeHistory(historyPath);
    this.startedAt = Date.now();
    this.lastCheckAt = 0;

    this.states = {};
    this.devices = {};
    this.deadEndpoints = new Set();
    this.alertMaps = {};
    this.timers = [];
  }

  get pubkey() {
    return this.identity.pubkey;
  }

  get owner() {
    return this.config.owner;
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
  }

  /**
   * Connects and runs the checks until stopped
   */
  async start() {
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
    await this.db.putData(CONFIG_KEY, await encryptJson(this.signer, this.owner, config), true);
  }

  /**
   * Picks up the states we published before a restart, so we don't alert
   * again for something that was already down
   */
  async loadPreviousStatus() {
    const payload = await this.db.getData(STATUS_KEY, true, 3000).catch(() => null);
    const previous = await decryptJson(this.signer, this.owner, payload);

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
    const result = await runCheck(check);
    const state = this.states[ref];
    const now = Date.now();
    const previous = state.state;

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

    const deadDevices = Object.entries(this.devices)
      .filter(([, device]) => this.deadEndpoints.has(device.subscription?.endpoint))
      .map(([id]) => id);

    const status = {
      checks,
      heartbeatAt: Date.now(),
      heartbeatMs: this.config.heartbeatMs,
      deadDevices,
    };
    try {
      await this.db.putData(STATUS_KEY, await encryptJson(this.signer, this.owner, status), true);
    } catch (err) {
      this.log("Could not publish status:", err.message);
    }
  }

  /**
   * Records an alert in the history, and notifies the devices that want it
   */
  async sendAlert(channel, check, state, title, body) {
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
    if (!this.alertMaps[month]) {
      const map = new MapCrdt(this.pubkey);
      await this.db.getCrdt(alertsKey(month), map, true);
      this.alertMaps[month] = map;
    }

    const map = this.alertMaps[month];
    map.SET(alert.id, await encryptJson(this.signer, this.owner, alert));
    await this.db.putCrdt(alertsKey(month), map, true);
  }

  async pushAlert(channel, alert) {
    const payload = JSON.stringify({
      monitor: this.pubkey,
      monitorName: this.config.name,
      channelName: channel.name,
      ...alert,
    });

    const targets = Object.entries(this.devices).filter(
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
   * Devices are written by the owner, in their namespace
   */
  get devicesFinalKey() {
    return namespaced(this.owner, devicesKey(this.pubkey));
  }

  async loadDevices() {
    const map = new MapCrdt(this.pubkey);
    await this.db.getCrdt(this.devicesFinalKey, map, false).catch(() => null);
    await this.setDevices(map.value);

    this.db.subscribeData(this.devicesFinalKey);
    this.db.addKeyListener(this.devicesFinalKey, (msg) => {
      if (msg.c === "MAP" && Array.isArray(msg.v)) {
        this.setDevices(new MapCrdt("", msg.v).value);
      }
    });
  }

  async setDevices(encrypted) {
    this.devices = await decryptMap(this.signer, this.owner, encrypted);
    const enabled = Object.values(this.devices).filter((device) => device.subscription);
    this.log(`${enabled.length} device(s) with notifications enabled`);
  }
}
