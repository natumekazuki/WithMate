import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeCodexTokenUsage,
  normalizeCopilotTokenUsage,
} from "../../src-electron/providers/provider-token-usage.js";

/** Codex と Copilot の使用量を、共通のトークン内訳と合計に揃える契約を検証する。 */
describe("provider token usage", () => {
  /** キャッシュ済み入力や推論出力を内訳に残し、合計には入出力を一度ずつ計上する。 */
  it("Codex usage を共通形式へ正規化する", () => {
    assert.deepEqual(
      normalizeCodexTokenUsage({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 25,
        reasoning_output_tokens: 5,
      }),
      {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        totalTokens: 125,
      },
    );
  });

  /** Copilot のキャッシュ読み取り数を共通のキャッシュ済み入力へ割り当て、入出力から合計を補う。 */
  it("Copilot assistant.usage を共通形式へ正規化する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 80,
        cacheReadTokens: 12,
        outputTokens: 20,
      }),
      {
        inputTokens: 80,
        cachedInputTokens: 12,
        outputTokens: 20,
        totalTokens: 100,
      },
    );
  });

  /** 空の通知と使用量自体がない通知を、実測値のゼロと区別する。 */
  it("usage event に token 情報がない場合は null にする", () => {
    assert.equal(normalizeCodexTokenUsage({}), null);
    assert.equal(normalizeCopilotTokenUsage({}), null);
    assert.equal(normalizeCodexTokenUsage(null), null);
    assert.equal(normalizeCopilotTokenUsage(null), null);
  });

  /** 両方のキャッシュ欄があるときは共通名の値を優先し、明示された合計を再計算しない。 */
  it("Copilot の新旧 cache token field を受け取れる", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 10,
        cachedInputTokens: 3,
        cacheReadTokens: 1,
        outputTokens: 2,
        totalTokens: 15,
      }),
      {
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 2,
        totalTokens: 15,
      },
    );
  });

  /** 旧名の推論数を出力の内訳として保持し、未通知のキャッシュ入力数をゼロにする。 */
  it("Copilot の reasoningTokens を共通 reasoningOutputTokens に正規化する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 30,
        outputTokens: 7,
        reasoningTokens: 4,
      }),
      {
        inputTokens: 30,
        cachedInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 4,
        totalTokens: 37,
      },
    );
  });

  /** 旧名のキャッシュ読み取り数と推論数を同時に通知しても、双方の内訳を保持する。 */
  it("Copilot の cacheReadTokens と reasoningTokens を同時に受け取っても reasoningTokens を正規化する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 30,
        cacheReadTokens: 12,
        outputTokens: 7,
        reasoningTokens: 4,
      }),
      {
        inputTokens: 30,
        cachedInputTokens: 12,
        outputTokens: 7,
        reasoningOutputTokens: 4,
        totalTokens: 37,
      },
    );
  });

  /** 旧名と共通名の推論欄が併記されたときは、共通名の値を採用する。 */
  it("Copilot の reasoningOutputTokens がある場合は reasoningTokens より優先する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 30,
        outputTokens: 7,
        reasoningTokens: 4,
        reasoningOutputTokens: 9,
      }),
      {
        inputTokens: 30,
        cachedInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 9,
        totalTokens: 37,
      },
    );
  });
});
