import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROVIDER_RAW_ITEMS_JSON_LIMIT,
  BoundedProviderRawItems,
  boundProviderRawItem,
  stringifyBoundedProviderRawItems,
  stringifyBoundedProviderValue,
} from "../../src-electron/session/provider-payload-limits.js";

describe("provider payload limits", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "incremental raw collectorは多数itemを受けても順序・個別marker・最終omitted countを維持し、保持済みpayloadを再走査しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "予算超過itemを保持し続ける、最終markerで押し出すitemを数えない、または最終生成で元payloadを再読む"
  // observable = "collectorのJSON長・item順序・truncation marker・omittedItemsとpayload getter呼出回数"
  // observation_boundary = "component-behavior"
  // scope = "incremental diagnostic raw retention"
  // lifecycle = "permanent"
  // impact = "診断rawの出力肥大化、省略数の誤表示、最終生成時の元payload再読取りを防ぐ。内部保持量は直接観測しない"
  // distinction = "単一巨大item testと型検査では確認できない複数itemの出力総予算・順序・省略数と元payloadの再読取りを固定入力で検証する"
  // @end-test-value
  it("incremental rawはpayloadを再走査せず順序と省略数を維持する", () => {
    const collector = new BoundedProviderRawItems(2048);
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
      type: "withmate.value_truncated", truncated: true, reason: "provider raw item budget exceeded", maxLength: 0,
    });
    assert.deepEqual(parsed.at(-1), {
      type: "withmate.raw_items_truncated", data: { omittedItems: 9993, maxLength: 2048 },
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "背景診断の最終raw JSONは既定512Ki予算内に収まり、先頭payloadと省略件数を保持する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "最終JSONが既定予算を超える、省略件数が残存item数と一致しない、または先頭payloadを壊す"
  // observable = "stringify返却JSONの長さ、先頭index/payload、truncation markerのomittedItems/maxLength"
  // observation_boundary = "component-behavior"
  // scope = "provider-diagnostic-trace-owner"
  // lifecycle = "permanent"
  // impact = "背景診断の過大な返却JSONと、省略件数の誤表示による診断情報の誤認を防ぐ"
  // distinction = "単一itemや小さいcustom予算のtestでは多数itemを集めた後の既定予算と省略件数の整合を検証しない"
  // @end-test-value
  it("raw traceのappend ownerを総予算で制限し打切り件数を保存する", () => {
    const trace = new BoundedProviderRawItems();
    const eventCount = 128;
    const payload = "x".repeat(64 * 1024);
    for (let index = 0; index < eventCount; index += 1) {
      trace.append({ type: "tool.execution_complete", data: { index, payload } });
    }

    const json = trace.stringify();
    assert.ok(json.length <= PROVIDER_RAW_ITEMS_JSON_LIMIT);
    const parsed = JSON.parse(json);
    const marker = parsed.at(-1);
    assert.equal(parsed[0].data.index, 0);
    assert.equal(parsed[0].data.payload, payload);
    assert.equal(marker.type, "withmate.raw_items_truncated");
    assert.equal(marker.data.omittedItems, eventCount - (parsed.length - 1));
    assert.equal(marker.data.maxLength, PROVIDER_RAW_ITEMS_JSON_LIMIT);
  });


  // @test-value v2
  // kind = "contract"
  // claim = "巨大なprovider診断値を指定予算内で省略し末尾の原文を保持しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "元payload全件を直接cloneまたはstringifyして巨大出力を保持する"
  // observable = "bound/stringify結果の長さ・末尾chunk不在・truncation marker"
  // observation_boundary = "component-behavior"
  // scope = "provider payload budget"
  // lifecycle = "permanent"
  // impact = "巨大なprovider出力による不要な保持を抑え取得済みpreviewを維持する"
  // distinction = "型検査では巨大・custom serialization payloadの実予算を確認できない"
  // @end-test-value
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

    const json = stringifyBoundedProviderRawItems([rawItem], 4096);
    const parsed = JSON.parse(json);

    assert.equal(json.length <= 4096, true);
    assert.equal(parsed[0]?.type, "response.completed");
    assert.equal(json.includes("chunk-19999"), false);
    assert.equal(json.includes("withmate.value_truncated"), true);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "巨大なprovider診断値を指定予算内で省略し末尾の原文を保持しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "元payload全件を直接cloneまたはstringifyして巨大出力を保持する"
  // observable = "bound/stringify結果の長さ・末尾chunk不在・truncation marker"
  // observation_boundary = "component-behavior"
  // scope = "provider payload budget"
  // lifecycle = "permanent"
  // impact = "巨大なprovider出力による不要な保持を抑え取得済みpreviewを維持する"
  // distinction = "型検査では巨大・custom serialization payloadの実予算を確認できない"
  // @end-test-value
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

    const item = boundProviderRawItem({
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

  // @test-value v2
  // kind = "contract"
  // claim = "巨大なprovider診断値を指定予算内で省略し末尾の原文を保持しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "元payload全件を直接cloneまたはstringifyして巨大出力を保持する"
  // observable = "bound/stringify結果の長さ・末尾chunk不在・truncation marker"
  // observation_boundary = "component-behavior"
  // scope = "provider payload budget"
  // lifecycle = "permanent"
  // impact = "巨大なprovider出力による不要な保持を抑え取得済みpreviewを維持する"
  // distinction = "型検査では巨大・custom serialization payloadの実予算を確認できない"
  // @end-test-value
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

    const details = stringifyBoundedProviderValue(value, 4096);

    assert.ok(details);
    assert.equal(details.length <= 4096, true);
    assert.equal(details.includes("chunk-19999"), false);
    assert.equal(details.includes("withmate.value_truncated"), true);
  });
});
