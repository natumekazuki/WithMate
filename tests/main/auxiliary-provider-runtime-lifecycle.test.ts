import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { updateAuxiliarySessionWithProviderRuntimeLifecycle } from "../../src-electron/auxiliary/auxiliary-provider-runtime-lifecycle.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

/** 同じ Auxiliary ID と親を使い、プロバイダーとモデルだけを切り替える初期状態を作る。 */
function createAuxiliarySession(provider: string): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    runState: "idle",
    title: "Auxiliary",
    provider,
    catalogRevision: 1,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4.5",
    reasoningEffort: "medium",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write-network",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

/** Auxiliary の更新で実行時バインディングとプロバイダー側のスレッドを破棄する条件を検証する。 */
describe("Auxiliary provider runtime lifecycle", () => {
  /** Codex から Copilot を経て Codex に戻しても、各旧バインディングは無効になり、旧プロバイダーへの無効化要求が順に発行される。 */
  it("providerをA→B→Aと変更しても旧bindingと旧provider clientを再利用しない", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    let current = createAuxiliarySession("codex");
    const invalidatedProviders: string[] = [];
    const firstCodexBinding = registry.issueOrReuse({
      actorSessionId: current.id,
      providerId: "codex",
      operationGrants: ["memory.search"],
    });

    /** 実バインディングレジストリと更新記録を使ってプロバイダーの変更を適用する。 */
    const update = (session: AuxiliarySession) =>
      updateAuxiliarySessionWithProviderRuntimeLifecycle({
        session,
        /** プロバイダーの切り替えを許可するため、実行中の処理はないと返す。 */
        isRunInFlight: () => false,
        /** 直前の更新で保持した Auxiliary を、次の切り替え時の比較元として返す。 */
        getAuxiliarySession: () => current,
        /** 切り替え後の状態を保持し、次回の更新で参照できるようにする。 */
        updateAuxiliarySession: (next) => {
          current = next;
          return next;
        },
        /** 旧バインディングを実レジストリで失効させ、参照の解決可否を検証できるようにする。 */
        revokeSessionAgentRuntimeBindings: (sessionId) =>
          registry.revokeSession(sessionId),
        /** 切り替え元のどのプロバイダーに無効化が要求されたかを記録する。 */
        invalidateProviderSessionThread: async (providerId) => {
          invalidatedProviders.push(providerId);
        },
      });

    await update(createAuxiliarySession("copilot"));
    assert.equal(
      registry.resolve(firstCodexBinding.bindingReference, "memory.search").ok,
      false,
    );
    const copilotBinding = registry.issueOrReuse({
      actorSessionId: current.id,
      providerId: "copilot",
      operationGrants: ["memory.search"],
    });

    await update(createAuxiliarySession("codex"));
    assert.equal(
      registry.resolve(copilotBinding.bindingReference, "memory.search").ok,
      false,
    );
    const nextCodexBinding = registry.issueOrReuse({
      actorSessionId: current.id,
      providerId: "codex",
      operationGrants: ["memory.search"],
    });
    assert.notEqual(
      nextCodexBinding.bindingReference,
      firstCodexBinding.bindingReference,
    );
    assert.deepEqual(invalidatedProviders, ["codex", "copilot"]);
  });

  /** タイトルだけの変更は保存されるが、実行先が変わらないためバインディング失効もスレッド無効化も要求しない。 */
  it("runtime identityが変わらない更新ではbindingとclientを維持する", async () => {
    let current = createAuxiliarySession("codex");
    let revoked = false;
    let invalidated = false;
    const updated = await updateAuxiliarySessionWithProviderRuntimeLifecycle({
      session: { ...current, title: "Renamed" },
      /** タイトル変更を実行中ではない条件で試す。 */
      isRunInFlight: () => false,
      /** 名前変更前の実行先とタイトルを持つ状態を返す。 */
      getAuxiliarySession: () => current,
      /** 更新を保持し、変更後のタイトルを返す。 */
      updateAuxiliarySession: (next) => {
        current = next;
        return next;
      },
      /** タイトル変更だけで失効を試みた場合に検出する。 */
      revokeSessionAgentRuntimeBindings: () => {
        revoked = true;
      },
      /** タイトル変更だけでプロバイダー側のスレッド破棄を試みた場合に検出する。 */
      invalidateProviderSessionThread: async () => {
        invalidated = true;
      },
    });

    assert.equal(updated.title, "Renamed");
    assert.equal(revoked, false);
    assert.equal(invalidated, false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "composer preview中のstarting Auxiliary runではprovider更新をside effect前に拒否する"
  // oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-provider-runtime-lifecycle.ts#updateAuxiliarySessionWithProviderRuntimeLifecycle" }
  // fault = "実行中Auxiliaryのprovider更新を許可し、runtime binding revokeやthread invalidationを開始する"
  // observable = "rejection message and update/revoke/invalidate calls"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-provider-runtime-lifecycle-running-update"
  // lifecycle = "permanent"
  // impact = "実行中turnのprovider identityが途中で変わり、provider runtime状態が破損する"
  // distinction = "starting runを明示した状態で拒否と副作用不在を同時に確認する"
  // @end-test-value
  /** コンポーザーのプレビューで実行開始済みなら、保存、バインディング失効、スレッド無効化を一切呼ばずにプロバイダー変更を拒否する。 */
  it("composer preview中のstarting runではprovider更新をside effect前に拒否する", async () => {
    const current = createAuxiliarySession("codex");
    let updated = false;
    let revoked = false;
    let invalidated = false;

    await assert.rejects(
      () =>
        updateAuxiliarySessionWithProviderRuntimeLifecycle({
          session: createAuxiliarySession("copilot"),
          /** 開始直後でも実行中として扱う状態を返す。 */
          isRunInFlight: () => true,
          /** 更新を拒否すべき現行の Codex セッションを返す。 */
          getAuxiliarySession: () => current,
          /** 拒否されるべき更新が保存操作に達した場合に記録する。 */
          updateAuxiliarySession: () => {
            updated = true;
            return current;
          },
          /** 拒否前にバインディングを失効させようとすると記録する。 */
          revokeSessionAgentRuntimeBindings: () => {
            revoked = true;
          },
          /** 拒否前にスレッドを無効化しようとすると記録する。 */
          invalidateProviderSessionThread: async () => {
            invalidated = true;
          },
        }),
      /A running Auxiliary Session cannot be updated/,
    );

    assert.equal(updated, false);
    assert.equal(revoked, false);
    assert.equal(invalidated, false);
  });
});
