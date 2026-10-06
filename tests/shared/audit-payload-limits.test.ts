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
  // claim = "incremental raw collectorは多数itemを受けても順序・個別marker・最終omitted countを維持し、保持済みpayloadを再走査しない"
  // oracle = { type = "contract", ref = "docs/design/audit-log.md#表示とデータ保護" }
  // fault = "予算超過itemを保持し続ける、最終markerで押し出すitemを数えない、または最終生成で元payloadを再読む"
  // observable = "collectorのJSON長・item順序・truncation marker・omittedItemsとpayload getter呼出回数"
  // observation_boundary = "component-behavior"
  // scope = "incremental diagnostic raw retention"
  // lifecycle = "permanent"
  // impact = "長いturnでrawの保持が増え続け、省略数が不正になり終了処理も重くなる"
  // distinction = "既存の単一巨大item testと型検査はaggregate budgetと追加後の再走査を検出しない。固定入力のみで継続コストは小さい"
  // @end-test-value
  it("incremental rawはpayloadを再走査せず順序と省略数を維持する", () => {
    const collector = new BoundedAuditRawItems(2048);
    let reads = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const data = { get content() { reads += 1; return "あ😀\"\n".repeat(64); } };
      collector.append({ type: `event-${index}`, data });
      Object.defineProperty(data, "content", { get() { throw new Error("retained source was revisited"); } });
    }
    const readsAfterAppend = reads;
    assert.ok(readsAfterAppend > 0);
    const json = collector.stringify();
    assert.equal(collector.stringify(), json);
    assert.equal(reads, readsAfterAppend);
    assert.ok(json.length <= 2048);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed.slice(0, -1).map((item: { type: string }) => item.type),
      Array.from({ length: 7 }, (_, index) => `event-${index}`));
    assert.equal(parsed[0].data.content, "あ😀\"\n".repeat(64));
    assert.equal(parsed[1].data.content.truncated, true);
    assert.equal(parsed[1].data.content.originalLength, 320);
    assert.equal(parsed[1].data.withmateTruncated.type, "withmate.value_truncated");
    assert.deepEqual(parsed[2].data.withmateTruncated, {
      type: "withmate.value_truncated", truncated: true, reason: "audit raw item budget exceeded", maxLength: 0,
    });
    assert.deepEqual(parsed.at(-1), {
      type: "withmate.raw_items_truncated", data: { omittedItems: 9993, maxLength: 2048 },
    });
  });

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

    const json = trace.stringify();
    assert.ok(json.length <= AUDIT_RAW_ITEMS_JSON_LIMIT);
    const parsed = JSON.parse(json);
    const marker = parsed.at(-1);
    assert.equal(parsed[0].data.index, 0);
    assert.equal(parsed[0].data.payload, payload);
    assert.equal(marker.type, "withmate.raw_items_truncated");
    assert.equal(marker.data.omittedItems, eventCount - (parsed.length - 1));
    assert.equal(marker.data.maxLength, AUDIT_RAW_ITEMS_JSON_LIMIT);
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
