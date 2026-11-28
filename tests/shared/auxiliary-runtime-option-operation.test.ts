import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../../src/chat/auxiliary/auxiliary-runtime-option-operation.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["low", "medium"],
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      reasoningEfforts: ["medium", "high"],
    },
  ],
};

/** 既定の Codex モデル・承認・Sandbox を持つ待機中の Auxiliary を作る。ケースごとに比較対象の値を上書きできる。 */
function makeAuxiliarySession(
  overrides: Partial<AuxiliarySession> = {},
): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
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

/** Auxiliary の承認変更が他の設定に波及しないよう、更新関数へ渡す差分を確認する。 */
describe("runAuxiliaryApprovalModeChangeOperation", () => {
  /** untrusted から never へ切り替えると、承認方針と更新時刻だけが変わる。 */
  it("approval mode patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryApprovalModeChangeOperation({
      approvalMode: "never",
      /** 更新レシピを選択中の Auxiliary に適用し、永続化を通さず承認変更の結果を取得する。 */
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      /** 承認を切り替えた時刻が更新後のレコードに使われるよう、時刻値を固定する。 */
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      approvalMode: "never",
      updatedAt: "updated",
    });
  });
});

/** Auxiliary の Sandbox 選択を、対象 Session への更新レシピとして確かめる。 */
describe("runAuxiliarySandboxModeChangeOperation", () => {
  /** workspace-write から read-only への切替で、承認やモデルを変えず Sandbox と更新時刻だけを反映する。 */
  it("sandbox mode patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliarySandboxModeChangeOperation({
      codexSandboxMode: "read-only",
      /** 選択中の Session に Sandbox の更新レシピを適用し、返された値を保持する。 */
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      /** Sandbox の変更による時刻更新を実時計ではなく固定値で観測する。 */
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      codexSandboxMode: "read-only",
      updatedAt: "updated",
    });
  });
});

/** モデル変更で、新モデルでも選べる深度が保たれることを確認する。 */
describe("runAuxiliaryModelChangeOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary model操作はmodelとDepthを対象updaterへ反映する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "変更が対象updaterへ渡らないか既存設定を消す"
  // observable = "updaterのAuxiliary Session patch"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-model-operation"
  // lifecycle = "permanent"
  // @end-test-value
  /** GPT-5.4 から GPT-5.5 に変えても共通の medium を保持し、他の設定を書き換えない。 */
  it("model selection patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryModelChangeOperation({
      model: providerCatalog.models[1]!,

      /** モデル変更で渡されたレシピを既存の Session に適用し、モデルと深度の組を観測する。 */
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      /** モデル変更後の updatedAt を、fixture の既存値と区別できる固定値にする。 */
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,

      model: "gpt-5.5",
      reasoningEffort: "medium",
      updatedAt: "updated",
    });
  });
});

/** 選択モデルに対応する深度が、そのモデルを変えず Auxiliary に反映されることを確認する。 */
describe("runAuxiliaryReasoningEffortChangeOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary Depth操作はmodelを維持して指定Depthを対象updaterへ反映する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "Depthを置換するか対象modelを変える"
  // observable = "updaterのAuxiliary Session patch"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-depth-operation"
  // lifecycle = "permanent"
  // @end-test-value
  /** GPT-5.5 の medium を high に変更し、同じモデルのまま深度と更新時刻だけを更新する。 */
  it("reasoning effort selection patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession({ model: "gpt-5.5" });
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryReasoningEffortChangeOperation({
      reasoningEffort: "high",
      providerCatalog,

      /** 現在のモデル情報を含む Session で深度更新レシピを実行し、更新後の値を取得する。 */
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      /** 深度の更新が返す時刻を決定的にし、レコードへの反映を比較できるようにする。 */
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,

      reasoningEffort: "high",
      updatedAt: "updated",
    });
  });
});
