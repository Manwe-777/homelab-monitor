import { createHmac } from "node:crypto";
import { formatDuration } from "./heartbeat.js";

/**
 * The secret part of an event URL, derived from the monitor's heartbeat key
 * like heartbeat tokens, but never equal to one
 */
export function eventToken(heartbeatKey, ref) {
  return createHmac("sha256", heartbeatKey).update(`event:${ref}`).digest("hex").slice(0, 32);
}

/**
 * The environment variable holding an event check's token, in events.env
 */
export const eventVariable = (ref) => `EVENT_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/**
 * events.env: every event token, for services to read instead of keeping
 * them in their own config
 */
export function eventsEnv(heartbeatKey, refs) {
  return [
    "# Written by homelab-monitor on start, do not edit. One token per event check:",
    "# the service POSTs to <monitor>/event/$VARIABLE when something happens.",
    ...refs.map((ref) => `${eventVariable(ref)}=${eventToken(heartbeatKey, ref)}`),
    "",
  ].join("\n");
}

const LIMITS = { title: 120, message: 500, url: 2000 };

/**
 * Validates what a service reports: { title?, message?, url? }
 * @returns the event, or throws with what's wrong
 */
export function parseEvent(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Send a JSON object: { title, message, url }");
  }
  const event = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new Error(`\`${field}\` must be a string`);
    event[field] = value.trim().slice(0, max);
  }
  if (event.url) {
    let url;
    try {
      url = new URL(event.url);
    } catch {
      throw new Error("`url` isn't a URL");
    }
    // Opened from the notification: never javascript: or data:
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("`url` must be http or https");
  }
  return event;
}

/**
 * Event check: something a service reports, sent as an alert as it happens
 * (a camera seeing motion, a door opening). There's no up or down: the
 * check only says when the last event came.
 *   cooldown: 5m   at most one alert this often (default 1m), the rest are counted
 * @param context.last the last event: { at, title, suppressed }
 */
export function checkEvent(check, { last, now = Date.now() } = {}) {
  if (!last) return { ok: true, message: "No events yet" };
  const ago = formatDuration(now - last.at);
  const quiet = last.suppressed ? `, ${last.suppressed} more during cooldown` : "";
  return { ok: true, message: `Last event ${ago} ago${last.title ? `: ${last.title}` : ""}${quiet}` };
}
