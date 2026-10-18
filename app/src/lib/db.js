import { ToolDb, MapCrdt } from "tool-db";
import { ToolDbIndexedDb } from "@tool-db/indexeddb-store";
import {
  TOPIC,
  CONFIG_KEY,
  STATUS_KEY,
  alertsKey,
  devicesKey,
  namespaced,
  encryptJson,
  decryptJson,
  decryptMap,
} from "@homelab-monitor/shared";
import { getRelays } from "./session";

export { parsePubkey } from "./parsePubkey";

const MONITORS_KEY = "monitors";

export async function connect(secretKey) {
  const db = new ToolDb({
    relays: getRelays(),
    topic: TOPIC,
    storageAdapter: ToolDbIndexedDb,
    storageName: "homelab-monitor",
  });
  await db.ready;
  await db.keysSignIn(secretKey);
  await waitForRelays(db);
  return db;
}

export function waitForRelays(db, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (db.isConnected || Date.now() - started > timeoutMs) resolve(db.isConnected);
      else setTimeout(poll, 100);
    };
    poll();
  });
}

export const me = (db) => db.userAccount.getAddress();

/**
 * The monitors we paired with, synced between our devices (encrypted for ourselves)
 * @returns {Promise<{ pubkey: string, addedAt: number }[]>}
 */
export async function getMonitors(db) {
  const payload = await db.getData(MONITORS_KEY, true);
  return (await decryptJson(db.userAccount, me(db), payload)) || [];
}

export async function saveMonitors(db, monitors) {
  await db.putData(MONITORS_KEY, await encryptJson(db.userAccount, me(db), monitors), true);
}

/**
 * A value the monitor wrote for us, decrypted (config or status)
 */
export async function readMonitorValue(db, monitor, key) {
  const payload = await db.getData(namespaced(monitor, key));
  return decryptJson(db.userAccount, monitor, payload);
}

export const readConfig = (db, monitor) => readMonitorValue(db, monitor, CONFIG_KEY);
export const readStatus = (db, monitor) => readMonitorValue(db, monitor, STATUS_KEY);

/**
 * Calls back with each new decrypted value of a monitor's key
 * @returns unsubscribe
 */
export function watchMonitorValue(db, monitor, key, callback) {
  const finalKey = namespaced(monitor, key);
  db.subscribeData(finalKey);
  const id = db.addKeyListener(finalKey, async (msg) => {
    const value = await decryptJson(db.userAccount, monitor, msg.v);
    if (value) callback(value);
  });
  return () => db.removeKeyListener(id);
}

/**
 * A month of alerts, newest first
 */
export async function loadAlerts(db, monitor, month) {
  const map = new MapCrdt(me(db));
  await db.getCrdt(namespaced(monitor, alertsKey(month)), map);
  const alerts = await decryptMap(db.userAccount, monitor, map.value);
  return Object.values(alerts).sort((a, b) => b.ts - a.ts);
}

/**
 * Calls back when a month of alerts gets new ones
 * @returns unsubscribe
 */
export function watchAlerts(db, monitor, month, callback) {
  const finalKey = namespaced(monitor, alertsKey(month));
  db.subscribeData(finalKey);
  const id = db.addKeyListener(finalKey, callback);
  return () => db.removeKeyListener(id);
}

/**
 * Our device entry for a monitor: its push subscription and channels
 */
export async function getDeviceEntry(db, monitor, deviceId) {
  const map = new MapCrdt(me(db));
  await db.getCrdt(devicesKey(monitor), map, true);
  return decryptJson(db.userAccount, monitor, map.value[deviceId]);
}

export async function saveDeviceEntry(db, monitor, deviceId, device) {
  const map = new MapCrdt(me(db));
  await db.getCrdt(devicesKey(monitor), map, true);
  map.SET(deviceId, await encryptJson(db.userAccount, monitor, { ...device, updatedAt: Date.now() }));
  await db.putCrdt(devicesKey(monitor), map, true);
}
