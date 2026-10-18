import { readFileSync } from "node:fs";
import YAML from "yaml";
import { npubDecode } from "tool-db";
import { DEFAULT_RELAYS } from "@homelab-monitor/shared";
import { CHECK_TYPES } from "./checks/index.js";

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function parseOwner(owner) {
  const hex = owner?.startsWith("npub1") ? npubDecode(owner) : owner;
  if (!/^[0-9a-f]{64}$/.test(hex || "")) {
    throw new Error("config: `owner` must be your npub (or hex public key)");
  }
  return hex;
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

      return {
        ...check,
        id: checkId,
        name: check.name || type.target(check),
        intervalMs: check.interval ? check.interval * 1000 : defaults.intervalMs,
        timeoutMs: check.timeout ? check.timeout * 1000 : defaults.timeoutMs,
        failuresBeforeAlert: check.failuresBeforeAlert ?? defaults.failuresBeforeAlert,
      };
    });

    // Channels with `public: false` are left out of the status page
    return { id, name: channel.name || id, public: channel.public !== false, checks };
  });

  return {
    name: raw.name || "Homelab",
    owner: parseOwner(raw.owner),
    relays: raw.relays || DEFAULT_RELAYS,
    vapidSubject: raw.vapidSubject || "mailto:monitor@homelab.local",
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
