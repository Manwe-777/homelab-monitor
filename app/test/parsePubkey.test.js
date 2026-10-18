import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey, npubEncode, nsecEncode } from "tool-db";

// db.js imports the IndexedDB store, only its pure helper is tested here
const { parsePubkey } = await import("../src/lib/parsePubkey.js");

test("accepts what people paste", () => {
  const hex = getPublicKey(generateSecretKey());
  const npub = npubEncode(hex);
  for (const value of [
    npub,
    `  ${npub}\n`,
    "N" + npub.slice(1),
    npub.toUpperCase(),
    `nostr:${npub}`,
    `${npub.slice(0, 30)} ${npub.slice(30)}`,
    hex,
  ]) {
    assert.equal(parsePubkey(value), hex, value);
  }
});

test("explains what's wrong", () => {
  const npub = npubEncode(getPublicKey(generateSecretKey()));
  assert.throws(() => parsePubkey(nsecEncode(generateSecretKey())), /secret key/);
  assert.throws(() => parsePubkey("hello"), /starts with npub1/);
  assert.throws(() => parsePubkey(npub.slice(0, -1) + (npub.at(-1) === "q" ? "p" : "q")), /typo/);
});
