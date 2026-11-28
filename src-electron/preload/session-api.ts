import type { WithMateWindowSessionApi } from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import { READ_SESSION_HTML_PREVIEW } from "../../src-shared/window/html-preview.js";

/** Session の表示・ファイル参照・永続化と Turn 操作を、用途別の Main IPC へ接続する。 */
export function createSessionApi(
  ipcRenderer: IpcRendererLike,
  platform: NodeJS.Platform,
): WithMateWindowSessionApi {
  return {
    /** 対象の Main または Auxiliary を指定し、保存済みの指示本文を読み取る。 */
    getSessionInstructions: (target) =>
      ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_INSTRUCTIONS_CHANNEL,
        target,
      ),
    /** 対象の Session の指示本文を置き換える要求を専用経路へ渡す。 */
    setSessionInstructions: (target, body) =>
      ipcRenderer.invoke(
        channels.WITHMATE_SET_SESSION_INSTRUCTIONS_CHANNEL,
        target,
        body,
      ),
    /** 保存済みの incarnation を指定し、その Crew の削除を妨げる状態を照会する。 */
    getCrewDeletionStatus: (sessionId, incarnationId) =>
      ipcRenderer.invoke(
        "withmate:get-crew-deletion-status",
        sessionId,
        incarnationId,
      ),
    /** 認可された Session ファイルから HTML プレビューの入力を読む。 */
    readSessionHtmlPreview(request) {
      return ipcRenderer.invoke(READ_SESSION_HTML_PREVIEW, request);
    },
    /** ファイルそのものをコピーする操作を利用できるプラットフォームか判定する。 */
    isSessionFileObjectCopyAvailable() {
      return platform === "win32";
    },
    /** 検索・ページング条件を渡して Session の表示用概要を取得する。 */
    listSessionSummaryPage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL,
        request ?? null,
      );
    },
    /** 稼働監視に必要な表示用データをページ単位で取得する。 */
    listSessionMonitorPage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_MONITOR_PAGE_CHANNEL,
        request ?? null,
      );
    },
    /** 保存済みの Session における Character の利用情報をまとめて取得する。 */
    listSessionCharacterUsage() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL,
      );
    },
    /** 指定した Session のウィンドウ表示用情報を取得する。 */
    getSession(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_CHANNEL,
        sessionId,
      );
    },
    /** 指定 Session の会話を、要求された範囲のページとして取得する。 */
    getConversationPage(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_CONVERSATION_PAGE_CHANNEL,
        sessionId,
        request ?? null,
      );
    },
    /** 指定 Session の保存会話を、検索条件と関連する要求識別情報で絞り込む。 */
    searchConversation(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SEARCH_CONVERSATION_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 会話内ジャンプに使うナビゲーターのページを取得する。 */
    listConversationNavigator(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_CONVERSATION_NAVIGATOR_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 対象を識別する要求を用い、処理中の会話照会を取り消す。 */
    cancelConversationQuery(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL,
        request,
      );
    },
    /** 指定 ID の Session 概要だけを専用経路で取得する。 */
    getSessionSummary(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_SUMMARY_CHANNEL,
        sessionId,
      );
    },
    /** Session で利用できる用語集の画面表示用データを取得する。 */
    getSessionGlossaryProjection(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL,
        sessionId,
      );
    },
    /** Session に紐付いた用語集に対し、指定された検索条件を渡す。 */
    searchSessionGlossary(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL,
        sessionId,
        request,
      );
    },
    /** Session の現在のワークスペースが利用できるか確認する。 */
    validateSessionWorkspace(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL,
        sessionId,
      );
    },
    /** 指定パスを対象 Session の追加ディレクトリとして登録できるか確認する。 */
    validateSessionAdditionalDirectory(sessionId, targetPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_VALIDATE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL,
        sessionId,
        targetPath,
      );
    },
    /** ファイル探索で選べる、現在の Session の参照ルートを取得する。 */
    listSessionFileRoots(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL,
        sessionId,
      );
    },
    /** 指定 Session のファイルピン一覧を取得する。 */
    listSessionFilePins(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_FILE_PINS_CHANNEL,
        sessionId,
      );
    },
    /** Session と対象ファイルの参照を渡し、ピン登録を要求する。 */
    pinSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PIN_SESSION_FILE_CHANNEL,
        request,
      );
    },
    /** 対象ファイルのピン登録だけを解除する。ファイルの削除は要求しない。 */
    unpinSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UNPIN_SESSION_FILE_CHANNEL,
        request,
      );
    },
    /** 参照ルート内の指定ディレクトリの内容を取得する。 */
    listSessionDirectory(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL,
        request,
      );
    },
    /** ファイルのメタデータと、利用可能なプレビューの判断に必要な情報を取得する。 */
    inspectSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
        request,
      );
    },
    /** 画像プレビューの表示・読み取り前に、画像の情報を照会する。 */
    inspectSessionImage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL,
        request,
      );
    },
    /** PDF の種類や現在の版など、分割読み取りに必要な情報を照会する。 */
    inspectSessionPdf(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_INSPECT_SESSION_PDF_CHANNEL,
        request,
      );
    },
    /** 指定の PDF の版と範囲を渡し、バイト列の一部を読み取る。 */
    readSessionPdfChunk(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_READ_SESSION_PDF_CHUNK_CHANNEL,
        request,
      );
    },
    /** 大きな画像を一括で転送せず、要求された範囲を読み取る。 */
    readSessionImageChunk(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_READ_SESSION_IMAGE_CHUNK_CHANNEL,
        request,
      );
    },
    /** テキストなどのファイルについて、指定した範囲の内容を取得する。 */
    readSessionFileChunk(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
        request,
      );
    },
    /** Session の文脈で認可するファイルの表示・オープン操作を Main に要求する。 */
    openSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILE_CHANNEL,
        request,
      );
    },
    /** 独立したプレビューが最初に表示する内容を、ウィンドウに渡されたトークンで解決する。 */
    getSessionFilePreviewWindowPayload(token) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
        token,
      );
    },
    /** プレビュー画像を、参照元を照合する Main の処理でクリップボードへコピーする。 */
    copySessionFilePreviewImage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL,
        request,
      );
    },
    /** 画像を表示中のプレビューに、画像向けのネイティブ操作メニューを出す。 */
    showSessionFilePreviewImageContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** 選択した参照先を、パス文字列ではなくファイルそのものとしてコピーするよう要求する。 */
    copySessionFileObject(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL,
        request,
      );
    },
    /** ファイルのコピー対象と画面上の位置を渡してネイティブメニューを開く。 */
    showSessionFileObjectCopyContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** ファイルツリー上の選択対象に対するネイティブ操作メニューを要求する。 */
    showSessionFileTreeContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** 選択した参照ルートの Git 変更一覧を取得する。 */
    listFileRootChanges(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL,
        request,
      );
    },
    /** 変更一覧を表示できるリポジトリの候補を選択ルートから取得する。 */
    listFileRootChangesRepositories(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL,
        request,
      );
    },
    /** 作業ツリーまたは index の指定されたファイル差分を取得する。 */
    getFileRootDiff(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL,
        request,
      );
    },
    /** 選択ルート内で Git 履歴を表示できるリポジトリ候補を取得する。 */
    listFileRootGitHistoryRepositories(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL,
        request,
      );
    },
    /** 履歴で選択したリポジトリのコミット一覧を指定条件で取得する。 */
    listFileRootGitHistoryCommits(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL,
        request,
      );
    },
    /** 選んだコミットの識別情報と変更一覧を取得する。 */
    getFileRootGitHistoryCommitDetail(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL,
        request,
      );
    },
    /** 履歴で指定した比較端点に対応する変更一覧を取得する。 */
    getFileRootGitHistoryComparison(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL,
        request,
      );
    },
    /** コミット履歴の比較対象について指定ファイルの差分を取得する。 */
    getFileRootGitHistoryDiff(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL,
        request,
      );
    },
    /** 会話の保存メッセージに属する成果物を、Session ID とメッセージ位置から取得する。 */
    getSessionMessageArtifact(sessionId, messageIndex) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
        sessionId,
        messageIndex,
      );
    },
    /** 初期設定を渡して新しい Session の作成を要求する。 */
    createSession(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_SESSION_CHANNEL,
        input,
      );
    },
    /** Session の更新候補を保存処理へ渡す。保存境界は Main が担う。 */
    updateSession(session) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_SESSION_CHANNEL,
        session,
      );
    },
    /** 追加ディレクトリの登録・解除を、専用の変更要求として渡す。 */
    changeSessionAdditionalDirectory(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CHANGE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL,
        request,
      );
    },
    /** 対象 Session の今後の Turn で使う実行設定だけを更新する。 */
    setSessionExecutionOptions(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_SESSION_EXECUTION_OPTIONS_CHANNEL,
        request,
      );
    },
    /** 対象 Session の件名変更を専用の保存経路へ渡す。 */
    setSessionTitle(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_SESSION_TITLE_CHANNEL,
        request,
      );
    },
    /** 対象の incarnation を指定し、統括 Role へ変更できるか Main に要求する。 */
    promoteSessionToOverallCoordinator(sessionId, incarnationId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL,
        sessionId,
        incarnationId,
      );
    },
    /** 保存されたメッセージのブックマークを、指定された状態に変更する。 */
    setSessionMessageBookmark(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_SESSION_MESSAGE_BOOKMARK_CHANNEL,
        request,
      );
    },
    /** 対象 Session を一覧でピン留め、または解除する。 */
    setSessionPinned(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_SESSION_PINNED_CHANNEL,
        request,
      );
    },
    /** 指定 Session を保存データから削除するよう Main に要求する。 */
    deleteSession(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_DELETE_SESSION_CHANNEL,
        sessionId,
      );
    },
    /** 送信前の本文を添付候補のプレビューに変換する。 */
    previewComposerInput(sessionId, userMessage) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
        sessionId,
        userMessage,
      );
    },
    /** Session に保存されたプロバイダーと作業範囲で使える Skill を列挙する。 */
    listSessionSkills(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
        sessionId,
      );
    },
    /** Session の実行環境にあるカスタム Agent の候補を取得する。 */
    listSessionCustomAgents(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
        sessionId,
      );
    },
    /** 設定中のプロバイダーとワークスペースから、利用可能な Skill を調べる。 */
    listWorkspaceSkills(providerId, workspacePath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
        providerId,
        workspacePath,
      );
    },
    /** プロバイダーとワークスペースを明示してカスタム Agent の候補を取得する。 */
    listWorkspaceCustomAgents(providerId, workspacePath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
        providerId,
        workspacePath,
      );
    },
    /** 指定 Session で新しい Turn を開始する要求を Main へ渡す。 */
    runSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RUN_SESSION_TURN_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 新規 Turn として待たせず、すでに実行中の Turn に追加入力を送る。 */
    steerSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_STEER_SESSION_TURN_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 新しい Turn の入力をキューへ渡し、実行完了ではなく受付結果を取得する。 */
    enqueueSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 失敗した Turn の再試行を、対象と再試行の識別情報を保持して要求する。 */
    retryFailedSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RETRY_FAILED_SESSION_TURN_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 元の要求 ID を用い、受付結果が不明な場合も同じ受領記録を照会する。 */
    getSessionTurnQueueReceipt(sessionId, requestId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_SESSION_TURN_QUEUE_RECEIPT_CHANNEL,
        sessionId,
        requestId,
      );
    },
    /** 現在の Session の待機入力を表示するための一覧を取得する。 */
    listSessionTurnQueue(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_TURN_QUEUE_CHANNEL,
        sessionId,
      );
    },
    /** 表示条件を渡し、指定 Session の受領記録の一覧を取得する。 */
    listSessionTurnQueueReceipts(sessionId, options) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_TURN_QUEUE_RECEIPTS_CHANNEL,
        sessionId,
        options,
      );
    },
    /** 指定した待機レコードを取り消す。実行中の Turn への停止操作とは区別する。 */
    cancelQueuedSessionTurn(sessionId, id) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_QUEUED_SESSION_TURN_CHANNEL,
        sessionId,
        id,
      );
    },
    /** まだ待機している入力を対象に、編集の開始を要求する。 */
    beginQueuedSessionTurnEdit(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_BEGIN_QUEUED_SESSION_TURN_EDIT_CHANNEL,
        sessionId,
        request,
      );
    },
    /** キューの編集中の入力について、確定する内容を保存処理へ渡す。 */
    updateQueuedSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_QUEUED_SESSION_TURN_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 待機入力の編集を取り消す。待機入力自体の取り消しではない。 */
    cancelQueuedSessionTurnEdit(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_QUEUED_SESSION_TURN_EDIT_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 対象 Session の待機入力の順序を、専用の並べ替え要求で変更する。 */
    reorderQueuedSessionTurns(sessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_REORDER_QUEUED_SESSION_TURNS_CHANNEL,
        sessionId,
        request,
      );
    },
    /** 待機入力を実行中 Turn に送る際、画面が想定した Turn の ID も照合に渡す。 */
    sendQueuedSessionInput(sessionId, id, expectedTurnId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SEND_QUEUED_SESSION_INPUT_CHANNEL,
        sessionId,
        id,
        expectedTurnId,
      );
    },
    /** 対象を指定し、現在の Session 実行への停止を要求する。 */
    cancelSessionRun(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
        request,
      );
    },
    /** 指定 Session の最新 Turn の保存済み記録を取得する。 */
    getLatestSessionTurn(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_LATEST_SESSION_TURN_CHANNEL,
        sessionId,
      );
    },
    /** まだ読まれていない最新結果が対象 Session にあるか照会する。 */
    getUnreadSessionResult(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_UNREAD_SESSION_RESULT_CHANNEL,
        sessionId,
      );
    },
    /** 対象の Turn の結果だけを既読にする。 */
    markSessionResultRead(sessionId, turnId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL,
        sessionId,
        turnId,
      );
    },
    /** 指定された Session の現在の詳細な実行状態を取得する。 */
    getLiveSessionRun(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
        sessionId,
      );
    },
    /** 実行中の承認要求に対し、元の要求 ID を指定して判断を返す。 */
    resolveLiveApproval(sessionId, requestId, decision) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
        sessionId,
        requestId,
        decision,
      );
    },
    /** 実行中の質問要求に対し、元の要求 ID を指定して応答を返す。 */
    resolveLiveElicitation(sessionId, requestId, response) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
        sessionId,
        requestId,
        response,
      );
    },
  };
}
