import assert from "node:assert/strict";
import test from "node:test";

import { MESSAGE_CONTENT_LIMITS, snapshotMessageContentBlocks } from "../src/shared/message-content.js";

test("Message content accepts and snapshots exact dense text blocks", () => {
  const source = [
    { type: "text", text: "hello" },
    Object.assign(Object.create(null) as Record<string, unknown>, { type: "text", text: "world" }),
  ];
  const snapshot = snapshotMessageContentBlocks(source);
  assert.deepEqual(snapshot, [
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ]);
  source[0]!.text = "changed";
  assert.equal(snapshot?.[0]?.text, "hello");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot?.[0]), true);
  assert.deepEqual(snapshotMessageContentBlocks([]), []);
});

test("Message content rejects sparse arrays and non-text block shapes", () => {
  const sparse = new Array(1);
  const inherited = Object.create({ type: "text", text: "inherited" }) as Record<string, unknown>;
  const accessor = Object.defineProperties(
    {},
    {
      type: { enumerable: true, value: "text" },
      text: { enumerable: true, get: () => "accessor" },
    },
  );
  for (const value of [
    sparse,
    [{ type: "text" }],
    [{ type: "text", text: 1 }],
    [{ type: "tool", text: "result" }],
    [{ type: "text", text: "hello", extra: true }],
    [inherited],
    [accessor],
  ]) {
    assert.equal(snapshotMessageContentBlocks(value), undefined);
  }
});

test("Message content enforces the exact UTF-8 JSON byte ceiling", () => {
  const emptyJsonBytes = new TextEncoder().encode(JSON.stringify([{ type: "text", text: "" }])).byteLength;
  const exactText = "x".repeat(MESSAGE_CONTENT_LIMITS.maxJsonBytes - emptyJsonBytes);
  const exact = snapshotMessageContentBlocks([{ type: "text", text: exactText }]);
  assert.equal(exact?.[0]?.text.length, exactText.length);
  assert.equal(snapshotMessageContentBlocks([{ type: "text", text: `${exactText}x` }]), undefined);
});

test("Message content enforces the exact block count ceiling", () => {
  const exact = Array.from({ length: MESSAGE_CONTENT_LIMITS.maxBlocks }, () => ({ type: "text", text: "" }));
  assert.equal(snapshotMessageContentBlocks(exact)?.length, MESSAGE_CONTENT_LIMITS.maxBlocks);
  exact.push({ type: "text", text: "" });
  assert.equal(snapshotMessageContentBlocks(exact), undefined);
});
