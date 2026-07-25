import assert from "node:assert/strict";

import { CODEX_ADAPTER_LIMITS } from "../src/main/providers/codex/index.js";

export function assertBoundedPublicSummary(summary: string, omittedValues: readonly string[] = []): void {
  assert.ok(summary.trim().length > 0);
  assert.ok(Buffer.byteLength(summary, "utf8") <= CODEX_ADAPTER_LIMITS.maxShortStringBytes);
  for (const omittedValue of omittedValues) {
    assert.equal(summary.includes(omittedValue), false);
  }
}
