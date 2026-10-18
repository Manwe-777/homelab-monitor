import { npubDecode } from "tool-db";

/**
 * Accepts a public key as npub (with or without "nostr:", any case, with
 * stray spaces from copying) or hex, returns it as hex
 * @throws with a message that says what's wrong
 */
export function parsePubkey(value) {
  const cleaned = value.replace(/\s+/g, "").replace(/^nostr:/i, "").toLowerCase();

  if (cleaned.startsWith("nsec1")) {
    throw new Error("That's a secret key (nsec). Paste the monitor's npub instead");
  }
  if (/^[0-9a-f]{64}$/.test(cleaned)) return cleaned;
  if (!cleaned.startsWith("npub1")) {
    throw new Error("A monitor's npub starts with npub1");
  }
  try {
    return npubDecode(cleaned);
  } catch {
    throw new Error("That npub has a typo (its checksum doesn't match). Copy it again");
  }
}
