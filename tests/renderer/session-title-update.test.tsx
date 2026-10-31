import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";

import { buildNewSession, getSessionIncarnationId, projectSessionSummary, type Session, type SessionSummary } from "../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { updateMainSessionTitle } from "../../src/chat/runtime/main-session-mutation-operations.js";
import { useSessionHeaderOperations, type SessionHeaderOperations } from "../../src/chat/shell/use-session-header-operations.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      id: "title-session", taskTitle: "Before", workspaceLabel: "workspace", workspacePath: "C:/workspace",
      branch: "main", characterId: "character", character: "Character", characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request",
    }),
    incarnationId: "owner-a", messages: [{ role: "user", text: "keep history" }],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function withTitleHarness(
  api: Pick<WithMateWindowApi, "setSessionTitle" | "getSessionSummary">,
  run: (harness: {
    operations(): SessionHeaderOperations;
    session(): Session;
    setSession: Dispatch<SetStateAction<Session>>;
    edit(title: string): Promise<void>;
    alerts: string[];
  }) => Promise<void>,
) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previous = { window: globalThis.window, document: globalThis.document };
  const alerts: string[] = [];
  dom.window.alert = (message) => { alerts.push(String(message)); };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let operations!: SessionHeaderOperations;
  let current!: Session;
  let setSession!: Dispatch<SetStateAction<Session>>;
  function Harness() {
    [current, setSession] = useState(createSession);
    operations = useSessionHeaderOperations({
      api: null, selectedSession: current, isReadOnly: false, runState: "idle", closeWindow: () => undefined,
      updateTitle: (session, title, isCurrent) => updateMainSessionTitle({
        api, session, title, isCurrent,
        applyTitle: (taskTitle) => setSession((latest) => isCurrent()
          && latest.id === session.id && getSessionIncarnationId(latest) === getSessionIncarnationId(session)
          ? { ...latest, taskTitle } : latest),
      }),
    });
    return <span>{current.taskTitle}</span>;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<Harness />); });
    await run({
      operations: () => operations, session: () => current, setSession,
      edit: async (title) => {
        await act(async () => { operations.startTitleEdit(); });
        await act(async () => { operations.setTitleDraft(title); });
      },
      alerts,
    });
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previous.window },
      document: { configurable: true, value: previous.document },
    });
  }
}

// @test-value v2
// kind = "contract"
// claim = "title consumerは正常保存を表示し、保存前rejectでは旧titleと編集入力を保持して失敗を伝える"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#ui-implementation-boundary" }
// fault = "正常保存のtitleを反映しない、または保存前失敗を保存済みとして表示し入力を失う"
// observable = "header hookの編集状態/入力、表示Session titleとmessages、alert、保存request数とsummary read数"
// observation_boundary = "consumer"
// scope = "main-title-consumer-normal-and-rejected"
// lifecycle = "permanent"
// impact = "titleの確定状態が誤表示され、利用者が編集内容を失う"
// distinction = "service/型検査では観測できないReact header hookとtitle consumerの保存結果解釈を確認する"
// @end-test-value
test("title consumerは正常保存と保存前失敗を区別する", async () => {
  const requests: unknown[] = [];
  let reject = false;
  let reads = 0;
  let savedTitle = "Before";
  await withTitleHarness({
    setSessionTitle: async (request) => {
      requests.push(request);
      if (reject) throw new Error("storage failed");
      savedTitle = request.title;
      return { status: "committed", projectionUpdated: true };
    },
    getSessionSummary: async () => { reads += 1; return projectSessionSummary(createSession({ taskTitle: savedTitle })); },
  }, async (h) => {
    await h.edit("After");
    await act(async () => { await h.operations().saveTitle(); });
    assert.equal(h.session().taskTitle, "After");
    assert.equal(h.operations().isEditingTitle, false);
    assert.deepEqual(h.alerts, []);
    reject = true;
    await h.edit("Rejected");
    await act(async () => { await h.operations().saveTitle(); });
    assert.equal(h.session().taskTitle, "After");
    assert.equal(h.operations().titleDraft, "Rejected");
    assert.equal(h.operations().isEditingTitle, true);
    assert.deepEqual(h.alerts, ["Title was not saved: storage failed"]);
    assert.deepEqual(h.session().messages.map((message) => message.text), ["keep history"]);
    assert.deepEqual(requests, [
      { sessionId: "title-session", incarnationId: "owner-a", title: "After" },
      { sessionId: "title-session", incarnationId: "owner-a", title: "Rejected" },
    ]);
    assert.equal(reads, 1);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "commit後投影失敗では正本summaryのtitleだけを復旧し、復旧read失敗でもcommit済みtitleを保持して保存済みと伝える"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send; Issue #738 STORAGE-1" }
// fault = "通知失敗を通常保存失敗として扱う、復旧に保存を再送する、またはsummary全体で会話/現在選択を上書きする"
// observable = "title consumerのSession title/messages/model/pin、保存とsummary取得の回数、header編集状態とalert"
// observation_boundary = "consumer"
// scope = "main-title-post-commit-recovery"
// lifecycle = "permanent"
// impact = "保存済みtitleが見えず、復旧が履歴や現在の設定を巻き戻す"
// distinction = "保存stub結果から実consumerの正本readとfield限定patchを確認し、SQL/serviceの成功結果testと分離する"
// @end-test-value
test("commit後失敗はtitleだけを復旧し復旧失敗でも保存済みを保つ", async () => {
  let saves = 0;
  let reads = 0;
  await withTitleHarness({
    setSessionTitle: async () => { saves += 1; return { status: "committed", projectionUpdated: false }; },
    getSessionSummary: async () => {
      reads += 1;
      if (reads === 2) throw new Error("read failed");
      return projectSessionSummary(createSession({ taskTitle: "Authoritative", model: "old-model", isPinned: false }));
    },
  }, async (h) => {
    await act(async () => { h.setSession((session) => ({ ...session, model: "current-model", isPinned: true })); });
    await h.edit("Committed");
    await act(async () => { await h.operations().saveTitle(); });
    assert.equal(h.session().taskTitle, "Authoritative");
    assert.equal(h.session().model, "current-model");
    assert.equal(h.session().isPinned, true);
    assert.deepEqual(h.session().messages.map((message) => message.text), ["keep history"]);
    assert.equal(h.operations().isEditingTitle, false);
    assert.match(h.alerts[0]!, /^Title saved and reloaded, but other windows may be out of date/);
    await h.edit("Still committed");
    await act(async () => { await h.operations().saveTitle(); });
    assert.equal(h.session().taskTitle, "Still committed");
    assert.equal(h.operations().isEditingTitle, false);
    assert.match(h.alerts[1]!, /^Title saved, but window updates failed and the saved title could not be reloaded/);
    assert.equal(saves, 2);
    assert.equal(reads, 2);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "遅延title保存/復旧readは後続保存と会話/ incarnation切替後にtitleやalertを上書きしない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
// fault = "旧保存の応答や復旧readが最新title/別ownerの表示へ流入する"
// observable = "遅延応答後のSession title、header編集状態、alert数、保存回数"
// observation_boundary = "consumer"
// scope = "main-title-stale-response-ownership"
// lifecycle = "permanent"
// impact = "別会話や最新のtitleが古い保存の応答で巻き戻る"
// distinction = "制御Promiseで実header hookのrequest失効とowner照合を検証し、単純な同期結果testでは検出できない競合を扱う"
// @end-test-value
test("遅延title結果は後続保存と会話owner切替へ流入しない", async () => {
  const firstRead = deferred<SessionSummary | null>();
  const staleSaves: ReturnType<typeof deferred<{ status: "committed"; projectionUpdated: boolean }>>[] = [];
  let saves = 0;
  await withTitleHarness({
    setSessionTitle: async () => {
      saves += 1;
      if (saves === 1) return { status: "committed", projectionUpdated: false };
      if (saves >= 3) {
        const pending = deferred<{ status: "committed"; projectionUpdated: boolean }>();
        staleSaves.push(pending);
        return pending.promise;
      }
      return { status: "committed", projectionUpdated: true };
    },
    getSessionSummary: () => firstRead.promise,
  }, async (h) => {
    await h.edit("B");
    let first!: Promise<void>;
    await act(async () => { first = h.operations().saveTitle(); });
    assert.equal(h.session().taskTitle, "B");
    await h.edit("C");
    await act(async () => { await h.operations().saveTitle(); });
    await act(async () => {
      firstRead.resolve(projectSessionSummary(createSession({ taskTitle: "B" })));
      await first;
    });
    assert.equal(h.session().taskTitle, "C");
    assert.deepEqual(h.alerts, []);
    await h.edit("Stale");
    let pending!: Promise<void>;
    await act(async () => { pending = h.operations().saveTitle(); });
    await act(async () => { h.setSession(createSession({ id: "other", taskTitle: "Other" })); });
    await h.edit("Other draft");
    await act(async () => {
      staleSaves[0]!.resolve({ status: "committed", projectionUpdated: false });
      await pending;
    });
    assert.equal(h.session().taskTitle, "Other");
    assert.equal(h.operations().titleDraft, "Other draft");
    assert.equal(h.operations().isEditingTitle, true);
    await act(async () => { h.setSession(createSession()); });
    await h.edit("Old incarnation");
    await act(async () => { pending = h.operations().saveTitle(); });
    await act(async () => { h.setSession(createSession({ incarnationId: "owner-b", taskTitle: "Recreated" })); });
    await act(async () => { staleSaves[1]!.resolve({ status: "committed", projectionUpdated: true }); await pending; });
    assert.equal(h.session().taskTitle, "Recreated");
    assert.deepEqual(h.alerts, []);
    assert.equal(saves, 4);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "後続title保存がrejectした場合も先行のcommit済みtitleを正本から表示し、後続の入力と失敗表示を保持する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send; Issue #738 STORAGE-1" }
// fault = "後続の保存失敗と先行応答失効の組合せでcommit済みtitleが表示から失われる"
// observable = "先行応答前後のSession title、後続のtitleDraft/編集状態/alert、保存と正本readの回数"
// observation_boundary = "consumer"
// scope = "main-title-later-save-rejected"
// lifecycle = "permanent"
// impact = "通知失敗後の確定titleが古い表示のままになり、利用者が保存状態を誤認する"
// distinction = "成功した後続保存の競合testとは異なり、最新保存のrejectで先行commitを表示へ復元する"
// @end-test-value
test("後続保存の失敗でも先行commitのtitleを失わない", async () => {
  const firstSave = deferred<{ status: "committed"; projectionUpdated: boolean }>();
  let saves = 0;
  let reads = 0;
  await withTitleHarness({
    setSessionTitle: async () => {
      saves += 1;
      if (saves === 1) return firstSave.promise;
      throw new Error("C write failed");
    },
    getSessionSummary: async () => {
      reads += 1;
      return projectSessionSummary(createSession({ taskTitle: "B" }));
    },
  }, async (h) => {
    await h.edit("B");
    let first!: Promise<void>;
    await act(async () => { first = h.operations().saveTitle(); });
    await h.edit("C");
    await act(async () => { await h.operations().saveTitle(); });
    assert.equal(h.session().taskTitle, "B");
    assert.equal(h.operations().titleDraft, "C");
    assert.equal(h.operations().isEditingTitle, true);
    assert.deepEqual(h.alerts, ["Title was not saved: C write failed"]);
    await act(async () => { firstSave.resolve({ status: "committed", projectionUpdated: false }); await first; });
    assert.equal(h.session().taskTitle, "B");
    assert.equal(h.operations().titleDraft, "C");
    assert.deepEqual(h.alerts, ["Title was not saved: C write failed"]);
    assert.equal(saves, 2);
    assert.equal(reads, 1);
  });
});
