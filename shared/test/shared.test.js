import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSecretKey,
  getPublicKey,
  getConversationKey,
  nip44Encrypt,
  nip44Decrypt,
} from "tool-db";
import { monthOf, previousMonth, encryptJson, decryptJson, decryptMap, deviceWantsChannel } from "../src/index.js";

// A signer with the same NIP-44 methods as tool-db's user adapters
function signer(secretKey) {
  return {
    nip44Encrypt: async (pubkey, text) => nip44Encrypt(text, getConversationKey(secretKey, pubkey)),
    nip44Decrypt: async (pubkey, payload) => nip44Decrypt(payload, getConversationKey(secretKey, pubkey)),
  };
}

test("months", () => {
  assert.equal(monthOf(Date.UTC(2026, 9, 18)), "2026-10");
  assert.equal(previousMonth("2026-10"), "2026-09");
  assert.equal(previousMonth("2026-01"), "2025-12");
});

test("monitor and owner can both decrypt, others can't", async () => {
  const monitorKey = generateSecretKey();
  const ownerKey = generateSecretKey();
  const strangerKey = generateSecretKey();
  const monitor = signer(monitorKey);
  const owner = signer(ownerKey);
  const stranger = signer(strangerKey);

  const payload = await encryptJson(monitor, getPublicKey(ownerKey), { hello: "phone" });
  assert.deepEqual(await decryptJson(owner, getPublicKey(monitorKey), payload), { hello: "phone" });

  const reply = await encryptJson(owner, getPublicKey(monitorKey), { hi: "monitor" });
  assert.deepEqual(await decryptJson(monitor, getPublicKey(ownerKey), reply), { hi: "monitor" });

  assert.equal(await decryptJson(stranger, getPublicKey(monitorKey), payload), null);
  assert.deepEqual(
    await decryptMap(owner, getPublicKey(monitorKey), { a: payload, b: "garbage" }),
    { a: { hello: "phone" } }
  );
});

test("devices only get channels they enabled, with a subscription", () => {
  const device = { subscription: { endpoint: "x" }, channels: ["infra"] };
  assert.equal(deviceWantsChannel(device, "infra"), true);
  assert.equal(deviceWantsChannel(device, "media"), false);
  assert.equal(deviceWantsChannel({ ...device, subscription: null }, "infra"), false);
});
