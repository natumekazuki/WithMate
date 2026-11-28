import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
} from "../../src-electron/providers/provider-runtime.js";
import { SessionRuntimeFixture as SessionRuntimeService } from "./session-runtime-fixture.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

/** 各並行ターンの応答をテストから個別に解放するための Promise を作る。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** 同じ作業場所に属し、識別子とプロバイダーが異なるセッションを用意する。 */
function session(id: string, provider: string): Session {
  return {
    ...buildNewSession({
      id,
      taskTitle: id,
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      provider,
      model: "gpt-5.4",
      reasoningEffort: "high",
      characterId: `character-${id}`,
      character: id,
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: "on-request",
    }),
  };
}

const TEST_EXECUTION_OPTIONS = captureSessionExecutionOptions(
  session("test", "codex"),
);

/** 各プロバイダーで同じモデルを使える単一候補のカタログを構成する。 */
function providerCatalog(id: string): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
  };
}

/** 開始・完了・キャンセルをセッション ID ごとに観測できるアダプターを作る。 */
function adapter(
  gates: Map<
    string,
    Promise<{ threadId: string; assistantText: string; finalText: string }>
  >,
  onCancel: (sessionId: string) => void,
  onStart: (sessionId: string) => void = () => undefined,
): ProviderCodingAdapter {
  return {
    /** 応答の競合だけを観測するため、プロンプトを固定する。 */
    composePrompt() {
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
    /** 並行するターンから利用枠を返さない。 */
    async getProviderQuotaTelemetry() {
      return null;
    },
    /** 個別無効化はスレッドの実行結果と切り離す。 */
    async invalidateSessionThread() {},
    /** スレッド一括無効化による副作用を発生させない。 */
    async invalidateAllSessionThreads() {},
    /** 対象セッションの応答待ちとキャンセルを結び、他の応答待ちには触れない。 */
    runSessionTurn(input) {
      onStart(input.session.id);
      const resultPromise = gates.get(input.session.id)!;
      const result = resultPromise.then((value) => ({
        threadId: value.threadId,
        assistantText: value.assistantText,
        lastNonEmptyAssistantMessageText: value.finalText,

        usage: null,
      }));
      if (!input.signal) {
        return result;
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        /** 正常完了と中断のうち最初の結果だけを受け取り、リスナーを解放する。 */
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          input.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        /** 対象 ID の中断を記録し、キャンセル扱いのプロバイダーエラーで終了する。 */
        const onAbort = () => {
          onCancel(input.session.id);
          settle(() =>
            reject(
              new ProviderTurnError(
                "test provider canceled",
                {
                  threadId: null,
                  assistantText: "",

                  usage: null,
                },
                true,
                "canceled",
              ),
            ),
          );
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        if (input.signal?.aborted) {
          onAbort();
          return;
        }
        result.then(
          (value) => settle(() => resolve(value)),
          (error) => settle(() => reject(error)),
        );
      });
    },
  };
}

/** セッション保存と実行中状態をインメモリに閉じたランタイム木枠を作る。 */
function makeRuntimeService(
  stored: Map<string, Session>,
  adapters: Map<string, ProviderCodingAdapter>,
  confirmedFinalTexts: string[],
) {
  let turnId = 0;
  const liveRuns = new Map<string, any>();
  const appSettings = normalizeAppSettings({});
  appSettings.codingProviderSettings.gemini = {
    enabled: true,
    apiKey: "",
    skillRootPath: "",
  };
  return new SessionRuntimeService({
    /** ランタイムが担当する保存済みセッションだけを ID で返す。 */
    getSession: (id) => stored.get(id) ?? null,
    /** セッションを更新し、確定した最終発言の保存先も照合できるようにする。 */
    upsertSession: (next, options) => {
      if (options?.confirmedFinalAssistantText !== undefined) {
        confirmedFinalTexts.push(options.confirmedFinalAssistantText ?? "");
      }
      stored.set(next.id, next);
      return next;
    },
    /** 添付なしの送信内容を返し、ターン実行まで進める。 */
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    /** 有効化した代替プロバイダーを含む実行設定を返す。 */
    getAppSettings: () => appSettings,
    /** 選択中のプロバイダーを一件だけ含むモデルカタログを返す。 */
    resolveProviderCatalog: (providerId) => {
      const provider = providerCatalog(providerId ?? "codex");
      return { provider, snapshot: { providers: [provider] } };
    },
    /** 選択されたプロバイダーの偽アダプターへ実行を接続する。 */
    getProviderCodingAdapter: (providerId) =>
      adapters.get(providerId ?? "codex")!,
    /** 各ランタイム内で採番したターンと開始入力を返す。 */
    createSessionTurn: (input) => ({ id: ++turnId, ...input }),
    /** ターン行への追記は行わず、検査するセッション保存に焦点を置く。 */
    updateSessionTurn: () => undefined,
    /** 実行中状態をセッション別に保持し、終了時にその ID だけを消す。 */
    setLiveSessionRun: (id, state) =>
      state ? liveRuns.set(id, state) : liveRuns.delete(id),
    /** 他セッションを参照せず、指定 ID の実行状態を返す。 */
    getLiveSessionRun: (id) => liveRuns.get(id) ?? null,
    /** 実行時の承認要求は即座に承認する。 */
    waitForApprovalDecision: () => "approve",
    /** 入力要求の応答が必要ならキャンセル扱いにする。 */
    waitForElicitationResponse: () => ({ action: "cancel" }),
    /** 利用枠テレメトリーの更新は並行実行の検査対象に含めない。 */
    setProviderQuotaTelemetry: () => undefined,
    /** 文脈テレメトリーの外部保存は行わない。 */
    setSessionContextTelemetry: () => undefined,
    /** 別のアダプター操作を起動せず、各ターンの返却状態を検査する。 */
    invalidateProviderSessionThread: () => undefined,
    /** バックグラウンドの利用枠再取得を予約しない。 */
    scheduleProviderQuotaTelemetryRefresh: () => undefined,
    /** 実行中状態の変更をウィンドウへ配信しない。 */
    broadcastLiveSessionRun: () => undefined,
    /** 保留された承認要求に対する外部通知は行わない。 */
    resolvePendingApprovalRequest: () => undefined,
    /** 保留された入力要求の解決を外部に通知しない。 */
    resolvePendingElicitationRequest: () => undefined,
    providerCancelGraceMs: 0,
  });
}

/** 親セッションと複数の補助セッションが同時に実行できることを検査する。 */
describe("SessionRuntimeService parallel conversations", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "MainとAuxiliary A/Bは同時実行でき、AだけをcancelしてもMain/Bの保存結果とthreadが混線しない"
  // oracle = { type = "contract", ref = "issue-710 acceptance A/G: independent parallel runs" }
  // fault = "共有runtime状態やProvider実行を会話間で直列化し、AのcancelでMain/Bを停止または別会話のmessages/threadを保存する"
  // observable = "各Sessionのrun結果、messages末尾、threadId、cancel後のAの状態"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-parallel"
  // lifecycle = "permanent"
  // @end-test-value
  /** 一つの補助セッションの中断が、他の二つの保存内容とスレッドに波及しないことを確認する。 */
  it("同一Providerと別Providerの両方でMain/A/Bを独立して完了・cancelする", async () => {
    for (const auxiliaryProvider of ["codex", "gemini"] as const) {
      const main = session("main", "codex");
      const auxiliaryA = session("aux-a", auxiliaryProvider);
      const auxiliaryB = session("aux-b", auxiliaryProvider);
      const stored = new Map(
        [main, auxiliaryA, auxiliaryB].map(
          (value) => [value.id, value] as const,
        ),
      );
      const mainGate = deferred<{
        threadId: string;
        assistantText: string;
        finalText: string;
      }>();
      const aGate = deferred<{
        threadId: string;
        assistantText: string;
        finalText: string;
      }>();
      const bGate = deferred<{
        threadId: string;
        assistantText: string;
        finalText: string;
      }>();
      const gates = new Map([
        [main.id, mainGate.promise],
        [auxiliaryA.id, aGate.promise],
        [auxiliaryB.id, bGate.promise],
      ]);
      const startedSessionIds = new Set<string>();
      /** 補助セッション A だけの待機をキャンセル用の空応答で解除する。 */
      const cancelA = () =>
        aGate.resolve({
          threadId: "thread-a-canceled",
          assistantText: "",
          finalText: "",
        });
      const adapters = new Map<string, ProviderCodingAdapter>([
        [
          "codex",
          adapter(
            gates,
            (sessionId) => {
              if (sessionId === auxiliaryA.id) cancelA();
            },
            (sessionId) => startedSessionIds.add(sessionId),
          ),
        ],
        [
          "gemini",
          adapter(
            gates,
            (sessionId) => {
              if (sessionId === auxiliaryA.id) cancelA();
            },
            (sessionId) => startedSessionIds.add(sessionId),
          ),
        ],
      ]);
      const mainStored = new Map([[main.id, main]]);
      const auxiliaryStored = new Map([
        [auxiliaryA.id, auxiliaryA],
        [auxiliaryB.id, auxiliaryB],
      ]);
      const mainConfirmedFinalTexts: string[] = [];
      const auxiliaryConfirmedFinalTexts: string[] = [];
      const mainRuntime = makeRuntimeService(
        mainStored,
        adapters,
        mainConfirmedFinalTexts,
      );
      const auxiliaryRuntime = makeRuntimeService(
        auxiliaryStored,
        adapters,
        auxiliaryConfirmedFinalTexts,
      );

      const mainRun = mainRuntime.runSessionTurn(main.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "main",
      });
      const aRun = auxiliaryRuntime.runSessionTurn(auxiliaryA.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "a",
      });
      const bRun = auxiliaryRuntime.runSessionTurn(auxiliaryB.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "b",
      });
      for (
        let attempt = 0;
        attempt < 100 && startedSessionIds.size < 3;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual(
        [...startedSessionIds].sort(),
        [auxiliaryA.id, auxiliaryB.id, main.id].sort(),
      );
      await auxiliaryRuntime.cancelRun(auxiliaryA.id);
      mainGate.resolve({
        threadId: "thread-main",
        assistantText: "途中発言\n最終発言",
        finalText: "最終発言",
      });
      bGate.resolve({
        threadId: "thread-b",
        assistantText: "b done",
        finalText: "b final",
      });
      await Promise.all([mainRun, aRun, bRun]);

      assert.equal(mainStored.get(main.id)?.runState, "idle");
      assert.equal(mainStored.get(main.id)?.threadId, "thread-main");
      assert.equal(
        mainStored.get(main.id)?.messages.at(-1)?.text,
        "途中発言\n最終発言",
      );
      assert.equal(auxiliaryStored.get(auxiliaryB.id)?.runState, "idle");
      assert.equal(auxiliaryStored.get(auxiliaryB.id)?.threadId, "thread-b");
      assert.equal(
        auxiliaryStored.get(auxiliaryB.id)?.messages.at(-1)?.text,
        "b done",
      );
      assert.equal(auxiliaryStored.get(auxiliaryA.id)?.runState, "idle");
      assert.match(
        auxiliaryStored.get(auxiliaryA.id)?.messages.at(-1)?.text ?? "",
        /キャンセル|cancel/i,
      );
      assert.deepEqual(mainConfirmedFinalTexts, ["最終発言"]);
      assert.deepEqual(auxiliaryConfirmedFinalTexts, ["b final"]);
    }
  });
});
