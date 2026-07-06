import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decryptMemoryProtectedObjectPayload,
  encryptMemoryProtectedObjectPayload,
  MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM,
  sha256Hex,
  type MemoryProtectedObjectKey,
} from "../../src-electron/memory-protected-object-crypto.js";

function key(byte: number, keyId = "test-key"): MemoryProtectedObjectKey {
  return {
    keyId,
    key: Buffer.alloc(32, byte),
  };
}

describe("Memory Protected Object crypto", () => {
  it("AES-GCM envelopeで暗号化し、同じAADとkeyで復号できる", () => {
    const plaintext = Buffer.from("protected screenshot bytes");
    const aad = Buffer.from("entry:mem-1/object:obj-1");
    const result = encryptMemoryProtectedObjectPayload({
      plaintext,
      key: key(1, "key-1"),
      aad,
    });

    assert.equal(result.algorithm, MEMORY_PROTECTED_OBJECT_ENCRYPTION_ALGORITHM);
    assert.equal(result.keyId, "key-1");
    assert.equal(result.storedBytes, result.encryptedPayload.byteLength);
    assert.equal(result.sha256, sha256Hex(result.encryptedPayload));
    assert.notDeepEqual(result.encryptedPayload, plaintext);
    assert.deepEqual(
      decryptMemoryProtectedObjectPayload({
        encryptedPayload: result.encryptedPayload,
        key: key(1, "key-1"),
        aad,
      }),
      plaintext,
    );
  });

  it("同じplaintextでもnonceによりencrypted payloadが変わる", () => {
    const plaintext = Buffer.from("same file bytes");
    const first = encryptMemoryProtectedObjectPayload({ plaintext, key: key(2) });
    const second = encryptMemoryProtectedObjectPayload({ plaintext, key: key(2) });

    assert.notDeepEqual(first.encryptedPayload, second.encryptedPayload);
    assert.notEqual(first.sha256, second.sha256);
    assert.deepEqual(
      decryptMemoryProtectedObjectPayload({ encryptedPayload: first.encryptedPayload, key: key(2) }),
      plaintext,
    );
    assert.deepEqual(
      decryptMemoryProtectedObjectPayload({ encryptedPayload: second.encryptedPayload, key: key(2) }),
      plaintext,
    );
  });

  it("keyまたはAADが違う場合は復号に失敗する", () => {
    const encrypted = encryptMemoryProtectedObjectPayload({
      plaintext: Buffer.from("secret"),
      key: key(3),
      aad: Buffer.from("entry:mem-1"),
    });

    assert.throws(
      () =>
        decryptMemoryProtectedObjectPayload({
          encryptedPayload: encrypted.encryptedPayload,
          key: key(4),
          aad: Buffer.from("entry:mem-1"),
        }),
      /Unsupported state|authenticate|bad decrypt/i,
    );
    assert.throws(
      () =>
        decryptMemoryProtectedObjectPayload({
          encryptedPayload: encrypted.encryptedPayload,
          key: key(3),
          aad: Buffer.from("entry:mem-2"),
        }),
      /Unsupported state|authenticate|bad decrypt/i,
    );
  });

  it("壊れたenvelopeと改ざんされたciphertextを拒否する", () => {
    assert.throws(
      () => decryptMemoryProtectedObjectPayload({ encryptedPayload: Buffer.from("short"), key: key(5) }),
      /too short/,
    );

    const encrypted = encryptMemoryProtectedObjectPayload({
      plaintext: Buffer.from("payload"),
      key: key(5),
    });
    const corrupted = Buffer.from(encrypted.encryptedPayload);
    corrupted[0] = 0x00;

    assert.throws(
      () => decryptMemoryProtectedObjectPayload({ encryptedPayload: corrupted, key: key(5) }),
      /invalid/,
    );

    const tampered = Buffer.from(encrypted.encryptedPayload);
    tampered[tampered.length - 1] ^= 0xff;

    assert.throws(
      () => decryptMemoryProtectedObjectPayload({ encryptedPayload: tampered, key: key(5) }),
      /Unsupported state|authenticate|bad decrypt/i,
    );
  });

  it("32 bytes以外のkeyと空のkey idを拒否する", () => {
    assert.throws(
      () =>
        encryptMemoryProtectedObjectPayload({
          plaintext: Buffer.from("payload"),
          key: { keyId: "short", key: Buffer.alloc(31) },
        }),
      /32 bytes/,
    );
    assert.throws(
      () =>
        encryptMemoryProtectedObjectPayload({
          plaintext: Buffer.from("payload"),
          key: { keyId: "   ", key: Buffer.alloc(32) },
        }),
      /key id/,
    );
  });
});
