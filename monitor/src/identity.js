import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateSecretKey, getPublicKey, nsecEncode, normalizeSecretKey } from "tool-db";
import webpush from "web-push";

function readOrCreate(path, create) {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = create();
  writeFileSync(path, value + "\n", { mode: 0o600 });
  return value;
}

/**
 * The monitor's own identity, created on first run and kept in the data dir:
 *   monitor.key   its Nostr secret key (nsec)
 *   vapid.json    its Web Push (VAPID) keys
 *   heartbeat.key the secret heartbeat URLs are derived from. Delete it and
 *                 restart to rotate every heartbeat URL.
 */
export function loadIdentity(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return loadKeys(dataDir);
  } catch (err) {
    if (err.code !== "EACCES") throw err;
    throw new Error(
      `Can't write to the data directory ${dataDir}. In Docker the monitor runs as uid 1000: ` +
        `create the directory first, or chown 1000:1000 it on the host.`
    );
  }
}

function loadKeys(dataDir) {
  const nsec = readOrCreate(join(dataDir, "monitor.key"), () => nsecEncode(generateSecretKey()));
  const secretKey = normalizeSecretKey(nsec);

  const vapid = JSON.parse(
    readOrCreate(join(dataDir, "vapid.json"), () => JSON.stringify(webpush.generateVAPIDKeys()))
  );

  const heartbeatKey = readOrCreate(join(dataDir, "heartbeat.key"), () => randomBytes(32).toString("hex"));

  return { secretKey, pubkey: getPublicKey(secretKey), vapid, heartbeatKey };
}
