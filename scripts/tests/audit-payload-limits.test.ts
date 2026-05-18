import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stringifyBoundedAuditRawItems } from "../../src-electron/audit-payload-limits.js";

describe("audit payload limits", () => {
  it("raw item 全体を stringify する前に item 内の巨大配列を予算で打ち切る", () => {
    const chunks = Array.from({ length: 20_000 }, (_, index) => ({
      type: "output_text",
      text: `chunk-${index}-${"x".repeat(128)}`,
    }));
    const rawItem = {
      type: "response.completed",
      data: {
        result: {
          content: chunks,
        },
      },
      toJSON() {
        throw new Error("raw item should not be stringified directly");
      },
    };

    const json = stringifyBoundedAuditRawItems([rawItem], 4096);
    const parsed = JSON.parse(json);

    assert.equal(json.length <= 4096, true);
    assert.equal(parsed[0]?.type, "response.completed");
    assert.equal(json.includes("chunk-19999"), false);
    assert.equal(json.includes("withmate.value_truncated"), true);
  });
});
