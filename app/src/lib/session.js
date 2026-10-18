import { generateSecretKey, getPublicKey, nsecEncode, normalizeSecretKey } from "tool-db";
import { DEFAULT_RELAYS } from "@homelab-monitor/shared";

const KEY = "homelab-monitor-key";
const RELAYS_KEY = "homelab-monitor-relays";

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Our secret key (hex), kept in this browser
 */
export function getSecretKey() {
  return read(KEY);
}

/**
 * Saves a secret key (hex or nsec), or a new one
 * @returns the hex secret key
 */
export function saveSecretKey(secretKey = generateSecretKey()) {
  const hex = normalizeSecretKey(secretKey.trim());
  getPublicKey(hex); // throws on an invalid key
  localStorage.setItem(KEY, hex);
  return hex;
}

export function forgetSecretKey() {
  localStorage.removeItem(KEY);
}

export const exportSecretKey = (hex) => nsecEncode(hex);

export function getRelays() {
  try {
    return JSON.parse(read(RELAYS_KEY)) || DEFAULT_RELAYS;
  } catch {
    return DEFAULT_RELAYS;
  }
}

export function saveRelays(relays) {
  localStorage.setItem(RELAYS_KEY, JSON.stringify(relays));
}

/**
 * This device's id and name, for its entry in each monitor's devices
 */
export function getDevice() {
  let id = read("homelab-monitor-device");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("homelab-monitor-device", id);
  }
  const name = read("homelab-monitor-device-name") || defaultDeviceName();
  return { id, name };
}

export function saveDeviceName(name) {
  localStorage.setItem("homelab-monitor-device-name", name);
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  const model = ua.match(/Android [\d.]+; ([^;)]+)/)?.[1];
  if (model && model !== "K") return model;
  if (/Android/.test(ua)) return "Android phone";
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  return "Browser";
}
