import { createHmac } from "node:crypto";

export function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Parses "30m", "26h", "7d" or a number of seconds
 * @returns milliseconds
 */
export function parseDuration(value) {
  if (typeof value === "number") return value * 1000;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match) throw new Error(`"${value}" isn't a duration (use 30m, 26h, 7d...)`);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return Number(match[1]) * unit;
}

/**
 * The secret part of a heartbeat URL, derived from the monitor's key so it
 * never has to be stored in the config
 */
export function heartbeatToken(secretKey, ref) {
  return createHmac("sha256", secretKey).update(`heartbeat:${ref}`).digest("hex").slice(0, 32);
}

/**
 * Heartbeat check: a scheduled job reported in time.
 *   every: 1d      how often the job runs
 *   grace: 3h      how late it may be (default 1h)
 * The job calls its heartbeat URL when it ends (see `homelab-monitor heartbeats`).
 * @param context.beat the last report: { at, ok, message }
 * @param context.waitingSince when we started waiting for a first report
 */
export function checkHeartbeat(check, { beat, waitingSince, now = Date.now() } = {}) {
  const window = check.everyMs + check.graceMs;

  if (!beat) {
    if (now - waitingSince <= window) return { pending: true, message: "Waiting for the first run" };
    return { ok: false, message: `No run reported in ${formatDuration(now - waitingSince)}` };
  }
  if (!beat.ok) return { ok: false, message: `Last run failed${beat.message ? `: ${beat.message}` : ""}` };
  if (now - beat.at > window) return { ok: false, message: `Last run ${formatDuration(now - beat.at)} ago, expected every ${formatDuration(check.everyMs)}` };
  return { ok: true, message: `Last run ${formatDuration(now - beat.at)} ago` };
}
