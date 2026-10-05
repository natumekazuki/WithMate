import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIT_RAW_ITEMS_JSON_LIMIT,
  BoundedAuditRawItems,
  boundAuditRawItem,
  stringifyBoundedAuditRawItems,
  stringifyBoundedAuditValue,
} from "../../src-electron/session/audit-payload-limits.js";

describe("audit payload limits", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "raw traceはappend中も既存512Ki JSON予算内に収まり、超過件数を最終JSONに明示する"
  // oracle = { type = "contract", ref = "docs/design/audit-log.md: commandの監査用本文とstable raw traceの保持予算" }
  // fault = "item単体だけを制限し、turn全体のraw traceを上限なく保持する"
  // observable = "append後の保持traceのJSON長と最終JSONのtruncation marker・omittedItems・先頭payload"
  // observation_boundary = "component-behavior"
  // scope = "audit-raw-trace-owner"
  // lifecycle = "permanent"
  // impact = "長いturnのMain heap増加とterminal時の全文trace cloneを抑え、監査の打切りを利用者へ残す"
  // distinction = "既存の単一item・最終serializer試験ではappend ownerの総保持量を検出しない"
  // @end-test-value
  it("raw traceのappend ownerを総予算で制限し打切り件数を保存する", () => {
    const trace = new BoundedAuditRawItems();
    const eventCount = 128;
    const payload = "x".repeat(64 * 1024);
    for (let index = 0; index < eventCount; index += 1) {
      trace.append({ type: "tool.execution_complete", data: { index, payload } });
    }

    assert.ok(JSON.stringify(trace.items).length <= AUDIT_RAW_ITEMS_JSON_LIMIT);
    const json = stringifyBoundedAuditRawItems(trace.items);
    assert.ok(json.length <= AUDIT_RAW_ITEMS_JSON_LIMIT);
    const parsed = JSON.parse(json);
    const marker = parsed.at(-1);
    assert.equal(parsed[0].data.index, 0);
    assert.equal(parsed[0].data.payload, payload);
    assert.equal(marker.type, "withmate.raw_items_truncated");
    assert.equal(marker.data.omittedItems, eventCount - (parsed.length - 1));
    assert.equal(marker.data.maxLength, AUDIT_RAW_ITEMS_JSON_LIMIT);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "小さいraw eventが多数続いても順序付きprefixと単一の正確な打切りmarkerを予算内で保持する"
  // oracle = { type = "contract", ref = "docs/design/audit-log.md: stable raw traceのappend予算と超過件数の明示" }
  // fault = "本文が小さいeventを無制限に追加するか、打切りmarker自体をeventごとに増やす"
  // observable = "保持traceのJSON長、event順序、marker個数、omittedItems"
  // observation_boundary = "component-behavior"
  // scope = "audit-raw-trace-owner"
  // lifecycle = "permanent"
  // impact = "event数に比例する無界保持を防ぎ、保存された監査prefixの順序と欠落件数を維持する"
  // distinction = "大きいpayloadだけの試験では、多数の小eventと繰返し打切りの経路を区別できない"
  // @end-test-value
  it("小eventも総予算で制限し打切り後にmarkerを増殖させない", () => {
    const limit = 4096;
    const trace = new BoundedAuditRawItems(limit);
    const eventCount = 10_000;
    for (let sequence = 0; sequence < eventCount; sequence += 1) {
      trace.append({ type: "session.event", data: { sequence } });
    }

    assert.ok(JSON.stringify(trace.items).length <= limit);
    const retained = trace.items.filter((item) => item.type === "session.event");
    assert.ok(retained.length > 0);
    assert.deepEqual(retained.map((item) => item.data?.sequence), retained.map((_, index) => index));
    const markers = trace.items.filter((item) => item.type === "withmate.raw_items_truncated");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].data?.omittedItems, eventCount - retained.length);
    const parsed = JSON.parse(stringifyBoundedAuditRawItems(trace.items, limit));
    assert.equal(parsed.at(-1).data.omittedItems, eventCount - retained.length);
  });

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
