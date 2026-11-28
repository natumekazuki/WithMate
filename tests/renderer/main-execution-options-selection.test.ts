import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { useMainSessionRuntime } from "../../src/chat/runtime/use-main-session-runtime.js";
import type { SetExecutionOptionsResult } from "../../src-shared/session/session-mutation-contract.js";
import type {
  Session,
  SessionSummaryInvalidation,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

/** 同じセッションの世代を維持し、推論深度だけが異なる選択を組み立てる。 */
function session(
  reasoningEffort: Session["reasoningEffort"] = "medium",
): Session {
  return {
    id: "session-1",
    incarnationId: "owner-1",
    taskTitle: "test",
    status: "idle",
    updatedAt: "2026-09-28T00:00:00.000Z",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:\\workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#000000" },
    characterRuntimeSnapshot: null,
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "model",
    reasoningEffort,
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    messages: [],
    stream: [],
  };
}

/** 実行設定の応答や拒否を要求順と独立に操作できるようにする。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// @test-value v2
// kind = "invariant"
// claim = "同一owner内の実行設定の拒否は最新選択だけを正本へ戻し、B→C→Bで古い拒否が後続Bを消さない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md: 実行設定と Send" }
// fault = "拒否応答を要求順の確認なしにrollbackし、後続選択または新着本文を上書きする"
// observable = "hookの表示選択と新着本文、正本再読込回数、拒否feedback"
// observation_boundary = "component-behavior"
// scope = "main-execution-options-rejection"
// lifecycle = "permanent"
// impact = "Sendが利用者の最後の選択と異なる条件で実行される"
// distinction = "service validation testと異なり非同期IPC拒否後のrenderer overlayを観測する"
// @end-test-value
/** 同じ推論深度を再選択した後、古い拒否は無視し、最新の拒否だけで本文を保ったまま正本の深度へ戻す。 */
test("古い拒否は後続選択を消さず最新拒否だけ正本へ戻す", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://withmate.test",
  });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, {
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const pending: ReturnType<typeof deferred<SetExecutionOptionsResult>>[] = [];
  const feedback: string[] = [];
  let reads = 0;
  const api = {
    /** 既定の推論深度を持つ正本を返し、再取得回数を控える。 */
    getSession: async () => {
      reads += 1;
      return session();
    },
    /** 更新通知の購読を受け付けるが、通知を送らない。 */
    subscribeSessionInvalidation: () => () => undefined,
    /** 実行設定の書き込みを保留し、テストがどの要求から拒否するか制御できるようにする。 */
    setSessionExecutionOptions: () => {
      const request = deferred<SetExecutionOptionsResult>();
      pending.push(request);
      return request.promise;
    },
    /** この試験ではログを保存せず、拒否の表示を別途観測する。 */
    reportRendererLog: async () => undefined,
  } as unknown as Parameters<typeof useMainSessionRuntime>[0]["api"];
  const registry = new ComposerControllerRegistry();
  let current: ReturnType<typeof useMainSessionRuntime> | null = null;
  /** 選択中のセッションに対するランタイムの投影をテストから確認できるようにする。 */
  function Probe() {
    current = useMainSessionRuntime({
      api,
      selectedId: "session-1",
      composerRegistry: registry,
      /** 利用者に渡る拒否メッセージを控える。 */
      onExecutionOptionsError: (_id, message) => feedback.push(message),
    });
    return null;
  }
  const root = createRoot(
    dom.window.document.getElementById("root") as HTMLElement,
  );
  try {
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "medium");
    await act(async () => {
      current!.selectExecutionOptions(session("high"));
      current!.selectExecutionOptions(session("low"));
      current!.selectExecutionOptions(session("high"));
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "high");
    await act(async () => {
      current!.updateSessionProjection("session-1", (value) => ({
        ...value,
        messages: [{ role: "assistant", text: "new streaming text" }],
      }));
    });
    await act(async () => {
      pending[0]!.reject(new Error("old B rejected"));
      pending[1]!.reject(new Error("old C rejected"));
      await Promise.allSettled([pending[0]!.promise, pending[1]!.promise]);
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "high");
    assert.equal(reads, 1);
    await act(async () => {
      pending[2]!.reject(new Error("latest B rejected"));
      await Promise.allSettled([pending[2]!.promise]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "medium");
    assert.equal(current!.sessions[0]?.messages[0]?.text, "new streaming text");
    assert.equal(reads, 2);
    assert.equal(feedback.length, 1);
    assert.match(feedback[0]!, /latest B rejected/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    Object.assign(globalThis, { window: previousWindow });
  }
});
