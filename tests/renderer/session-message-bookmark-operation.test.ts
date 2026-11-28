import assert from "node:assert/strict";
import test from "node:test";
import { createMessageBookmarkHandler } from "../../src/chat/conversation/session-message-bookmark-operation.js";
import { buildMessageListProjection } from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";
import { buildMessageCollapseTargets } from "../../src/chat/conversation/session-message-collapse.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  setMessageBookmarked,
  type Session,
} from "../../src-shared/session/session-state.js";

/** 実行中の Main と Auxiliary に保存済みメッセージを一つずつ置き、保存要求と表示の差を追う。 */
function setup() {
  let main: Session = {
    id: "main",
    incarnationId: "main-generation-1",
    taskTitle: "Main",
    status: "running",
    runState: "running",
    updatedAt: "2026-09-27",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "character",
    character: "Mate",
    characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#000000" },
    characterRuntimeSnapshot: null,
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "model",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread",
    messages: [{ role: "assistant", text: "Main saved response" }],
    stream: [],
  };
  let auxiliary: AuxiliarySession = {
    id: "auxiliary",
    parentSessionId: "main",
    runState: "running",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "model",
    reasoningEffort: "medium",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "aux-thread",
    composerDraft: "",
    messages: [{ role: "user", text: "Auxiliary saved prompt" }],
    displayAfterMessageIndex: null,
    createdAt: "generation-1",
    updatedAt: "2026-09-27",
  };
  const commands: unknown[] = [];
  let wait = Promise.resolve();
  /** 現在の会話と保存 API を使い、ブックマーク操作の依存を組み立てる。 */
  const input = () => ({
    api: {
      /** Main への保存要求を取り込み、識別子の照合前に応答を保留できるようにする。 */
      setSessionMessageBookmark: async (request: unknown) => {
        commands.push(request);
        await wait;
      },
      /** Auxiliary への保存要求を記録し、Main と同様に完了時点を制御する。 */
      setAuxiliaryMessageBookmark: async (request: unknown) => {
        commands.push(request);
        await wait;
      },
    },
    mainSession: main,
    isReadOnly: false,
    /** Auxiliary の現時点の所有者と表示更新を操作ハンドラへつなぐ。 */
    getAuxiliaryBinding: (id: string) => ({
      /** 操作対象と同じ ID の場合だけ、現時点の Auxiliary を返す。 */
      getSession: () => (id === auxiliary.id ? auxiliary : null),
      /** 指定された位置の Auxiliary メッセージだけを表示上更新する。 */
      setMessageBookmark: (index: number, value: boolean) => {
        auxiliary = {
          ...auxiliary,
          messages: auxiliary.messages.map((message, i) =>
            i === index ? setMessageBookmarked(message, value) : message,
          ),
        };
      },
    }),
    /** Main の ID が一致する場合だけ、現在の表示データに差分を当てる。 */
    updateSessionProjection: (
      id: string,
      patch: (current: Session) => Session,
    ) => {
      if (main.id === id) main = patch(main);
    },
  });
  return {
    commands,
    input,
    /** 更新された Main の表示を読み取る。 */
    get main() {
      return main;
    },
    /** 保存中に Main を作り直した状態や世代の違いを再現する。 */ set main(
      value: Session,
    ) {
      main = value;
    },
    /** 更新された Auxiliary の表示を読み取る。 */
    get auxiliary() {
      return auxiliary;
    },
    /** 親や本文、世代を変えた Auxiliary を再現する。 */ set auxiliary(
      value: AuxiliarySession,
    ) {
      auxiliary = value;
    },
    /** 保存応答を待機・成功・失敗のいずれかに差し替える。 */
    setWait(value: Promise<void>) {
      wait = value;
    },
    /** 実際に表示へ投影したメッセージから、保存元を示すブックマーク対象を作る。 */
    target(kind: "session" | "auxiliary") {
      const owner = kind === "session" ? main : auxiliary;
      const projection = buildMessageListProjection(
        owner.messages,
        [],
        owner.id,
        { primaryMessageSourceKind: kind },
      );
      return buildMessageCollapseTargets(
        projection.messages,
        projection.sources,
        projection.keys,
      )[0];
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "実行中Main/Auxiliaryの保存済みmessageへのBookmark付与・解除はsource会話の小さい保存commandへ渡り、成功後その会話だけ更新する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md" }
// fault = "running状態で操作を拒否する、Main/Auxiliaryの保存先を混同する、または保存成功後に対象messageが更新されない"
// observable = "APIへ渡るowner identityとmessage index・Bookmark値、Main/Auxiliaryの更新後Bookmark"
// observation_boundary = "public-boundary"
// scope = "message-bookmark-routing"
// lifecycle = "permanent"
// impact = "実行や送信対象の切替に関係なく保存済み会話を整理できることを保証する"
// distinction = "storageやbutton単体では検出できない実message projectionから保存API・局所更新への配線を検証する"
// @end-test-value
/** 実行中でも Main と Auxiliary のそれぞれの保存要求へ付与と解除を渡す。 */
test("実行中でもMain/Auxiliaryのsource会話へBookmarkを付与・解除する", async () => {
  const view = setup();
  for (const value of [true, false]) {
    await createMessageBookmarkHandler(view.input())!(view.target("session"));
    assert.equal(view.main.messages[0].isBookmarked === true, value);
    assert.equal(view.auxiliary.messages[0].isBookmarked === true, !value);
    await createMessageBookmarkHandler(view.input())!(view.target("auxiliary"));
    assert.equal(view.auxiliary.messages[0].isBookmarked === true, value);
  }
  assert.deepEqual(
    view.commands,
    [true, false].flatMap((isBookmarked) => [
      {
        sessionId: "main",
        incarnationId: "main-generation-1",
        messageIndex: 0,
        isBookmarked,
      },
      {
        auxiliarySessionId: "auxiliary",
        parentSessionId: "main",
        createdAt: "generation-1",
        messageIndex: 0,
        isBookmarked,
      },
    ]),
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Bookmarkのread-only制限とAuxiliary owner照合は実行中許可後も維持する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md" }
// fault = "read-onlyで操作を提供する、別親Auxiliaryや本文不一致のsourceへ保存する"
// observable = "handlerの未提供と不正source操作後のAPI呼出数"
// observation_boundary = "public-boundary"
// scope = "message-bookmark-owner-guard"
// lifecycle = "permanent"
// impact = "閲覧専用データや別会話の意図しないBookmark変更を防ぐ"
// distinction = "UI表示testやstorageのowner検証とは異なるrenderer保存開始境界を検証する"
// @end-test-value
/** 閲覧専用では操作を提供せず、親または本文が一致しない保存元には要求を出さない。 */
test("Bookmarkはread-onlyと別owner・置換messageを更新しない", async () => {
  const view = setup();
  assert.equal(
    createMessageBookmarkHandler({ ...view.input(), isReadOnly: true }),
    undefined,
  );
  const target = view.target("auxiliary");
  view.auxiliary = { ...view.auxiliary, parentSessionId: "other-parent" };
  await createMessageBookmarkHandler(view.input())!(target);
  view.auxiliary = {
    ...view.auxiliary,
    parentSessionId: "main",
    messages: [{ role: "user", text: "replacement" }],
  };
  await createMessageBookmarkHandler(view.input())!(target);
  assert.deepEqual(view.commands, []);
});

// @test-value v2
// kind = "invariant"
// claim = "Bookmark保存の遅延成功は同ID再作成会話へ適用せず、保存失敗は表示Bookmarkを成功扱いしない"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md" }
// fault = "保存待機中にincarnation/createdAtが変わった会話へ古いackを適用する、または失敗前にBookmarkを確定する"
// observable = "API成功・失敗後のMain/AuxiliaryのBookmarkと伝播error"
// observation_boundary = "public-boundary"
// scope = "message-bookmark-ack-ownership"
// lifecycle = "permanent"
// impact = "会話の再作成や保存障害でも誤った成功表示を防ぐ"
// distinction = "通常の同期API成功ケースでは観測できないack待機境界をdeferredで検証する"
// @end-test-value
/** 保存応答を待つ間に作り直した会話には反映せず、保存に失敗した場合も表示を変更しない。 */
test("Bookmarkの遅延ackは再作成ownerを変更せず、保存失敗は表示に反映しない", async () => {
  const view = setup();
  let resolve!: () => void;
  view.setWait(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const handler = createMessageBookmarkHandler(view.input())!;
  const saves = [
    handler(view.target("session")),
    handler(view.target("auxiliary")),
  ];
  view.main = { ...view.main, incarnationId: "main-generation-2" };
  view.auxiliary = { ...view.auxiliary, createdAt: "generation-2" };
  resolve();
  await Promise.all(saves);
  assert.equal(view.main.messages[0].isBookmarked, undefined);
  assert.equal(view.auxiliary.messages[0].isBookmarked, undefined);
  view.setWait(Promise.reject(new Error("storage failed")));
  for (const kind of ["session", "auxiliary"] as const) {
    await assert.rejects(
      createMessageBookmarkHandler(view.input())!(view.target(kind)),
      /storage failed/,
    );
  }
  assert.equal(view.main.messages[0].isBookmarked, undefined);
  assert.equal(view.auxiliary.messages[0].isBookmarked, undefined);
});
