import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAuxiliaryCustomAgentPatchOperation,
  runAuxiliaryCustomAgentSelectionOperation,
} from "../../src/chat/auxiliary/auxiliary-custom-agent-operation.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

/** 変更点を必要なフィールドだけで指定できるよう、待機中のCopilot Auxiliaryを用意する。 */
function makeAuxiliarySession(
  overrides: Partial<AuxiliarySession> = {},
): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    runState: "idle",
    title: "Auxiliary",
    provider: "copilot",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** 選択対象の有無・Provider・現在のエージェント名に応じた戻り値と操作順を検証する。 */
describe("runAuxiliaryCustomAgentSelectionOperation", () => {
  /** 対象Sessionがなければ、保存もピッカーの閉じ処理もせずにnoopを返す。 */
  it("active session がない場合は no-op", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: null,
        customAgentName: "planner",
        /** 対象不在なのに更新へ進んだ場合に検出できるよう、呼び出しを記録する。 */
        updateCustomAgent: async () => {
          events.push("update");
        },
        /** 対象不在でもピッカーが閉じられる回帰を検出する。 */
        closeAgentPicker: () => events.push("close"),
      }),
      "noop",
    );
    assert.deepEqual(events, []);
  });

  /** CodexのAuxiliaryでは、Copilot用の選択を行っても保存・閉じ処理が発生しない。 */
  it("provider が copilot でない場合は no-op", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: {
          provider: "codex",
          customAgentName: "",
        },
        customAgentName: "planner",
        /** Providerを取り違えて変更を保存した場合に呼び出しを記録する。 */
        updateCustomAgent: async () => {
          events.push("update");
        },
        /** Copilot以外でもピッカーが閉じられた場合を記録する。 */
        closeAgentPicker: () => events.push("close"),
      }),
      "noop",
    );
    assert.deepEqual(events, []);
  });

  /** 既に選択されている名前なら更新を省き、ピッカーだけを閉じてunchangedを返す。 */
  it("同じ custom agent の場合は picker close だけ行う", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: {
          provider: "copilot",
          customAgentName: "planner",
        },
        customAgentName: "planner",
        /** 同一の名前を不要に保存した場合を記録する。 */
        updateCustomAgent: async () => {
          events.push("update");
        },
        /** 同じ選択を確定したときに期待される閉じ操作を記録する。 */
        closeAgentPicker: () => events.push("close"),
      }),
      "unchanged",
    );
    assert.deepEqual(events, ["close"]);
  });

  /** 選択名が変わった場合は、新しい名前を保存へ渡してからピッカーを閉じる。 */
  it("custom agent が変わる場合は更新後に picker を閉じる", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: {
          provider: "copilot",
          customAgentName: "planner",
        },
        customAgentName: "reviewer",
        /** 更新引数の名前と、後続の閉じ処理に対する順序を記録する。 */
        updateCustomAgent: async (customAgentName) => {
          events.push(`update:${customAgentName}`);
        },
        /** ピッカーを閉じた時点を更新と同じ記録へ追加する。 */
        closeAgentPicker: () => events.push("close"),
      }),
      "updated",
    );
    assert.deepEqual(events, ["update:reviewer", "close"]);
  });
});

/** 選択結果を現在のAuxiliary状態に適用する更新レシピを検証する。 */
describe("runAuxiliaryCustomAgentPatchOperation", () => {
  /** 既存フィールドを保ちつつ、選択名と更新日時を差し替えるレシピがupdaterへ届く。 */
  it("custom agent patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession({
      customAgentName: "planner",
      updatedAt: "before",
    });
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryCustomAgentPatchOperation({
      customAgentName: "reviewer",
      /** 渡されたレシピを元のSessionに適用し、差し替え後の値を捕捉する。 */
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      /** 更新前と区別できる固定の時刻ラベルを返す。 */
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      customAgentName: "reviewer",
      updatedAt: "updated",
    });
  });
});
