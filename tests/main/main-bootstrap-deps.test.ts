import assert from "node:assert/strict";
import test from "node:test";

import { createMainBootstrapDeps } from "../../src-electron/app/main-bootstrap-deps.js";
import type {
  MainIpcCatalogDepsArgs,
  MainIpcPromptTemplateDepsArgs,
  MainIpcSessionQueryDepsArgs,
  MainIpcSettingsDepsArgs,
  MainIpcWindowDepsArgs,
} from "../../src-electron/app/main-ipc-deps.js";

// @test-value v2
// kind = "contract"
// claim = "main bootstrapはHome起動とSession Monitor context menuのdelegateを取り違えずwindow IPC registration depsへ渡す"
// oracle = { type = "contract", ref = "src-electron/ipc/window.ts: registerWindowHandlersのopenHomeWindow/showSessionMonitorContextMenu consumer" }
// fault = "Home IPCにbootstrap用の起動を誤配線する、またはSession Monitor context menu delegateを欠落・置換する"
// observable = "window registration depsのHome IPC呼び出しlogとSession Monitor delegate identity"
// observation_boundary = "implementation"
// scope = "main bootstrap grouped window IPC deps"
// lifecycle = "permanent"
// impact = "Homeの表示またはSession Monitorの右クリック操作が対応するMain処理へ届かなくなる"
// distinction = "window delegateのgroupingだけを検証し、IPC channel登録とnative menu selectionは別testで扱う"
// @end-test-value
/** 起動直後の初期化・登録・通知の順序と、Window IPC に渡された Home および Monitor の委譲先を検証する。 */
test("createMainBootstrapDeps は grouped IPC deps を組み立てて registerMainIpcHandlers に渡す", async () => {
  const calls: string[] = [];
  let receivedDeps: unknown = null;
  /** Monitor の右クリックに渡す独立した関数を用意し、登録時の関数同一性を比較する。 */
  const showSessionMonitorContextMenu = async () => ({
    status: "dismissed" as const,
  });
  /** Home を開く IPC 側の入口を記録し、初期化時の処理と区別する。 */
  const openHomeWindow = async () => {
    calls.push("openHomeIpc");
    return {} as never;
  };

  const deps = createMainBootstrapDeps({
    ipcMain: {} as never,
    /** 実 IPC を登録せず、構築済みの引数と登録時点を捕捉する。 */
    registerMainIpcHandlers(_ipcMain, registrationDeps) {
      calls.push("registerIpcHandlers");
      receivedDeps = registrationDeps;
    },
    /** 永続ストアの初期化を記録し、後続通知で確認できる空のカタログを返す。 */
    async initializePersistentStores() {
      calls.push("initialize");
      return { providers: [] };
    },
    /** 中断会話の復旧が要求された場合を、呼び出し列で区別できるようにする。 */
    async recoverInterruptedSessions() {
      calls.push("recover");
    },
    /** 初期化で得た値がモデル更新の通知まで渡ったことを確認する。 */
    broadcastModelCatalog(snapshot) {
      assert.deepEqual(snapshot, { providers: [] });
      calls.push("broadcast");
    },
    ipcRegistration: {
      window: {
        /** 子会話や次ページを持たない Home の一覧として、IPC の型を満たす。 */
        async listHomeCrewPage() {
          return {
            entries: [],
            auxiliarySessions: [],
            nextCursor: null,
            hasMore: false,
          };
        },
        /** Home の一覧メニューは項目を選択せずに閉じる。 */
        async showHomeCrewContextMenu() {
          return { status: "dismissed" };
        },
        /** プレビューのコンテキスト操作で選択が行われない固定応答を返す。 */
        async showSessionFilePreviewContextMenu() {
          return "dismissed";
        },
        /** 一覧に開いているファイルプレビューを含めない。 */
        async listSessionFilePreviewWindows() {
          return [];
        },
        /** 実プレビューを生成しないため、既存ウィンドウの前面化は行わない。 */
        focusSessionFilePreviewWindow() {},
        /** 指定されたプレビューを閉じる OS 操作は行わない。 */
        closeSessionFilePreviewWindow() {},
        /** プレビューの一括閉鎖を伴わない登録用の代役とする。 */
        closeSessionFilePreviewWindows() {},
        /** 起動時の依存組み立てで下書き保存完了を処理した場合は失敗させる。 */
        acknowledgeSessionDraftFlush: () => {
          throw new Error("unused window fixture method");
        },
        /** IPC の送信元に対応する実ウィンドウは供給しない。 */
        resolveEventWindow: () => null,
        /** Home 表示の委譲とは別に、既存 Home の検索結果を空にする。 */
        resolveHomeWindow: () => null,
        /** 会話 ID に対応する実ウィンドウは存在しない状態にする。 */
        resolveSessionWindow: () => null,
        /** 会話の画面は実際に開かず、型上のハンドルだけを返す。 */
        openSessionWindow: async () => ({}) as never,
        /** 依存登録中に復元対象の検索を始めた場合は想定外とする。 */
        getSessionWindowRestoreSet: async () => {
          throw new Error("unused window fixture method");
        },
        /** ウィンドウ復元の副作用を登録時に起こさない。 */
        restoreSessionWindows: async () => {
          throw new Error("unused window fixture method");
        },
        openHomeWindow,
        /** Monitor の起動方法ではなくメニューの委譲を調べるため、代用ハンドルを返す。 */
        openSessionMonitorWindow: async () => ({}) as never,
        /** 既存のウィンドウを Monitor として扱わない。 */
        isSessionMonitorWindow: () => false,
        showSessionMonitorContextMenu,
        /** 設定ウィンドウを作らず、登録用のダミーのハンドルを返す。 */
        openSettingsWindow: async () => ({}) as never,
        /** 設定ウィンドウと一致する送信元を供給しない。 */
        isSettingsWindow: () => false,
        /** キャラクター編集のための実画面は作らない。 */
        openCharacterEditorWindow: async () => ({}) as never,
        /** 差分表示の呼び出しに実 Electron のハンドルを要求しない。 */
        openDiffWindow: async () => ({}) as never,
        /** ファイルプレビューの送信元判定はこの登録手順で使わない。 */
        isFilePreviewWindow: () => {
          throw new Error("unused window fixture method");
        },
        /** プレビュー対象の照会が登録時に行われたら誤った副作用として検出する。 */
        getFilePreviewWindowResource: () => {
          throw new Error("unused window fixture method");
        },
        /** プレビューのトークンを検証する経路まで起動時に進まない。 */
        isFilePreviewTokenWindow: () => {
          throw new Error("unused window fixture method");
        },
        /** ディレクトリの選択は取り消した結果を返す。 */
        pickDirectory: async () => null,
        /** 作業場所としては有効とみなし、実際のディスクを検査しない。 */
        validateWorkspaceDirectory: async () => ({ valid: true }),
        /** 単一ファイルのダイアログでは選択がなかったものとする。 */
        pickFile: async () => null,
        /** 複数選択の結果にはファイルを含めない。 */
        pickFiles: async () => [],
        /** 会話へ取り込むファイルは選択しない。 */
        pickSessionFiles: async () => [],
        /** Session Folder の選択を行わず、未選択を返す。 */
        pickSessionFolder: async () => null,
        /** 会話に添付する画像の選択は行わない。 */
        pickSessionImageFile: async () => null,
        /** 一般の画像選択ダイアログにも実ファイルを渡さない。 */
        pickImageFile: async () => null,
        /** Session Folder に実際にコピーしたファイルはないものとする。 */
        copyFilesToSessionFiles: async () => [],
        /** 貼り付け保存で実ファイルや保存先を作らない。 */
        savePastedSessionFile: async () => "",
        /** Session Folder をエクスプローラーに開かない登録用の代役。 */
        openSessionFilesDirectory: async () => {},
        /** Session Folder を起点にターミナルを起動しない。 */
        openSessionFilesTerminal: async () => {},
        /** 画像のコピーは OS に書き込まず、固定の成功結果を返す。 */
        copySessionFilePreviewImage: async () => ({ status: "copied" }),
        /** 画像プレビューのメニューでは項目を選択しない。 */
        showSessionFilePreviewImageContextMenu: async () => ({
          status: "dismissed",
        }),
        /** 登録処理だけでファイルオブジェクトのコピーを試みたら失敗させる。 */
        copySessionFileObject: async () => {
          throw new Error("unused window fixture method");
        },
        /** ファイルオブジェクトのコピー用メニューはこの起動検証で開かない。 */
        showSessionFileObjectCopyContextMenu: async () => {
          throw new Error("unused window fixture method");
        },
        /** ファイルツリーのメニューが依存の組み立て中に表示されないことを守る。 */
        showSessionFileTreeContextMenu: async () => {
          throw new Error("unused window fixture method");
        },
        /** Markdown リンクのメニュー処理へ誤って進んだ場合には失敗させる。 */
        showMarkdownLinkContextMenu: async () => {
          throw new Error("unused window fixture method");
        },
        /** 関連アプリを起動せず、ローカルパスを開いた形の固定結果を返す。 */
        openPathTarget: async () => ({
          status: "opened",
          targetType: "local-path",
          target: "",
        }),
        /** ログフォルダーを実際に開かない。 */
        openAppLogFolder: async () => {},
        /** クラッシュダンプフォルダーを閲覧する OS 操作を実行しない。 */
        openCrashDumpFolder: async () => {},
        /** 会話の作業場所からターミナルを実起動しない。 */
        openSessionTerminal: async () => {},
        /** 任意パスへのターミナル起動を検証用プロセスから行わない。 */
        openTerminalAtPath: async () => {},
      } satisfies MainIpcWindowDepsArgs,
      catalog: {
        /** 登録用にも初期化結果と同じく候補なしのカタログを返す。 */
        getModelCatalog: () => ({ providers: [] }),
      } satisfies MainIpcCatalogDepsArgs,
      settings: {
        /** 設定の IPC 依存に外部の版情報ではなく固定バージョンを供給する。 */
        getAppVersion: () => "1.0.0",
        /** 個別設定のない provider 設定だけを登録用に用意する。 */
        getAppSettings: () =>
          ({ providers: {}, codingProviderSettings: {} }) as never,
        /** 設定を書き込まず、受け取った値をそのまま返す。 */
        updateAppSettings: (settings) => settings,
        /** チャットの配置設定は実ストアへ保存しない。 */
        updateChatLayoutPreference: () => ({}) as never,
        /** 診断エンドポイントの登録に、実データベースを要求しない。 */
        getAppDatabaseDiagnostics: () => ({}) as never,
        /** 保存フォルダーの整理候補を取りに行かない。 */
        scanSessionFolderCleanup: async () => ({}) as never,
        /** 整理操作が実ファイルを変更しないよう、ダミー結果を返す。 */
        runSessionFolderCleanup: async () => ({}) as never,
        /** データベースを初期化し直さず、リセット結果なしを返す。 */
        resetAppDatabase: async () => null,
      } satisfies MainIpcSettingsDepsArgs,
      promptTemplates: {
        /** 保存済みのプロンプトテンプレートがない状態を表す。 */
        listPromptTemplates: () => [],
        /** 作成を登録しても実テンプレートを作らない。 */
        createPromptTemplate: () => [],
        /** 更新後の一覧として空を返し、書き込みを行わない。 */
        updatePromptTemplate: () => [],
        /** 削除後の一覧にテンプレートを含めず、既存データも操作しない。 */
        deletePromptTemplate: () => [],
      } satisfies MainIpcPromptTemplateDepsArgs,
      sessionQuery: {
        /** Monitor の一覧取得は委譲確認に不要で、登録時に実行されたら失敗とする。 */
        listSessionMonitorPage: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 会話要約のページを組み立てる問い合わせは開始しない。 */
        listSessionSummaryPage: async () => {
          throw new Error("unused session query fixture method");
        },
        /** キャラクター利用状況の集計が登録時に動いた場合を検出する。 */
        listSessionCharacterUsage: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 会話の最新 turn は存在しない固定状態にする。 */
        getLatestSessionTurn: () => null,
        /** 未読と表示する終了結果はないものとする。 */
        getUnreadSessionResult: () => null,
        /** 既読に変更した結果はないものとして応答する。 */
        markSessionResultRead: () => false,
        /** 会話固有スキルを列挙せず、空の候補を返す。 */
        async listSessionSkills() {
          return [];
        },
        /** 会話にひもづくカスタムエージェントの候補を供給しない。 */
        async listSessionCustomAgents() {
          return [];
        },
        /** 作業領域のスキル探索は行わず、空一覧にする。 */
        async listWorkspaceSkills() {
          return [];
        },
        /** 作業領域にカスタムエージェントを検出したことにはしない。 */
        async listWorkspaceCustomAgents() {
          return [];
        },
        /** 開いている会話ウィンドウの ID も次ページも供給しない。 */
        listOpenSessionWindowIdsPage: () => ({
          sessionIds: [],
          nextCursor: null,
          hasMore: false,
        }),
        /** 個別の会話を実ストレージから読み込まない。 */
        getSession: () => null,
        /** 会話要約を検索しても見つからない固定の代役。 */
        getSessionSummary: () => null,
        /** 会話 ID を反映し、現在の checkout に用語集がまだない投影を返す。 */
        getSessionGlossaryProjection: (sessionId: string) => ({
          sessionId,
          scopeRevision: "scope",
          sequence: 1,
          checkout: {
            repositoryName: "repo",
            branch: "main",
            pathLabel: "repo",
          },
          state: {
            status: "missing",
            relativePath: ".withmate/glossary.yaml",
            revision: null,
          },
        }),
        /** 用語集の検索は成功として扱うが、一致項目は返さない。 */
        searchSessionGlossary: () => ({
          ok: true,
          revision: null,
          entries: [],
          total: 0,
          offset: 0,
          pageSize: 50,
        }),
        /** 登録テストでは用語集の実ファイル監視を設けない。 */
        ensureSessionGlossarySubscription: () => {},
        /** 履歴にひもづく保存済みアーティファクトは供給しない。 */
        getSessionMessageArtifact: () => null,
        /** 差分プレビューの生成結果を持たない状態にする。 */
        getDiffPreview: () => null,
        /** Composer 入力を処理せず、プレビューを返さない。 */
        previewComposerInput: async () => null,
        /** ファイル閲覧の所有会話を起動時に探索した場合は予期しない問い合わせとする。 */
        getSessionFileExplorerOwnerSessionId: async () => {
          throw new Error("unused session query fixture method");
        },
        /** この構成にはピン留めされた会話ファイルを持たせない。 */
        listSessionFilePins: async () => [],
        /** 起動依存の登録からピンの追加に進んだ場合は失敗させる。 */
        pinSessionFile: async () => {
          throw new Error("unused");
        },
        /** ピンの解除を模擬しても保存済みデータは変更しない。 */
        unpinSessionFile: async () => {},
        /** 登録だけで会話のファイルルートを列挙しない。 */
        listSessionFileRoots: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 会話ディレクトリの実内容を読み始めた場合を検出する。 */
        listSessionDirectory: async () => {
          throw new Error("unused session query fixture method");
        },
        /** ファイルの詳細情報を IPC 登録時に照会した場合は失敗させる。 */
        inspectSessionFile: async () => {
          throw new Error("unused session query fixture method");
        },
        /** HTML のプレビュー内容はこの依存組み立てで読まない。 */
        readSessionHtmlPreview: async () => {
          throw new Error("unused");
        },
        /** 画像の形式やサイズなどのメタデータ取得は起動処理と分ける。 */
        inspectSessionImage: async () => {
          throw new Error("unused session query fixture method");
        },
        /** PDF の情報を先読みしようとした場合は失敗させる。 */
        inspectSessionPdf: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 登録時に PDF の一部を要求した場合を検出する。 */
        readSessionPdfChunk: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 画像のチャンク読み込みには到達しない前提とする。 */
        readSessionImageChunk: async () => {
          throw new Error("unused session query fixture method");
        },
        /** ファイル本文のチャンクを登録段階で読み込ませない。 */
        readSessionFileChunk: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 依存登録からファイルを関連アプリで開く処理へ進まない。 */
        openSessionFile: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 画面を組み立てるテストではないので、新たなプレビューを開かない。 */
        openSessionFilePreviewWindow: async () => {
          throw new Error("unused session query fixture method");
        },
        /** プレビューウィンドウ用の表示データをこのテストでは生成しない。 */
        getSessionFilePreviewWindowPayload: () => {
          throw new Error("unused session query fixture method");
        },
        /** 作業場所の差分一覧へアクセスした場合を検出する。 */
        listFileRootChanges: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 変更一覧の対象リポジトリ探索は起動時に行わない。 */
        listFileRootChangesRepositories: async () => {
          throw new Error("unused session query fixture method");
        },
        /** ファイル差分の照会を登録そのものの副作用にしない。 */
        getFileRootDiff: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 履歴画面のリポジトリ探索を検証環境で始めない。 */
        listFileRootGitHistoryRepositories: async () => {
          throw new Error("unused session query fixture method");
        },
        /** Git 履歴ページのコミット検索が登録中に起きたら失敗させる。 */
        listFileRootGitHistoryCommits: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 個別コミットの詳細取得はこの起動処理の範囲外とする。 */
        getFileRootGitHistoryCommitDetail: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 履歴比較を始めずに登録を終えることを担保する代役。 */
        getFileRootGitHistoryComparison: async () => {
          throw new Error("unused session query fixture method");
        },
        /** 履歴上のファイル差分を登録時に読み込ませない。 */
        getFileRootGitHistoryDiff: async () => {
          throw new Error("unused session query fixture method");
        },
      } satisfies MainIpcSessionQueryDepsArgs,
      sessionInstructions: {
        /** 指示を編集する会話の所有ウィンドウは供給しない。 */
        resolveOwningSessionWindow: () => null,
        /** 読み取り用には未設定の指示本文を返す。 */
        getSessionInstructions: () => "",
        /** 指示を書き込まず、保存済みの長さをゼロとして返す。 */
        setSessionInstructions: () => ({ byteLength: 0 }),
      },
      sessionRuntime: {
        /** 進行中の実行状態がない状態で依存を渡す。 */
        getLiveSessionRun: () => null,
        /** provider の利用枠をネットワークから取得しない。 */
        getProviderQuotaTelemetry: async () => null,
        /** 会話コンテキスト使用量の観測値は提供しない。 */
        getSessionContextTelemetry: () => null,
        /** 実行中の承認を解決する副作用は持たせない。 */
        resolveLiveApproval: () => {},
        /** 利用者への質問に対する実際の回答を送らない。 */
        resolveLiveElicitation: () => {},
        /** 会話作成の呼び出し型を満たすが、永続化はしない。 */
        createSession: () => ({}) as never,
        /** 既存会話のメタデータへ変更を書き込まない。 */
        updateSession: () => ({}) as never,
        /** 追加ディレクトリの設定を維持し、実ファイルの権限を変更しない。 */
        changeSessionAdditionalDirectory: () => {},
        /** 登録だけで実行オプションを更新しようとした場合は失敗させる。 */
        setSessionExecutionOptions: () => {
          throw new Error("not used");
        },
        /** 起動時の組み立てで会話タイトルが変更されないようにする。 */
        setSessionTitle: () => {
          throw new Error("not used");
        },
        /** ブックマーク変更まで実行された場合は想定外とする。 */
        setSessionMessageBookmark: () => {
          throw new Error("not used");
        },
        /** 会話削除を実ストアへ適用しない。 */
        deleteSession: () => {},
        /** 期限による一括削除で、削除済み会話も実行中でスキップした会話もないと返す。 */
        deleteSessionsLastActiveBefore: () => ({
          deletedSessionIds: [],
          skippedRunningSessionIds: [],
        }),
        /** 会話の実行を始めず、provider へ接続しない。 */
        runSessionTurn: async () => ({}) as never,
        /** 停止させる実行プロセスを用意しない。 */
        cancelSessionRun: () => {},
        /** 起動処理がピン留め状態を変更した場合を検出する。 */
        setSessionPinned: () => {
          throw new Error("not used");
        },
      },
      character: {
        /** 登録時の一覧に実キャラクターを含めない。 */
        listCharacters: async () => [],
        /** 指定キャラクターの永続レコードを読み出さない。 */
        getCharacter: async () => null,
        /** キャラクター定義や実ファイルを生成しない。 */
        createCharacter: async () => ({}) as never,
        /** 編集メタデータを書き戻さず、型を満たすダミー応答を使う。 */
        updateCharacterMetadata: async () => ({}) as never,
        /** 定義本文を更新せず、保存先にも触れない。 */
        updateCharacterDefinition: async () => ({}) as never,
        /** キャラクターを実際にアーカイブしない。 */
        archiveCharacter: async () => ({}) as never,
        /** 起動用キャラクターの選択結果を空にする。 */
        resolveLaunchCharacter: async () => null,
        /** キャラクター制作セッションの開始は依存登録中に行わない。 */
        startCharacterAuthoringSession: async () => {
          throw new Error("not used");
        },
      },
      mate: {
        /** Mate の未作成状態を固定して返す。 */
        getMateState: () => "not_created",
        /** 読み込む Mate のプロフィールは存在しない。 */
        getMateProfile: () => null,
        /** Mate を作成する実処理を使わず、ダミーの応答を返す。 */
        createMate: async () => ({}) as never,
        /** Mate の設定変更を永続化しない。 */
        updateMate: async () => ({}) as never,
        /** アバター画像の取り込みは行わない。 */
        setMateAvatar: async () => ({}) as never,
        /** Mate の既存データを削除せず、初期化依存だけを用意する。 */
        resetMate: async () => {},
      },
    },
  });

  const snapshot = await deps.initializePersistentStores();
  deps.registerIpcHandlers();
  deps.broadcastModelCatalog(snapshot);

  await (
    receivedDeps as { window: { openHomeWindow: () => Promise<void> } }
  ).window.openHomeWindow();
  assert.equal(
    (
      receivedDeps as {
        window: {
          showSessionMonitorContextMenu: typeof showSessionMonitorContextMenu;
        };
      }
    ).window.showSessionMonitorContextMenu,
    showSessionMonitorContextMenu,
  );
  assert.deepEqual(calls, [
    "initialize",
    "registerIpcHandlers",
    "broadcast",
    "openHomeIpc",
  ]);
});
