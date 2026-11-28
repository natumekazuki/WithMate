import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { CreateSessionRequest } from "../../src-shared/session/session-state.js";
import {
  buildHomeLaunchHandlers,
  type HomeLaunchLifetime,
} from "../../src/home/home-launch-handlers.js";
import {
  createClosedLaunchDraft,
  type HomeLaunchDraft,
} from "../../src/home/home-launch-state.js";

// @test-value v2
// kind = "contract"
// claim = "起点Roleを作成要求へ渡し、結果不明の同一入力retryはrequest IDとCharacter snapshotを維持し、入力編集後は別の作成試行になる"
// oracle = { type = "contract", ref = "GitHub Issue #834 Roleと作成経路 / GitHub Issue #833 作成再試行" }
// fault = "retryで新IDや新Character snapshotを生成する、起点Roleを落とす、または編集した新要求に旧IDを再利用する"
// observable = "実Home handlerからcreateSessionへ渡された各要求のRole・ID・Character名・title"
// observation_boundary = "consumer"
// scope = "Home launchのRole選択、作成不明結果からのretry、入力編集"
// lifecycle = "permanent"
// impact = "結果不明後の重複作成、再送payload不一致、新しい入力が旧作成と混同されることを防ぐ"
// distinction = "型検査と既存正常系は時間を跨ぐretryの同一性を検出できず、小さなhandler試行で確認する"
// @end-test-value
/** 未確定の作成は要求をそのまま再送し、入力を編集した作成では最新の Role と Character で別の試行を始める。 */
test("起点Roleと同一retryを保持し、入力編集で新しい作成試行にする", async () => {
  let draft: HomeLaunchDraft = {
    ...createClosedLaunchDraft(),
    open: true,
    title: "Original",
    providerId: "codex",
    workspace: { kind: "session-folder" },
  };
  let character: CharacterCatalogEntry = {
    id: "mia",
    name: "Mia",
    description: "",
    iconFilePath: "",
    theme: { main: "#112233", sub: "#445566" },
    state: "active",
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
  };
  const requests: CreateSessionRequest[] = [];
  const launchLifetimeRef: { current: HomeLaunchLifetime } = {
    current: { starting: false },
  };
  /** 現在の入力と Character から、起動処理の寿命を共有するハンドラを組み立てる。 */
  const render = () =>
    buildHomeLaunchHandlers({
      launchDraft: draft,
      launchDialogAttemptRef: { current: {} },
      launchLifetimeRef,
      launchStarting: false,
      /** 起動ダイアログ外への結果引き継ぎは観測しない。 */ onDetachedResult:
        () => {},
      mateState: null,
      mateProfile: null,
      enabledLaunchProviders: [],
      characterEntries: [character],
      selectedLaunchProviderId: "codex",
      sessions: [],
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionCharacterUsageLoadStatus: "loaded",
      /** 再描画時点での Character 一覧を返す。 */
      refreshCharacterEntries: async () => [character],
      /** 一覧表示の更新は省き、作成要求に保持される Character を調べる。 */ setLaunchCharacterCatalog:
        () => {},
      /** 起動結果の通知表示は観測しない。 */
      setLaunchFeedback: () => {},
      /** 起動中表示の更新を省き、生存期間の保持をハンドラに任せる。 */ setLaunchStarting:
        () => {},
      /** 値と関数の両方の更新を受け付け、再描画に使う入力を保存する。 */
      setLaunchDraft: (update) => {
        draft = typeof update === "function" ? update(draft) : update;
      },
      /** ディレクトリを選ばずに Session Folder の設定を使う。 */
      pickWorkspaceDirectory: () => null,
      /** 外部パスを選ばないため、検証を予約しない。 */ scheduleWorkspaceValidation:
        () => {},
      /** パスの検証を予約しないので取り消し時も操作しない。 */ cancelWorkspaceValidation:
        () => {},
      /** 未確定の作成でウィンドウが開かれたら失敗とする。 */
      openSessionWindow: async () => {
        assert.fail("An unconfirmed creation must not open a window.");
      },
      /** 要求の再送前後を比較できるよう複製し、作成結果は未確定として返す。 */
      createSession: async (request) => {
        requests.push(structuredClone(request));
        return null;
      },
      /** 未確定の作成を一覧に追加したら失敗とする。 */
      upsertSessionSummary: () => {
        assert.fail("An unconfirmed creation must not publish a summary.");
      },
    });
  /** 作成を開始し、ハンドラの非同期処理が進むまでイベントループを一周待つ。 */
  const start = async () => {
    render().onStartSession();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  render().onSelectLaunchRole("overall-coordinator");
  await start();
  character = { ...character, name: "Updated Mia" };
  await start();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].sessionRole, "overall-coordinator");
  assert.equal(requests[0].character, "Mia");
  assert.ok(requests[0].clientRequestId);
  assert.deepEqual(requests[1], requests[0]);
  render().onChangeTitle("New Work");
  render().onSelectLaunchRole("standalone");
  await start();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].sessionRole, "standalone");
  assert.equal(requests[2].taskTitle, "New Work");
  assert.equal(requests[2].character, "Updated Mia");
  assert.ok(requests[2].clientRequestId);
  assert.notEqual(requests[2].clientRequestId, requests[0].clientRequestId);
});
