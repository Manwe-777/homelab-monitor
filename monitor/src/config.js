import { readFileSync } from "node:fs";
import YAML from "yaml";
import { npubDecode } from "tool-db";
import { DEFAULT_RELAYS } from "@homelab-monitor/shared";
import { CHECK_TYPES } from "./checks/index.js";
import { parseDuration } from "./checks/heartbeat.js";

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Every owner gets their own encrypted copy of everything the monitor writes
export const MAX_OWNERS = 3;

function parseOwners(owner) {
  const list = Array.isArray(owner) ? owner : [owner];
  const owners = [
    ...new Set(
      list.map((entry) => {
        const text = String(entry ?? "").trim();
        let hex = text;
        try {
          if (text.startsWith("npub1")) hex = npubDecode(text);
        } catch {
          // Reported below
        }
        if (!/^[0-9a-f]{64}$/.test(hex)) {
          throw new Error(`config: \`owner\` must be your npub (or hex public key), not "${text}"`);
        }
        return hex;
      })
    ),
  ];
  if (owners.length > MAX_OWNERS) {
    throw new Error(`config: \`owner\` can list up to ${MAX_OWNERS} npubs`);
  }
  return owners;
}

/**
 * Loads and validates the monitor config
 * @returns the config with defaults applied, ids on every channel and check
 */
export function loadConfig(path) {
  const raw = YAML.parse(readFileSync(path, "utf8")) || {};

  const defaults = {
    intervalMs: (raw.interval ?? 60) * 1000,
    timeoutMs: (raw.timeout ?? 10) * 1000,
    failuresBeforeAlert: raw.failuresBeforeAlert ?? 2,
  };

  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new Error("config: add at least one channel under `channels`");
  }

  const channelIds = new Set();
  const channels = raw.channels.map((channel, i) => {
    const id = slug(channel.id || channel.name || "");
    if (!id) throw new Error(`config: channel ${i + 1} needs a name`);
    if (channelIds.has(id)) throw new Error(`config: duplicate channel "${id}"`);
    channelIds.add(id);

    const checkIds = new Set();
    const checks = (channel.checks || []).map((check, j) => {
      const where = `channel "${id}", check ${j + 1}`;
      const type = CHECK_TYPES[check.type];
      if (!type) {
        throw new Error(`config: ${where} has unknown type "${check.type}" (use ${Object.keys(CHECK_TYPES).join(", ")})`);
      }
      for (const field of type.required) {
        if (check[field] === undefined) throw new Error(`config: ${where} needs \`${field}\``);
      }

      const checkId = slug(check.id || check.name || type.target(check));
      if (checkIds.has(checkId)) throw new Error(`config: ${where} duplicates id "${checkId}"`);
      checkIds.add(checkId);

      const heartbeat = check.type === "heartbeat";
      let durations = {};
      try {
        if (heartbeat) {
          durations = { everyMs: parseDuration(check.every), graceMs: parseDuration(check.grace ?? "1h") };
        } else if (check.type === "event") {
          durations = { cooldownMs: parseDuration(check.cooldown ?? "1m") };
        }
      } catch (err) {
        throw new Error(`config: ${where}: ${err.message}`);
      }

      return {
        ...check,
        ...durations,
        id: checkId,
        name: check.name || type.target(check),
        intervalMs: check.interval ? check.interval * 1000 : defaults.intervalMs,
        timeoutMs: check.timeout ? check.timeout * 1000 : defaults.timeoutMs,
        // A missed heartbeat window is already definitive
        failuresBeforeAlert: check.failuresBeforeAlert ?? (heartbeat ? 1 : defaults.failuresBeforeAlert),
      };
    });

    // Channels with `public: false` are left out of the status page
    return { id, name: channel.name || id, public: channel.public !== false, checks };
  });

  const reported = channels.flatMap((c) => c.checks).find((check) => ["heartbeat", "event"].includes(check.type));
  if (raw.statusPage === false && reported) {
    throw new Error(`config: ${reported.type} checks are reported to the status page server, don't turn it off`);
  }

  return {
    name: raw.name || "Homelab",
    owners: parseOwners(raw.owner),
    relays: raw.relays || DEFAULT_RELAYS,
    vapidSubject: raw.vapidSubject || "mailto:monitor@homelab.local",
    // Where the app is hosted, for pairing links
    appUrl: raw.appUrl || "https://manwe-777.github.io/homelab-monitor/",
    heartbeatMs: (raw.heartbeat ?? 300) * 1000,
    // On by default, `statusPage: false` turns it off
    statusPage:
      raw.statusPage === false
        ? null
        : {
            port: raw.statusPage?.port ?? 3001,
            // The Docker image sets STATUS_PAGE_HOST=0.0.0.0
            host: raw.statusPage?.host ?? process.env.STATUS_PAGE_HOST ?? "127.0.0.1",
            title: raw.statusPage?.title || null,
            showTargets: raw.statusPage?.showTargets === true,
          },
    channels,
  };
}
