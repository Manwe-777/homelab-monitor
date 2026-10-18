import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 */
export function loadIdentity(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const nsec = readOrCreate(join(dataDir, "monitor.key"), () => nsecEncode(generateSecretKey()));
  const secretKey = normalizeSecretKey(nsec);

  const vapid = JSON.parse(
    readOrCreate(join(dataDir, "vapid.json"), () => JSON.stringify(webpush.generateVAPIDKeys()))
  );

  return { secretKey, pubkey: getPublicKey(secretKey), vapid };
}
