import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryRegistrationInput, MEMORY_REGISTRATION_PRESETS, type MemoryRegistrationScope } from "../../src-shared/memory-recording/memory-registration-input.js";

// @test-value v2
// kind = "contract"
// claim = "未設定本文だけにpresetを使い、空文字列を含む編集本文を置換として扱い実行情報と分離する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#登録指示のプリセットと本文編集" }
// fault = "編集本文へ固定方針を混ぜるか、空の設定を未設定としてpresetへ戻す"
// observable = "組立てた指示本文の完全一致と実行情報・材料・tool説明の各節"
// observation_boundary = "consumer"
// scope = "Memory purpose input consumed as BackgroundCallService userInput"
// lifecycle = "permanent"
// distinction = "同一Agentの実登録testでは空の設定と入力全体の非混在を網羅しない。LLMの文言遵守ではなく合成契約を検証する"
// @end-test-value
test("二用途の編集本文をpresetへ重ねず実行情報から分離する", () => {
  for (const purpose of ["character-memory", "target-memory"] as const) {
    const scope: MemoryRegistrationScope = { purpose, processing: { afterTurnId: 1, throughTurnId: 3 },
      history: { source: { kind: "main", sessionId: "main", incarnationId: "inc", ownerIdentity: "owner" }, fromMessageSeq: 2, throughMessageSeq: 5 },
      memoryTargets: [{ owner: "user", scope: "global" }] };
    for (const instructionText of [undefined, "サブエージェントを使わない。", "", "  edited\ntext  "] as const) {
      const value = buildMemoryRegistrationInput({ scope, materials: "saved material", instructionText });
      assert.equal(value, ["# 登録指示本文", instructionText ?? MEMORY_REGISTRATION_PRESETS[purpose],
        "# 実行情報（アプリが確定した読取・登録範囲）", JSON.stringify({ purpose, processing: scope.processing,
          history: { fromMessageSeq: 2, throughMessageSeq: 5 }, memoryTargets: scope.memoryTargets }),
        "# 参照材料", "saved material", "# 接続済み操作の利用情報",
        `MCP: ${purpose === "character-memory" ? "character_memory.append_episode" : "memory.append"}。入力項目は公開tool schemaを参照。identityと登録先上限はruntime bindingから解決される。`,
        `CLI: withmate-memory ${purpose === "character-memory" ? "character-memory-append-episode" : "append"} --json '<toolと同じ公開入力JSON>'。接続方法は実行環境の既存CLI設定を使う。`,
      ].join("\n\n"));
      if (instructionText !== undefined) for (const preset of Object.values(MEMORY_REGISTRATION_PRESETS)) {
        assert.equal(value.includes(preset), false);
      }
    }
  }
});
