/**
 * Data model shared by the monitor and the app, all under the TOPIC topic.
 * M is the monitor's public key, U an owner's (yours). Every value is
 * encrypted with NIP-44 between M and U, readable only by both of them, so
 * the monitor writes a copy of its values for each owner.
 *
 *   :M.config-U            MonitorConfig, written by the monitor
 *   :M.status-U            MonitorStatus, written by the monitor
 *   :M.alerts-YYYY-MM-U    MapCRDT of the month's alerts, { [alertId]: encrypted Alert }
 *   :U.devices-M           MapCRDT of the owner's devices, { [deviceId]: encrypted Device }
 *
 * @typedef {{ id: string, name: string, type: string, target: string }} CheckInfo
 * @typedef {{ id: string, name: string, checks: CheckInfo[] }} ChannelInfo
 * @typedef {{ name: string, channels: ChannelInfo[], vapidPublicKey: string, updatedAt: number }} MonitorConfig
 * @typedef {{ state: "up" | "down" | "unknown", message: string, since: number, checkedAt: number }} CheckStatus
 * @typedef {{ checks: Record<string, CheckStatus>, heartbeatAt: number, intervalMs: number }} MonitorStatus
 * @typedef {{ id: string, channel: string, check: string, checkName: string, state: "up" | "down" | "test", title: string, body: string, ts: number }} Alert
 * @typedef {{ name: string, subscription: PushSubscriptionJSON | null, channels: string[], updatedAt: number }} Device
 */

export const TOPIC = "homelab-monitor";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
];

// Keys, relative to the writer's namespace
export const configKey = (ownerPubkey) => `config-${ownerPubkey}`;
export const statusKey = (ownerPubkey) => `status-${ownerPubkey}`;
export const alertsKey = (month, ownerPubkey) => `alerts-${month}-${ownerPubkey}`;
export const devicesKey = (monitorPubkey) => `devices-${monitorPubkey}`;

/**
 * A key in someone else's namespace, to read it
 */
export const namespaced = (pubkey, key) => `:${pubkey}.${key}`;

/**
 * Check ids are unique per monitor: {channelId}/{checkId}
 */
export const checkRef = (channelId, checkId) => `${channelId}/${checkId}`;

/**
 * The month of a timestamp, as used in alert keys (UTC, YYYY-MM)
 */
export function monthOf(ts) {
  return new Date(ts).toISOString().slice(0, 7);
}

/**
 * The month before a YYYY-MM month
 */
export function previousMonth(month) {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 2, 1));
  return monthOf(date.getTime());
}

/**
 * Encrypts a value for the other side (NIP-44). The monitor and the owner
 * share the same conversation key, so both can decrypt it.
 * @param {{ nip44Encrypt(pubkey: string, text: string): Promise<string> }} signer
 */
export function encryptJson(signer, peerPubkey, value) {
  return signer.nip44Encrypt(peerPubkey, JSON.stringify(value));
}

/**
 * @param {{ nip44Decrypt(pubkey: string, payload: string): Promise<string> }} signer
 * @returns the value, or null if it can't be decrypted
 */
export async function decryptJson(signer, peerPubkey, payload) {
  if (typeof payload !== "string") return null;
  try {
    return JSON.parse(await signer.nip44Decrypt(peerPubkey, payload));
  } catch {
    return null;
  }
}

/**
 * Decrypts every value of a map (alerts, devices), skipping the ones that
 * can't be decrypted
 * @returns {Promise<Record<string, any>>}
 */
export async function decryptMap(signer, peerPubkey, map) {
  const entries = await Promise.all(
    Object.entries(map || {}).map(async ([key, payload]) => [
      key,
      await decryptJson(signer, peerPubkey, payload),
    ])
  );
  return Object.fromEntries(entries.filter(([, value]) => value !== null));
}

/**
 * Whether a device wants notifications from a channel
 * @param {Device} device
 */
export function deviceWantsChannel(device, channelId) {
  return !!device?.subscription && device.channels.includes(channelId);
}
