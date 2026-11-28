import assert from "node:assert/strict";
import test from "node:test";
import type { WebContents } from "electron";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

import { createMainIpcRegistrationDeps } from "../../src-electron/app/main-ipc-deps.js";
import type {
  MainIpcCatalogDepsArgs,
  MainIpcPromptTemplateDepsArgs,
  MainIpcSessionQueryDepsArgs,
  MainIpcSettingsDepsArgs,
  MainIpcWindowDepsArgs,
} from "../../src-electron/app/main-ipc-deps.js";

// @test-value v2
// kind = "contract"
// claim = "createMainIpcRegistrationDepsはSession Monitorのcontext menu、終了flush ACK、Auxiliary ID付きwindow delegateをwindow groupからregistration depsへ保持する"
// oracle = { type = "contract", ref = "src-electron/ipc/window.ts#registerWindowHandlers のMonitor menuとopenSession、src-electron/ipc/register-main-ipc.ts#registerMainIpcHandlers のdraft flush ACK" }
// fault = "window groupに追加したdelegateが内部factoryからregistration depsへ欠落するか、Auxiliary IDを親Window delegateへ渡さない"
// observable = "生成されたregistration depsのflush ACK、context menu delegateへ渡るevent/request引数、およびwindow delegateの呼び出し引数"
// observation_boundary = "component-behavior"
// scope = "main IPC dependency grouping"
// lifecycle = "permanent"
// impact = "Main IPC handlerから終了flush ACKとSession Monitor native menu serviceへ到達できるようにする"
// distinction = "grouped dependency mappingだけを検証し、IPC request validationとnative selectionは別testで扱う"
// @end-test-value
/** 登録依存の組み立てで、ウィンドウとMateの委譲先、送信元、Auxiliary IDを保つことを確認する。 */
test("createMainIpcRegistrationDeps は残存する window / mate delegate を組み立てる", async () => {
  const calls: string[] = [];
  const contextMenuArgs: unknown[][] = [];
  /** 受け取ったイベントと要求を保管し、Monitorメニューが閉じた結果を返す。 */
  const showSessionMonitorContextMenu = async (
    event: unknown,
    request: unknown,
  ) => {
    contextMenuArgs.push([event, request]);
    calls.push("showSessionMonitorContextMenu");
    return { status: "dismissed" as const };
  };
  let acknowledged: {
    sender: unknown;
    payload: { requestId: string; success: boolean };
  } | null = null;
  /** flush完了通知の送信元と成否を記録し、登録経路がそのまま伝えるかを観測する。 */
  const acknowledgeSessionDraftFlush = (
    event: { sender: unknown },
    payload: { requestId: string; success: boolean },
  ) => {
    acknowledged = { sender: event.sender, payload };
  };

  const deps = createMainIpcRegistrationDeps({
    window: {
      /** Home一覧を参照されても、表示対象のCrewを用意しない。 */
      async listHomeCrewPage() {
        return {
          entries: [],
          auxiliarySessions: [],
          nextCursor: null,
          hasMore: false,
        };
      },
      /** HomeのCrewメニューを開く操作には選択なしを返す。 */
      async showHomeCrewContextMenu() {
        return { status: "dismissed" };
      },
      /** ファイルプレビューのメニューは操作を選ばず閉じる。 */
      async showSessionFilePreviewContextMenu() {
        return "dismissed";
      },
      /** 別窓で開いているファイルプレビューはないことにする。 */
      async listSessionFilePreviewWindows() {
        return [];
      },
      /** フォーカスを移す実プレビューウィンドウは作らない。 */
      focusSessionFilePreviewWindow() {},
      /** 単一のプレビューを閉じる操作にネイティブ処理を加えない。 */
      closeSessionFilePreviewWindow() {},
      /** プレビューの一括終了には閉じる対象を用意しない。 */
      closeSessionFilePreviewWindows() {},
      acknowledgeSessionDraftFlush,
      /** イベント送信元に対応するネイティブウィンドウは提供しない。 */
      resolveEventWindow: () => null,
      /** 既存のHome参照は用意せず、openの委譲を直接観測する。 */
      resolveHomeWindow: () => null,
      /** 既存Session窓を参照させず、対象IDでのopenを観測する。 */
      resolveSessionWindow: () => null,
      /** 親と指定されたAuxiliaryのIDを独立に記録する。 */
      async openSessionWindow(sessionId: string, auxiliarySessionId?: string) {
        calls.push(`openSession:${sessionId}:${auxiliarySessionId ?? "none"}`);
        return {} as never;
      },
      /** 復元候補の委譲を記録し、固定のSession IDを返す。 */
      async getSessionWindowRestoreSet() {
        calls.push("getSessionWindowRestoreSet");
        return ["session-1"];
      },
      /** 要求したSessionが復元された結果と、復元の呼出順序を用意する。 */
      async restoreSessionWindows() {
        calls.push("restoreSessionWindows");
        return {
          requestedSessionIds: ["session-1"],
          openedSessionIds: ["session-1"],
          failures: [],
        };
      },
      /** 本物のHomeを開かず、登録先へ委譲された時点を記録する。 */
      async openHomeWindow() {
        calls.push("openHome");
        return {} as never;
      },
      /** このケースで使わないMonitorの起動結果を形だけ供給する。 */
      async openSessionMonitorWindow() {
        return {} as never;
      },
      /** 送信元をMonitorと識別する必要がない構成にする。 */
      isSessionMonitorWindow() {
        return false;
      },
      showSessionMonitorContextMenu,
      /** Settingsの生成は検証せず、ネイティブ窓の代わりを返す。 */
      async openSettingsWindow() {
        return {} as never;
      },
      /** Settings窓の判定が対応する委譲先に届いたことを記録する。 */
      isSettingsWindow() {
        calls.push("isSettings");
        return true;
      },
      /** エディタは表示せず、Character編集の窓生成依存を満たす。 */
      async openCharacterEditorWindow() {
        return {} as never;
      },
      /** 比較ウィンドウの表示を行わず、登録に必要な戻り値だけを返す。 */
      async openDiffWindow() {
        return {} as never;
      },
      /** 意図せずプレビュー窓の種別を調べた場合に検知する。 */
      isFilePreviewWindow: () => {
        throw new Error("unused window fixture method");
      },
      /** 未起動のプレビュー窓からリソースを取得しようとした場合に検知する。 */
      getFilePreviewWindowResource: () => {
        throw new Error("unused window fixture method");
      },
      /** プレビューtokenとウィンドウの照合はこのケースの外とする。 */
      isFilePreviewTokenWindow: () => {
        throw new Error("unused window fixture method");
      },
      /** 汎用ディレクトリ選択はキャンセルとして返す。 */
      async pickDirectory() {
        return null;
      },
      /** ファイルシステムを読まず、指定されたworkspaceを有効とする。 */
      async validateWorkspaceDirectory() {
        return { valid: true };
      },
      /** 汎用の単一ファイル選択にパスを返さない。 */
      async pickFile() {
        return null;
      },
      /** 汎用複数ファイル選択の結果を空にする。 */
      async pickFiles() {
        return [];
      },
      /** Sessionへのファイル追加候補を選択しない。 */
      async pickSessionFiles() {
        return [];
      },
      /** Session用フォルダの選択なしを返す。 */
      async pickSessionFolder() {
        return null;
      },
      /** Sessionに追加する画像の選択をキャンセル扱いにする。 */
      async pickSessionImageFile() {
        return null;
      },
      /** 汎用画像ピッカーに選択結果を持たせない。 */
      async pickImageFile() {
        return null;
      },
      /** 依存の組み立て中にSession Filesのコピーを起動した場合は失敗させる。 */
      copyFilesToSessionFiles: async () => {
        throw new Error("unused window fixture method");
      },
      /** クリップボード由来のファイル保存を要求した場合に検知する。 */
      savePastedSessionFile: async () => {
        throw new Error("unused window fixture method");
      },
      /** Session FilesのパスをOSで開く経路はこのfixtureで利用しない。 */
      openSessionFilesDirectory: async () => {
        throw new Error("unused window fixture method");
      },
      /** Session Filesを作業場所とする端末の起動は検証しない。 */
      openSessionFilesTerminal: async () => {
        throw new Error("unused window fixture method");
      },
      /** 画像コピーのIPC形状を満たし、実際のクリップボードを変更しない。 */
      copySessionFilePreviewImage: async () => ({ status: "copied" }),
      /** 画像メニューを操作せず閉じた応答を返す。 */
      showSessionFilePreviewImageContextMenu: async () => ({
        status: "dismissed",
      }),
      /** 画像レスポンスの検証と無関係なファイルオブジェクトのコピーを検知する。 */
      copySessionFileObject: async () => {
        throw new Error("unused window fixture method");
      },
      /** ファイルオブジェクト用のコピーメニューを要求された場合に検知する。 */
      showSessionFileObjectCopyContextMenu: async () => {
        throw new Error("unused window fixture method");
      },
      /** ファイルツリーのコンテキスト操作は未使用であることを示す。 */
      showSessionFileTreeContextMenu: async () => {
        throw new Error("unused window fixture method");
      },
      /** Markdownリンクのメニュー処理へ分岐した場合に検知する。 */
      showMarkdownLinkContextMenu: async () => {
        throw new Error("unused window fixture method");
      },
      /** 実際のファイルは開かず、ローカルパスを開く結果の形を返す。 */
      async openPathTarget() {
        return { status: "opened", targetType: "local-path", target: "" };
      },
      /** アプリのログフォルダーを実OSで開かない。 */
      async openAppLogFolder() {},
      /** クラッシュ情報の格納先を実OSで開かない。 */
      async openCrashDumpFolder() {},
      /** Session用端末を起動するネイティブ副作用を省く。 */
      async openSessionTerminal() {},
      /** 指定パスでの端末起動にも実プロセスを使わない。 */
      async openTerminalAtPath() {},
    } satisfies MainIpcWindowDepsArgs,
    catalog: {
      /** IPC依存の構成だけを試すため、モデルカタログを空にする。 */
      getModelCatalog: () => ({ providers: [] }),
    } satisfies MainIpcCatalogDepsArgs,
    settings: {
      /** 実行元のパッケージ版に依存しない版表示を返す。 */
      getAppVersion: () => "1.0.0",
      /** 利用者の設定を読まずアプリの既定設定を使う。 */
      getAppSettings: () => createDefaultAppSettings(),
      /** 永続化せず、渡された設定を更新後の値として返す。 */
      updateAppSettings: (settings) => settings,
      /** チャット配置設定は本ケースで変更せず、依存の型だけ満たす。 */
      updateChatLayoutPreference: () => ({}) as never,
      /** 実データベースの診断を呼ばずに設定用依存を組み立てる。 */
      getAppDatabaseDiagnostics: () => ({}) as never,
      /** クリーンアップの候補探索は行わず、登録用の依存を満たす。 */
      scanSessionFolderCleanup: async () => ({}) as never,
      /** クリーンアップでディレクトリを削除せず、設定の登録だけを支える。 */
      runSessionFolderCleanup: async () => ({}) as never,
      /** 未実施を返し、利用中DBの初期化を行わない。 */
      async resetAppDatabase() {
        return null;
      },
    } satisfies MainIpcSettingsDepsArgs,
    promptTemplates: {
      /** プロンプトテンプレートを空の一覧として供給する。 */
      listPromptTemplates: () => [],
      /** 追加のダミー応答だけを返し、テンプレートを保存しない。 */
      createPromptTemplate: () => [],
      /** 更新後のダミー一覧を返し、既存テンプレートを保持しない。 */
      updatePromptTemplate: () => [],
      /** 削除用の依存を満たすが永続データには触れない。 */
      deletePromptTemplate: () => [],
    } satisfies MainIpcPromptTemplateDepsArgs,
    sessionQuery: {
      /** Monitor問い合わせに親もAuxiliaryもない終端ページを返す。 */
      listSessionMonitorPage: () => ({
        entries: [],
        auxiliarySessions: [],
        nextCursor: null,
        hasMore: false,
      }),
      /** Session要約一覧は追加ページのない空結果とする。 */
      listSessionSummaryPage: () => ({
        entries: [],
        nextCursor: null,
        hasMore: false,
      }),
      /** CharacterのSession利用履歴を持たないfixtureとする。 */
      listSessionCharacterUsage: () => [],
      /** 既存の最新Turnを参照させず、window委譲だけを検証する。 */
      getLatestSessionTurn: () => null,
      /** 既定で未読の結果はない。 */
      getUnreadSessionResult: () => null,
      /** 既読化して変更された結果がないことを返す。 */
      markSessionResultRead: () => false,
      /** Sessionに固有のスキル候補を探索しない。 */
      async listSessionSkills() {
        return [];
      },
      /** Sessionに固有のカスタムAgent候補を返さない。 */
      async listSessionCustomAgents() {
        return [];
      },
      /** workspaceに置かれたスキル一覧は空とする。 */
      async listWorkspaceSkills() {
        return [];
      },
      /** workspaceのカスタムAgent一覧は空とする。 */
      async listWorkspaceCustomAgents() {
        return [];
      },
      /** 既存ウィンドウの列挙を空ページにし、復元候補と混ぜない。 */
      listOpenSessionWindowIdsPage: () => ({
        sessionIds: [],
        nextCursor: null,
        hasMore: false,
      }),
      /** Session照会で返す永続データは用意しない。 */
      getSession: () => null,
      /** 個別Sessionの要約を用意しない。 */
      getSessionSummary: () => null,
      /** 要求されたSessionを保持し、用語集ファイル不在の投影を返す。 */
      getSessionGlossaryProjection: (sessionId: string) => ({
        sessionId,
        scopeRevision: "scope",
        sequence: 1,
        checkout: { repositoryName: "repo", branch: "main", pathLabel: "repo" },
        state: {
          status: "missing",
          relativePath: ".withmate/glossary.yaml",
          revision: null,
        },
      }),
      /** 用語集検索を、revisionも結果もない正常応答にする。 */
      searchSessionGlossary: () => ({
        ok: true,
        revision: null,
        entries: [],
        total: 0,
        offset: 0,
        pageSize: 50,
      }),
      /** 用語集の変更通知を実際には購読しない。 */
      ensureSessionGlossarySubscription: () => {},
      /** 既存メッセージに添付されたartifactはない。 */
      getSessionMessageArtifact: () => null,
      /** 既存の差分プレビューを提供しない。 */
      getDiffPreview: () => null,
      /** コンポーザー入力のプレビュー解決を実行しない。 */
      async previewComposerInput() {
        return null;
      },
      /** ファイル探索の所有Session解決へ意図せず進んだ場合に検知する。 */
      getSessionFileExplorerOwnerSessionId: async () => {
        throw new Error("unused session query fixture method");
      },
      /** Sessionのピン留めファイルを空集合として返す。 */
      listSessionFilePins: async () => [],
      /** ファイルをピン留めする変更はこの経路では行わない。 */
      pinSessionFile: async () => {
        throw new Error("unused");
      },
      /** 外すべきピンはないため変更を記録しない。 */
      unpinSessionFile: async () => {},
      /** ファイルルートの探索は登録依存の組み立てだけでは不要とする。 */
      listSessionFileRoots: async () => {
        throw new Error("unused session query fixture method");
      },
      /** ディレクトリ読込みが呼び出された場合に検知する。 */
      listSessionDirectory: async () => {
        throw new Error("unused session query fixture method");
      },
      /** ローカルファイルの種別判定まで進まないことを検知する。 */
      inspectSessionFile: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 登録依存の検証ではHTML本体を読み込まない。 */
      readSessionHtmlPreview: async () => {
        throw new Error("unused");
      },
      /** 画像の調査は利用しないため、呼ばれた場合に失敗する。 */
      inspectSessionImage: async () => {
        throw new Error("unused session query fixture method");
      },
      /** PDFメタデータの調査をこのfixtureから除外する。 */
      inspectSessionPdf: async () => {
        throw new Error("unused session query fixture method");
      },
      /** PDF内容を部分読み込みする経路へ進んだ場合に検知する。 */
      readSessionPdfChunk: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 画像データの部分取得は利用せず、呼ばれた場合に検知する。 */
      readSessionImageChunk: async () => {
        throw new Error("unused session query fixture method");
      },
      /** ファイルチャンクの読取りが要求された場合に検知する。 */
      readSessionFileChunk: async () => {
        throw new Error("unused session query fixture method");
      },
      /** Sessionのファイルをアプリ外で開く操作は検証外とする。 */
      openSessionFile: async () => {
        throw new Error("unused session query fixture method");
      },
      /** ファイル用のプレビュー窓が意図せず作られた場合に検知する。 */
      openSessionFilePreviewWindow: async () => {
        throw new Error("unused session query fixture method");
      },
      /** ファイルプレビュー用のpayload取得はウィンドウ委譲の検証に含めない。 */
      getSessionFilePreviewWindowPayload: () => {
        throw new Error("unused session query fixture method");
      },
      /** ファイルルートの変更一覧を調べる経路は検証外とする。 */
      listFileRootChanges: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 変更一覧用のリポジトリ探索が始まった場合に検知する。 */
      listFileRootChangesRepositories: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 作業ツリー差分の取得を要求した場合に検知する。 */
      getFileRootDiff: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 履歴を提供するリポジトリの列挙はこのfixtureで行わない。 */
      listFileRootGitHistoryRepositories: async () => {
        throw new Error("unused session query fixture method");
      },
      /** ファイルルートの履歴コミットを読もうとした場合に検知する。 */
      listFileRootGitHistoryCommits: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 履歴コミット個別の詳細問い合わせはこのケースに含まれない。 */
      getFileRootGitHistoryCommitDetail: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 履歴の比較対象を指定する問い合わせは検証外とする。 */
      getFileRootGitHistoryComparison: async () => {
        throw new Error("unused session query fixture method");
      },
      /** 履歴差分の本文取得が起きた場合に検知する。 */
      getFileRootGitHistoryDiff: async () => {
        throw new Error("unused session query fixture method");
      },
    } satisfies MainIpcSessionQueryDepsArgs,
    sessionInstructions: {
      /** Instructionsの要求元となる所有ウィンドウを設けない。 */
      resolveOwningSessionWindow: () => null,
      /** 既存のSession指示文は空とする。 */
      getSessionInstructions: () => "",
      /** 指示の永続化は行わず、空の書込み結果を返す。 */
      setSessionInstructions: () => ({ byteLength: 0 }),
    },
    sessionRuntime: {
      /** 進行中のSession実行は存在しない設定にする。 */
      getLiveSessionRun: () => null,
      /** Provider使用量を読みに行かず、未取得状態を返す。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** Sessionのコンテキスト残量は計測しない。 */
      getSessionContextTelemetry: () => null,
      /** 承認を待っている実行がないため承認の決定を反映しない。 */
      resolveLiveApproval: () => {},
      /** 入力待ちの問い合わせがないため応答を保存しない。 */
      resolveLiveElicitation: () => {},
      /** Session作成を実行せず、その登録に必要な依存だけを供給する。 */
      createSession: () => ({}) as never,
      /** Session更新を永続化せずに登録依存を満たす。 */
      updateSession: () => ({}) as never,
      /** 追加ディレクトリの変更を実ファイル探索へ反映しない。 */
      changeSessionAdditionalDirectory: () => {},
      /** 実行設定への書込みが生じた場合に検知する。 */
      setSessionExecutionOptions: () => {
        throw new Error("not used");
      },
      /** 対象Sessionのタイトル変更を誤って呼んだ場合に検知する。 */
      setSessionTitle: () => {
        throw new Error("not used");
      },
      /** メッセージへのブックマーク設定は検証範囲外とする。 */
      setSessionMessageBookmark: () => {
        throw new Error("not used");
      },
      /** Session削除にDBやファイルシステムの副作用を加えない。 */
      deleteSession: () => {},
      /** 期限で削除またはスキップする既存Sessionを持たない。 */
      deleteSessionsLastActiveBefore: () => ({
        deletedSessionIds: [],
        skippedRunningSessionIds: [],
      }),
      /** Providerを起動せずに実行依存に必要な戻り値だけを供給する。 */
      async runSessionTurn() {
        return {} as never;
      },
      /** 実行取消を適用する進行中Turnはない。 */
      cancelSessionRun: () => {},
      /** Sessionを固定する操作が利用された場合に検知する。 */
      setSessionPinned: () => {
        throw new Error("not used");
      },
    },
    character: {
      /** 選択画面で利用するCharacter一覧を空にする。 */
      async listCharacters() {
        return [];
      },
      /** Character詳細を解決する永続データは用意しない。 */
      async getCharacter() {
        return null;
      },
      /** 新規Characterの保存はせず、登録時の型だけを満たす。 */
      async createCharacter() {
        return {} as never;
      },
      /** 名前などのメタデータ編集はこのケースでは永続化しない。 */
      async updateCharacterMetadata() {
        return {} as never;
      },
      /** Characterの定義編集をファイルへ反映しない。 */
      async updateCharacterDefinition() {
        return {} as never;
      },
      /** Characterのアーカイブで実データを変更しない。 */
      async archiveCharacter() {
        return {} as never;
      },
      /** 起動時に採用するCharacterを返さない。 */
      async resolveLaunchCharacter() {
        return null;
      },
      /** Character作成支援用のSessionを開始した場合に検知する。 */
      async startCharacterAuthoringSession() {
        throw new Error("not used");
      },
    },
    mate: {
      /** Mate状態の委譲を記録し、まだ作成されていないことを返す。 */
      getMateState() {
        calls.push("getMateState");
        return "not_created";
      },
      /** プロフィール照会を記録し、プロフィールがない場合を返す。 */
      getMateProfile() {
        calls.push("getMateProfile");
        return null;
      },
      /** 作成要求の表示名を記録して、引数が維持されたか確認できるようにする。 */
      async createMate(input) {
        calls.push(`createMate:${input.displayName}`);
        return {} as never;
      },
      /** 更新後の表示名を記録し、作成時と別の要求を受け取ったことを検証する。 */
      async updateMate(input) {
        calls.push(`updateMate:${input.displayName}`);
        return {} as never;
      },
      /** 受け取ったアバターのパスを記録し、未指定時はクリア操作と区別する。 */
      async setMateAvatar(input) {
        calls.push(`setMateAvatar:${input.avatarFilePath ?? "clear"}`);
        return {} as never;
      },
      /** Mate初期化の委譲を記録し、利用者データは消さない。 */
      async resetMate() {
        calls.push("resetMate");
      },
    },
  });

  assert.equal(await deps.window.openHomeWindow(), undefined);
  assert.equal(
    deps.common.acknowledgeSessionDraftFlush,
    acknowledgeSessionDraftFlush,
  );
  const sender = {} as WebContents;
  const payload = { requestId: "flush-1", success: true };
  deps.common.acknowledgeSessionDraftFlush({ sender }, payload);
  assert.deepEqual(acknowledged, { sender, payload });
  assert.equal(deps.settings.isSettingsWindow({} as never), true);
  assert.equal(
    await deps.window.openSessionWindow("session-1", "aux-1"),
    undefined,
  );
  assert.deepEqual(await deps.window.getSessionWindowRestoreSet(), [
    "session-1",
  ]);
  assert.deepEqual(
    (await deps.window.restoreSessionWindows()).openedSessionIds,
    ["session-1"],
  );
  const contextMenuEvent = { sender: "monitor" };
  const contextMenuRequest = {
    sessionId: "session-1",
    point: { x: 12, y: 34 },
  };
  assert.deepEqual(
    await deps.window.showSessionMonitorContextMenu(
      contextMenuEvent as never,
      contextMenuRequest as never,
    ),
    { status: "dismissed" },
  );
  assert.deepEqual(contextMenuArgs, [[contextMenuEvent, contextMenuRequest]]);
  await deps.mate.getMateState();
  await deps.mate.getMateProfile();
  await deps.mate.createMate({ displayName: "Buddy" });
  await deps.mate.updateMate({ displayName: "Buddy 2" });
  await deps.mate.setMateAvatar({ avatarFilePath: "C:/avatar.png" });
  await deps.mate.resetMate();
  assert.deepEqual(calls, [
    "openHome",
    "isSettings",
    "openSession:session-1:aux-1",
    "getSessionWindowRestoreSet",
    "restoreSessionWindows",
    "showSessionMonitorContextMenu",
    "getMateState",
    "getMateProfile",
    "createMate:Buddy",
    "updateMate:Buddy 2",
    "setMateAvatar:C:/avatar.png",
    "resetMate",
  ]);
});
