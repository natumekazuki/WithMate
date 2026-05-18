import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundAuditRawItem,
  stringifyBoundedAuditRawItems,
  stringifyBoundedAuditValue,
} from "../../src-electron/audit-payload-limits.js";

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

  it("raw item の pre-clone でも巨大配列を map せず予算で打ち切る", () => {
    const chunks = Array.from({ length: 20_000 }, (_, index) => ({
      type: "output_text",
      text: `chunk-${index}-${"x".repeat(128)}`,
    }));
    Object.defineProperty(chunks, "map", {
      value() {
        throw new Error("raw item array should not be fully mapped");
      },
    });

    const item = boundAuditRawItem({
      type: "mcp_tool_call",
      data: {
        result: {
          content: chunks,
        },
      },
    }, 4096);
    const json = JSON.stringify(item);

    assert.equal(json.length <= 4096, true);
    assert.equal(json.includes("chunk-19999"), false);
    assert.equal(json.includes("withmate.value_truncated"), true);
  });

  it("details 用 stringify も巨大 object を直接 stringify しない", () => {
    const chunks = Array.from({ length: 20_000 }, (_, index) => ({
      type: "output_text",
      text: `chunk-${index}-${"x".repeat(128)}`,
    }));
    const value = {
      structured_content: chunks,
      toJSON() {
        throw new Error("details value should not be stringified directly");
      },
    };

    const details = stringifyBoundedAuditValue(value, 4096);

    assert.ok(details);
    assert.equal(details.length <= 4096, true);
    assert.equal(details.includes("chunk-19999"), false);
    assert.equal(details.includes("withmate.value_truncated"), true);
  });
});
