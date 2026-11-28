/** 指定した Session の会話ウィンドウを開く。Auxiliary を指定した場合は所属を照合して選択に反映する。 */
export const WITHMATE_OPEN_SESSION_CHANNEL = "withmate:open-session";
/** Session Monitor の行に対するネイティブメニューを Main に表示させる。 */
export const WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL =
  "withmate:show-session-monitor-context-menu";
/** Home の復元操作に表示する、まだ開き直していない Session ウィンドウの候補を取得する。 */
export const WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL =
  "withmate:get-session-window-restore-set";
/** Home から保存済みの復元候補を開き直す。現在開いているウィンドウの一覧取得とは別の操作。 */
export const WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL =
  "withmate:restore-session-windows";
/** 別ウィンドウからでも Home の Session 一覧へ戻れるようにする。 */
export const WITHMATE_OPEN_HOME_WINDOW_CHANNEL = "withmate:open-home-window";
/** Session の稼働や状態を俯瞰する Monitor ウィンドウを表示する。 */
export const WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL =
  "withmate:open-session-monitor-window";
/** アプリ全体の設定を編集する専用ウィンドウを表示する。 */
export const WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL =
  "withmate:open-settings-window";
/** 指定された Character の編集画面を開く。ID がなければ編集対象を固定しない。 */
export const WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL =
  "withmate:open-character-editor-window";
/** 渡された差分プレビューを独立したウィンドウで表示する。 */
export const WITHMATE_OPEN_DIFF_WINDOW_CHANNEL = "withmate:open-diff-window";
/** Home などの一覧で会話本文を読み込まずに表示できるよう、Session 概要をページ単位で取得する。 */
export const WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL =
  "withmate:list-session-summary-page";
/** Session Monitor が表示する行の一覧を、専用のページ要求から取得する。 */
export const WITHMATE_LIST_SESSION_MONITOR_PAGE_CHANNEL =
  "withmate:list-session-monitor-page";
/** Character 管理画面などが参照する、保存 Session における Character の使用状況を取得する。 */
export const WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL =
  "withmate:list-session-character-usage";
/** ID で保存済み Session を取得する。ID がない場合や対象が見つからない場合は null を返す。 */
export const WITHMATE_GET_SESSION_CHANNEL = "withmate:get-session";
/** Session ウィンドウのメインフレームから、識別情報で指定した対象の保存済み実行情報を照会する。 */
export const WITHMATE_READ_SESSION_EXECUTION_CHANNEL =
  "withmate:read-session-execution";
/** 所有ウィンドウから指定した会話の保存メッセージをページ単位で取得する。 */
export const WITHMATE_GET_CONVERSATION_PAGE_CHANNEL =
  "withmate:get-conversation-page";
/** 会話のソースまたはプレビュー表示を対象に検索し、一致箇所を取得する。 */
export const WITHMATE_SEARCH_CONVERSATION_CHANNEL =
  "withmate:search-conversation";
/** 会話内の移動先を一覧する。全件とブックマークのみの絞り込みを区別する。 */
export const WITHMATE_LIST_CONVERSATION_NAVIGATOR_CHANNEL =
  "withmate:list-conversation-navigator";
/** 同じウィンドウが発行した会話検索・ナビゲーター要求のうち、要求 ID と発行元 ID が一致するものを取り消す。 */
export const WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL =
  "withmate:cancel-conversation-query";
/** 一覧や参照先に必要な一件の Session 概要を取得する。会話ページは読み込まない。 */
export const WITHMATE_GET_SESSION_SUMMARY_CHANNEL =
  "withmate:get-session-summary";
/** 所有ウィンドウで用語集の変更購読を準備し、現在の表示用データを取得する。 */
export const WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL =
  "withmate:get-session-glossary-projection";
/** 所有ウィンドウから、その Session に対応する用語集を検索する。 */
export const WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL =
  "withmate:search-session-glossary";
/** 所有ウィンドウから、保存済みの Workspace パスが現在も利用できるか確認する。 */
export const WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL =
  "withmate:validate-session-workspace";
/** 追加ディレクトリの登録前に、候補パスを検証する。Windows ではドライブ不定のルート付きパスも拒否する。 */
export const WITHMATE_VALIDATE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL =
  "withmate:validate-session-additional-directory";
/** File Explorer で参照できる Session のファイルルートを取得する。 */
export const WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL =
  "withmate:list-session-file-roots";
/** File Explorer に表示する、Session に保存済みのファイルピンを取得する。 */
export const WITHMATE_LIST_SESSION_FILE_PINS_CHANNEL =
  "withmate:list-session-file-pins";
/** ルート内の対象を Session の File Explorer に固定し、後で参照できるようにする。 */
export const WITHMATE_PIN_SESSION_FILE_CHANNEL = "withmate:pin-session-file";
/** 参照キーで指定したピンを Session から外す。ファイル実体の削除は行わない。 */
export const WITHMATE_UNPIN_SESSION_FILE_CHANNEL =
  "withmate:unpin-session-file";
/** 対象ルート内のディレクトリを開くために、その直下の項目を取得する。 */
export const WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL =
  "withmate:list-session-directory";
/** プレビュー方式と分割読み取りに必要な、ファイル種別・サイズ・リビジョンなどを取得する。 */
export const WITHMATE_INSPECT_SESSION_FILE_CHANNEL =
  "withmate:inspect-session-file";
/** 会話やプレビューの参照元を基準に画像リンクを解決し、読み取り前のファイル情報を取得する。 */
export const WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL =
  "withmate:inspect-session-image";
/** 解決済み画像の指定バイト範囲を読む。検査時のリビジョンを渡して別版との混在を防ぐ。 */
export const WITHMATE_READ_SESSION_IMAGE_CHUNK_CHANNEL =
  "withmate:read-session-image-chunk";
/** Session のリンクとして参照する PDF を解決し、プレビューに必要なファイル情報を取得する。 */
export const WITHMATE_INSPECT_SESSION_PDF_CHANNEL =
  "withmate:inspect-session-pdf";
/** PDF ビューアに渡すバイト範囲を、指定したファイルリビジョンで読み取る。 */
export const WITHMATE_READ_SESSION_PDF_CHUNK_CHANNEL =
  "withmate:read-session-pdf-chunk";
/** ファイルプレビューを分割取得するため、対象と期待リビジョンを指定してバイト範囲を読む。 */
export const WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL =
  "withmate:read-session-file-chunk";
/** 許可されたファイルを OS に渡して開く。要求の指定によりファイルの場所を表示することもできる。 */
export const WITHMATE_OPEN_SESSION_FILE_CHANNEL = "withmate:open-session-file";
/** ファイル、リンク、コミット差分の対象を解決して、専用のプレビューウィンドウに表示する。 */
export const WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL =
  "withmate:open-session-file-preview-window";
/** プレビューの初期表示に必要なデータを取得する。トークンに結び付いたウィンドウ以外には返さない。 */
export const WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL =
  "withmate:get-session-file-preview-window-payload";
/** 既に開いているプレビューウィンドウに、新しい表示対象を Main から渡す。 */
export const WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT =
  "withmate:session-file-preview-navigation";
/** Session の画像プレビューから、画像としてクリップボードへコピーする。ファイル項目のコピーとは別扱い。 */
export const WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL =
  "withmate:copy-session-file-preview-image";
/** 画像上で使えるネイティブメニューを開き、画像またはパスのコピー操作を提供する。 */
export const WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL =
  "withmate:show-session-file-preview-image-context-menu";
/** ファイルマネージャーなどへ貼り付けられる形式で、許可されたファイル項目をクリップボードに載せる。 */
export const WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL =
  "withmate:copy-session-file-object";
/** 許可済みのファイル項目について、ネイティブメニューからファイルそのものをコピーできるようにする。 */
export const WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL =
  "withmate:show-session-file-object-copy-context-menu";
/** File Explorer の項目に応じたネイティブ操作を提示し、入力欄への挿入が選ばれた場合は対象パスを返す。 */
export const WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL =
  "withmate:show-session-file-tree-context-menu";
/** Markdown リンクのネイティブメニューを開く。ファイル文脈を伴う場合はリンクの参照権限も照合する。 */
export const WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL =
  "withmate:show-markdown-link-context-menu";
/** 対象ルートの Git 変更一覧を取得する。専用プレビューからは現在表示しているファイルに結果を絞る。 */
export const WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL =
  "withmate:list-file-root-changes";
/** 指定したルート群から、Git 変更の表示に使えるリポジトリを列挙する。 */
export const WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL =
  "withmate:list-file-root-changes-repositories";
/** ルート内のファイルについて、作業ツリーまたはステージ済みのどちらかを指定して差分を取得する。 */
export const WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL =
  "withmate:get-file-root-diff";
/** Session の File Explorer でコミット履歴の閲覧対象にできるリポジトリを列挙する。 */
export const WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL =
  "withmate:list-file-root-git-history-repositories";
/** 選んだリポジトリのコミット履歴をカーソル付きのページとして読み進める。 */
export const WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL =
  "withmate:list-file-root-git-history-commits";
/** 履歴で選択したコミットの情報と、そのコミットで変わったファイルを取得する。 */
export const WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL =
  "withmate:get-file-root-git-history-commit-detail";
/** 履歴の基準・対象を解決し、直接比較か分岐を考慮した比較かに応じた結果を取得する。 */
export const WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL =
  "withmate:get-file-root-git-history-comparison";
/** コミット単体または履歴比較の差分を読み、パスの指定があれば対象ファイルに絞る。 */
export const WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL =
  "withmate:get-file-root-git-history-diff";
/** Session ID とメッセージ位置を指定し、そのメッセージに付随する保存済み成果物を取得する。 */
export const WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL =
  "withmate:get-session-message-artifact";
/** Provider の実行モデルや設定の選択肢を表示するため、モデルカタログを取得する。 */
export const WITHMATE_GET_MODEL_CATALOG_CHANNEL = "withmate:get-model-catalog";
/** 差分ウィンドウの起動時に、渡されたトークンで表示用のペイロードを取得する。 */
export const WITHMATE_GET_DIFF_PREVIEW_CHANNEL = "withmate:get-diff-preview";
/** 親 Session に所属する Auxiliary の一覧を取得する。親 ID が空なら空の一覧を返す。 */
export const WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL =
  "withmate:list-auxiliary-sessions";
/** アプリで開いている Auxiliary の概要をまとめて取得する。指定した親の保存履歴の一覧とは異なる。 */
export const WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL =
  "withmate:list-open-auxiliary-session-summaries";
/** 親の所有ウィンドウから、その親の最新 Auxiliary を会話表示用の形式で取得する。 */
export const WITHMATE_GET_LATEST_AUXILIARY_SESSION_CHANNEL =
  "withmate:get-latest-auxiliary-session";
/** Auxiliary ID から所属を解決し、その親の所有ウィンドウに会話データを返す。 */
export const WITHMATE_GET_AUXILIARY_SESSION_CHANNEL =
  "withmate:get-auxiliary-session";
/** 作成コンテキストとクライアント要求 ID を添えて、親に属する Auxiliary の作成を開始する。 */
export const WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL =
  "withmate:create-auxiliary-session";
/** 親を所有する画面が作成要求に添える、現在の作成コンテキストを取得する。 */
export const WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL =
  "withmate:get-auxiliary-creation-context";
/** 親と要求で特定した Auxiliary の作成処理を取り消す要求。作成済み会話の削除とは異なる。 */
export const WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL =
  "withmate:cancel-auxiliary-creation";
/** 親の ID と作成要求の識別情報から、既に発行した作成要求の処理状況を照会する。 */
export const WITHMATE_GET_AUXILIARY_CREATION_CHANNEL =
  "withmate:get-auxiliary-creation";
/** 既存の所属が要求と一致する Auxiliary を更新し、会話表示用の結果を返す。 */
export const WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL =
  "withmate:update-auxiliary-session";
/** 保存された親 ID と作成日時を照合し、Auxiliary の後続実行に使う設定を更新する。 */
export const WITHMATE_SET_AUXILIARY_EXECUTION_OPTIONS_CHANNEL =
  "withmate:set-auxiliary-execution-options";
/** 同じ ID の古い Auxiliary を誤更新しないよう保存済みの識別情報を照合し、表示タイトルを変更する。 */
export const WITHMATE_SET_AUXILIARY_TITLE_CHANNEL =
  "withmate:set-auxiliary-title";
/** 所属と作成日時を照合した Auxiliary で、指定メッセージのブックマーク状態を保存する。 */
export const WITHMATE_SET_AUXILIARY_MESSAGE_BOOKMARK_CHANNEL =
  "withmate:set-auxiliary-message-bookmark";
/** 親の所有ウィンドウから Auxiliary の新しい Turn を実行し、会話表示用の結果を返す。 */
export const WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL =
  "withmate:run-auxiliary-session-turn";
/** 親の所有ウィンドウから、指定した Auxiliary の実行中 Turn に補足入力を渡す。 */
export const WITHMATE_STEER_AUXILIARY_SESSION_TURN_CHANNEL =
  "withmate:steer-auxiliary-session-turn";
/** Auxiliary の実行に中断を要求する。保存された作成日時が要求の世代と異なる場合は操作しない。 */
export const WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL =
  "withmate:cancel-auxiliary-session-run";
/** Auxiliary を切り替えたり開き直したりしたときに、未送信の保存済み入力を読み戻す。 */
export const WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL =
  "withmate:get-auxiliary-draft";
/** 親と Auxiliary の所属が一致する場合に下書きを保存する。対象がなければ保存せず not-found を返す。 */
export const WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL =
  "withmate:save-auxiliary-draft";
/** 会話本文を取得せず、Auxiliary の状態を親の所有ウィンドウへ返す。 */
export const WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL =
  "withmate:get-auxiliary-session-status";
/** Home から新しい Session の作成を要求する。既存ディレクトリを Workspace にする指定は事前に検証する。 */
export const WITHMATE_CREATE_SESSION_CHANNEL = "withmate:create-session";
/** 既存 Session の状態を渡して更新する。タイトルや実行設定だけの更新には専用の要求もある。 */
export const WITHMATE_UPDATE_SESSION_CHANNEL = "withmate:update-session";
/** 所有ウィンドウから ID と世代を指定し、Session が使う追加ディレクトリの構成を変更する。 */
export const WITHMATE_CHANGE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL =
  "withmate:change-session-additional-directory";
/** 会話内容を渡し直さず、所有ウィンドウから Session のモデルなどの実行設定を保存する。 */
export const WITHMATE_SET_SESSION_EXECUTION_OPTIONS_CHANNEL =
  "withmate:set-session-execution-options";
/** 所有ウィンドウから、会話データとは別に Session の表示タイトルを更新する。 */
export const WITHMATE_SET_SESSION_TITLE_CHANNEL = "withmate:set-session-title";
/** 所有ウィンドウのメインフレームから、ID と世代で指定した Session を全体統括に昇格させる。 */
export const WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL =
  "withmate:promote-session-role";
/** Main または所属 Auxiliary の非公開 Instructions 本文を、所有ウィンドウのメインフレームから読み出す。 */
export const WITHMATE_GET_SESSION_INSTRUCTIONS_CHANNEL =
  "withmate:get-session-instructions";
/** 所有ウィンドウから Main または Auxiliary の非公開 Instructions を置き換える。空本文は消去を表す。 */
export const WITHMATE_SET_SESSION_INSTRUCTIONS_CHANNEL =
  "withmate:set-session-instructions";
/** 所有ウィンドウから、会話ナビゲーターでも使うメッセージのブックマーク状態を変更する。 */
export const WITHMATE_SET_SESSION_MESSAGE_BOOKMARK_CHANNEL =
  "withmate:set-session-message-bookmark";
/** 一覧で Session を固定表示するため、保存済みのピン状態を切り替えて更新後の概要を返す。 */
export const WITHMATE_SET_SESSION_PINNED_CHANNEL =
  "withmate:set-session-pinned";
/** 許可されたウィンドウから対象 Session の削除を依頼する。単にウィンドウを閉じる操作とは異なる。 */
export const WITHMATE_DELETE_SESSION_CHANNEL = "withmate:delete-session";
/** 設定画面から最終活動日の期限で Crew を整理し、削除した対象と稼働中で見送った対象を区別して返す。 */
export const WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL =
  "withmate:delete-sessions-last-active-before";
/** Mate の作成済み・未作成・取得不能などを画面で判定できるよう、保存状態を取得する。 */
export const WITHMATE_GET_MATE_STATE_CHANNEL = "withmate:get-mate-state";
/** Mate の管理画面で使う表示情報・アバター・プロフィール各節の保存情報を取得する。 */
export const WITHMATE_GET_MATE_PROFILE_CHANNEL = "withmate:get-mate-profile";
/** 表示名と任意の表示設定をもとに、新しい Mate プロフィールを作成する。 */
export const WITHMATE_CREATE_MATE_CHANNEL = "withmate:create-mate";
/** プロフィールの表示名・説明・配色のうち、要求に含まれる項目だけを更新する。 */
export const WITHMATE_UPDATE_MATE_CHANNEL = "withmate:update-mate";
/** Mate のプロフィール画像をパスで指定する。画像指定のない入力も扱う。 */
export const WITHMATE_SET_MATE_AVATAR_CHANNEL = "withmate:set-mate-avatar";
/** Mate の保存プロフィールをリセットする。表示情報の部分更新や画像だけの設定とは異なる。 */
export const WITHMATE_RESET_MATE_CHANNEL = "withmate:reset-mate";
/** Character のカタログ項目を列挙し、必要な画面に限りアーカイブ済み項目も含める。 */
export const WITHMATE_LIST_CHARACTERS_CHANNEL = "withmate:list-characters";
/** 編集用に Character の定義本文・補助メモを含む詳細を ID から取得する。 */
export const WITHMATE_GET_CHARACTER_CHANNEL = "withmate:get-character";
/** 公開情報と任意の定義を入力として、新規 Character をカタログに登録する。 */
export const WITHMATE_CREATE_CHARACTER_CHANNEL = "withmate:create-character";
/** 既存 Character の名前・説明・アイコン・配色を部分更新する。実行用定義の本文は別の要求を使う。 */
export const WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL =
  "withmate:update-character-metadata";
/** 既存 Character の実行用定義を置き換える。補助メモも入力に含めて更新できる。 */
export const WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL =
  "withmate:update-character-definition";
/** Character をカタログから消去せず、通常の起動候補から外す。 */
export const WITHMATE_ARCHIVE_CHARACTER_CHANNEL = "withmate:archive-character";
/** Session 起動用に、明示された ID の有効な Character を取得する。未指定やアーカイブ済みなら null。 */
export const WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL =
  "withmate:resolve-launch-character";
/** 新規定義の制作または既存 Character の改稿を行う作業 Session を始め、編集先と実行 ID を返す。 */
export const WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL =
  "withmate:start-character-authoring-session";
/** 呼び出し元に作業ディレクトリの選択ダイアログを表示し、一つのパスを返す。キャンセル時は null。 */
export const WITHMATE_PICK_DIRECTORY_CHANNEL = "withmate:pick-directory";
/** Home の Session 作成前に、指定された作業ディレクトリが利用可能か調べる。 */
export const WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL =
  "withmate:validate-workspace-directory";
/** 汎用の単一ファイル選択ダイアログを表示する。初期パスを指定でき、選ばなければ null を返す。 */
export const WITHMATE_PICK_FILE_CHANNEL = "withmate:pick-file";
/** 複数のファイルを選択できるダイアログを表示する。選択を取り消した場合は空配列を返す。 */
export const WITHMATE_PICK_FILES_CHANNEL = "withmate:pick-files";
/** Session Folder を起点に複数ファイルを選択し、フォルダー内の選択結果だけを返す。 */
export const WITHMATE_PICK_SESSION_FILES_CHANNEL =
  "withmate:pick-session-files";
/** Session Folder 内からディレクトリを一つ選ぶ。配下にない選択結果は返さない。 */
export const WITHMATE_PICK_SESSION_FOLDER_CHANNEL =
  "withmate:pick-session-folder";
/** Session Folder を起点に画像選択を開き、フォルダー内で選んだ画像だけを返す。 */
export const WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL =
  "withmate:pick-session-image-file";
/** 画像を一つ選択する。Character アイコン用の場合は PNG と JPEG に候補を絞る。 */
export const WITHMATE_PICK_IMAGE_FILE_CHANNEL = "withmate:pick-image-file";
/** 指定した既存ファイルを管理下の Session Folder へコピーし、保存先パスを返す。 */
export const WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL =
  "withmate:copy-files-to-session-files";
/** 貼り付けられたバイト列を Session Folder に保存する。既存ファイルとの衝突時の置換・別名保存指定も受け取る。 */
export const WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL =
  "withmate:save-pasted-session-file";
/** 管理下の Session Folder を必要に応じて用意し、OS のファイル一覧で開く。 */
export const WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL =
  "withmate:open-session-files-directory";
/** 添付などを置く Session Folder をカレントディレクトリとして、外部端末を起動する。 */
export const WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL =
  "withmate:open-session-files-terminal";
/** ローカルパスや外部 URL を OS に渡す。ローカルパスでは既定アプリで開くか、ファイル一覧に表示するかを指定できる。 */
export const WITHMATE_OPEN_PATH_CHANNEL = "withmate:open-path";
/** 診断に使うアプリログの保存先を OS のファイル一覧で開く。 */
export const WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL =
  "withmate:open-app-log-folder";
/** クラッシュ調査に使うダンプの保存先を OS のファイル一覧で開く。 */
export const WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL =
  "withmate:open-crash-dump-folder";
/** 保存 Session の Workspace をカレントディレクトリとして、外部端末を起動する。Session Folder は使わない。 */
export const WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL =
  "withmate:open-session-terminal";
/** 所有 Session の Workspace に組み込み端末を起動する。端末 ID と初期行列数を受け取り、シェル情報を返す。 */
export const WITHMATE_CREATE_TERMINAL_CHANNEL = "withmate:create-terminal";
/** 組み込み端末の ID を指定して、入力文字列を応答待ちなしでシェルへ渡す。 */
export const WITHMATE_WRITE_TERMINAL_INPUT_CHANNEL =
  "withmate:write-terminal-input";
/** 組み込み端末の表示領域に合わせ、対象 PTY の列数と行数を更新する。 */
export const WITHMATE_RESIZE_TERMINAL_CHANNEL = "withmate:resize-terminal";
/** 組み込み端末の表示側が処理した出力文字数を返し、止めていた出力を Main が再開できるようにする。 */
export const WITHMATE_ACKNOWLEDGE_TERMINAL_OUTPUT_CHANNEL =
  "withmate:acknowledge-terminal-output";
/** 組み込み端末の終了を求める。起動・作業中の確認で取り消された場合は false を返す。 */
export const WITHMATE_CLOSE_TERMINAL_CHANNEL = "withmate:close-terminal";
/** 組み込み端末の資源を確認なしで解放する。端末のライフサイクル上の後片付けに使う。 */
export const WITHMATE_RELEASE_TERMINAL_CHANNEL = "withmate:release-terminal";
/** 組み込み端末の出力、終了、またはエラーを、端末 ID とともに所有ウィンドウへ配信する。 */
export const WITHMATE_TERMINAL_EVENT = "withmate:terminal-event";
/** Session ID を引かず、明示されたディレクトリを起点に外部端末を開く。 */
export const WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL =
  "withmate:open-terminal-at-path";
/** 画面側で記録されたログを、Main の診断ログへ渡す一方向の入口。 */
export const WITHMATE_RENDERER_LOG_CHANNEL = "withmate:renderer-log";
/** 入力欄のテキストにある添付参照を送信前に解決し、添付候補と解決エラーを返す。 */
export const WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL =
  "withmate:preview-composer-input";
/** 保存 Session の Provider と Workspace から、入力時に選べるスキルを探索する。 */
export const WITHMATE_LIST_SESSION_SKILLS_CHANNEL =
  "withmate:list-session-skills";
/** 保存 Session の実行環境から、参照できるカスタムエージェントを探索する。 */
export const WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL =
  "withmate:list-session-custom-agents";
/** まだ Session を作っていない場合にも、Provider と Workspace を直接指定してスキルを探せる。 */
export const WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL =
  "withmate:list-workspace-skills";
/** Session ID の代わりに Provider と Workspace を指定し、カスタムエージェントを検索する。 */
export const WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL =
  "withmate:list-workspace-custom-agents";
/** 所有ウィンドウの入力から新しい Turn を直接実行する。キューへの登録や実行中入力とは別の経路。 */
export const WITHMATE_RUN_SESSION_TURN_CHANNEL = "withmate:run-session-turn";
/** 新規 Turn を起こさず、所有ウィンドウから実行中の Turn に入力を追加する。 */
export const WITHMATE_STEER_SESSION_TURN_CHANNEL =
  "withmate:steer-session-turn";
/** Session の ID と世代を指定して入力を実行待ちキューに渡し、受付または事前検査での拒否を返す。 */
export const WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL =
  "withmate:enqueue-session-turn";
/** 失敗が確認できる開始 Turn の確定済み入力を使い、新しい実行をキューに登録する。 */
export const WITHMATE_RETRY_FAILED_SESSION_TURN_CHANNEL =
  "withmate:retry-failed-session-turn";
/** 受付結果を確認し直すために、キューの要求 ID を指定して保存済みレシートを取得する。 */
export const WITHMATE_GET_SESSION_TURN_QUEUE_RECEIPT_CHANNEL =
  "withmate:get-session-turn-queue-receipt";
/** 所有ウィンドウで現在の実行待ちを表示するため、Session のキュー項目を取得する。 */
export const WITHMATE_LIST_SESSION_TURN_QUEUE_CHANNEL =
  "withmate:list-session-turn-queue";
/** 現在の待ち列だけでなく、保存された受付履歴をカーソル・件数指定でページ読み込みする。 */
export const WITHMATE_LIST_SESSION_TURN_QUEUE_RECEIPTS_CHANNEL =
  "withmate:list-session-turn-queue-receipts";
/** キュー項目 ID を指定して、まだ実行待ちの要求を取り消す。稼働中の Turn の中断には使わない。 */
export const WITHMATE_CANCEL_QUEUED_SESSION_TURN_CHANNEL =
  "withmate:cancel-queued-session-turn";
/** 現在の待ち列が要求時の並びと一致する場合に、実行待ち項目を並べ替える。 */
export const WITHMATE_REORDER_QUEUED_SESSION_TURNS_CHANNEL =
  "withmate:reorder-queued-session-turns";
/** キュー項目を編集できる状態にし、送信元ウィンドウが失われた場合に編集状態を片付けられるようにする。 */
export const WITHMATE_BEGIN_QUEUED_SESSION_TURN_EDIT_CHANNEL =
  "withmate:begin-queued-session-turn-edit";
/** 編集した入力と添付を再検査し、実行待ち項目に反映する。 */
export const WITHMATE_UPDATE_QUEUED_SESSION_TURN_CHANNEL =
  "withmate:update-queued-session-turn";
/** 更新を確定せずに編集を終える。キュー項目そのものの取り消しとは区別する。 */
export const WITHMATE_CANCEL_QUEUED_SESSION_TURN_EDIT_CHANNEL =
  "withmate:cancel-queued-session-turn-edit";
/** 待ち列にある入力を、新しい Turn ではなく指定した実行中の Turn に届ける。 */
export const WITHMATE_SEND_QUEUED_SESSION_INPUT_CHANNEL =
  "withmate:send-queued-session-input";
/** 実行待ちキューの再取得を促すため、変更対象の Session ID を所有ウィンドウに通知する。 */
export const WITHMATE_SESSION_TURN_QUEUE_CHANGED_EVENT =
  "withmate:session-turn-queue-changed";
/** 送信済み配送情報の再取得を促すため、送信元 Session の ID をその所有ウィンドウへ通知する。 */
export const WITHMATE_SESSION_SENT_DELIVERIES_CHANGED_EVENT =
  "withmate:session-sent-deliveries-changed";
/** 実行中の Session Turn に中断を要求する。未実行のキュー項目には別の取り消し経路を使う。 */
export const WITHMATE_CANCEL_SESSION_RUN_CHANNEL =
  "withmate:cancel-session-run";
/** 会話を開いたときなどに、最新の保存済み Turn を所有ウィンドウから読み直す。 */
export const WITHMATE_GET_LATEST_SESSION_TURN_CHANNEL =
  "withmate:get-latest-session-turn";
/** Session の未読結果表示に使用する。閲覧を記録する操作とは別に、未読の結果を取得する。 */
export const WITHMATE_GET_UNREAD_SESSION_RESULT_CHANNEL =
  "withmate:get-unread-session-result";
/** フォーカス中の所有ウィンドウから結果の Turn ID を渡し、その結果を既読にする。 */
export const WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL =
  "withmate:mark-session-result-read";
/** 保存済み Turn を読み直せるよう、更新があった Session の ID を Main から通知する。 */
export const WITHMATE_SESSION_TURN_UPDATED_EVENT =
  "withmate:session-turn-updated";
/** 画面の初期表示に使う、保存済みアプリ設定のスナップショットを取得する。 */
export const WITHMATE_GET_APP_SETTINGS_CHANNEL = "withmate:get-app-settings";
/** 設定ウィンドウのバージョン表示に使う実行中アプリの版を取得する。 */
export const WITHMATE_GET_APP_VERSION_CHANNEL = "withmate:get-app-version";
/** アプリ全体の設定を Main に保存させ、更新後の値を取得する。 */
export const WITHMATE_UPDATE_APP_SETTINGS_CHANNEL =
  "withmate:update-app-settings";
/** チャットの表示設定だけを、検証された部分更新として保存する。 */
export const WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL =
  "withmate:update-chat-layout-preference";
/** 入力欄や管理画面から選べる、保存済みプロンプトテンプレートの一覧を取得する。 */
export const WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL =
  "withmate:list-prompt-templates";
/** 再利用できる新しいプロンプトテンプレートを保存する。 */
export const WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL =
  "withmate:create-prompt-template";
/** 既存の保存 ID で指定したテンプレートの編集内容を反映する。 */
export const WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL =
  "withmate:update-prompt-template";
/** 選択候補から外すため、指定 ID の保存済みテンプレートを削除する。 */
export const WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL =
  "withmate:delete-prompt-template";
/** 現在選ばれたデータベースと候補ファイルの互換性・スキーマの診断結果を取得する。 */
export const WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL =
  "withmate:get-app-database-diagnostics";
/** 起動画面が初期表示に使う、Main が保持している現在の初期化状態を取得する。 */
export const WITHMATE_GET_APP_BOOT_STATUS_CHANNEL =
  "withmate:get-app-boot-status";
/** 設定ウィンドウから指定区分の保存データを初期化し、再同期に必要な設定や一覧を取得する。 */
export const WITHMATE_RESET_APP_DATABASE_CHANNEL =
  "withmate:reset-app-database";
/** 指定 Session の現在のライブ実行状態を読み直す。保存済み Turn の履歴とは異なる。 */
export const WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL =
  "withmate:get-live-session-run";
/** Provider の利用枠の観測値を取得する。必要に応じてキャッシュ参照のみに限定できる。 */
export const WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL =
  "withmate:get-provider-quota-telemetry";
/** 指定 Session の会話コンテキストに関する現在の観測値を取得する。 */
export const WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL =
  "withmate:get-session-context-telemetry";
/** Session ID と承認要求 ID を指定し、実行中に提示された承認に回答する。 */
export const WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL =
  "withmate:resolve-live-approval";
/** 所有ウィンドウから、実行中の Provider が求めた追加入力に要求 ID を指定して回答する。 */
export const WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL =
  "withmate:resolve-live-elicitation";
/** 開いている会話ウィンドウの Session ID をページ単位で取得する。保存済みの全 Session を返すものではない。 */
export const WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL =
  "withmate:list-open-session-window-ids";
/** 保存済み Session 概要の再取得が必要な範囲を、個別 ID または全件の指定で知らせる。 */
export const WITHMATE_SESSIONS_INVALIDATED_EVENT =
  "withmate:sessions-invalidated";
/** 更新後のモデルカタログを配信して、各画面のモデル選択肢を同期する。 */
export const WITHMATE_MODEL_CATALOG_CHANGED_EVENT =
  "withmate:model-catalog-changed";
/** 保存が確定した設定を各ウィンドウへ配信し、画面間で設定を同期する。 */
export const WITHMATE_APP_SETTINGS_CHANGED_EVENT =
  "withmate:app-settings-changed";
/** 保存内容が変わったときに、最新のプロンプトテンプレート一覧を選択画面などへ配信する。 */
export const WITHMATE_PROMPT_TEMPLATES_CHANGED_EVENT =
  "withmate:prompt-templates-changed";
/** ライブ実行の詳細を所有ウィンドウへ届ける。詳細の状態がなくなった場合は null で知らせる。 */
export const WITHMATE_LIVE_SESSION_RUN_EVENT = "withmate:live-session-run";
/** 実行詳細を渡さず、一覧などで表示する Session ごとの稼働状態を通知する。 */
export const WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT =
  "withmate:live-session-run-status";
/** 会話ウィンドウで選択された Auxiliary を、所属する親 Session の ID とともに通知する。 */
export const WITHMATE_AUXILIARY_SESSION_SELECTION_EVENT =
  "withmate:auxiliary-session-selection";
/** 利用枠の表示を更新または解除できるよう、Provider ID と観測値または null を配信する。 */
export const WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT =
  "withmate:provider-quota-telemetry";
/** 会話コンテキストの表示を更新または解除できるよう、Session ID と観測値または null を配信する。 */
export const WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT =
  "withmate:session-context-telemetry";
/** 購読先の Session ウィンドウへ更新後の用語集の表示データを届ける。 */
export const WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT =
  "withmate:session-glossary-changed";
/** 現在のウィンドウ開閉状態を通知する。ID を通知できる上限を超えた場合は一覧の再取得を求める。 */
export const WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT =
  "withmate:open-session-windows-changed";
/** まだ復元されていない Session ウィンドウの候補一覧を主 Home に配信する。 */
export const WITHMATE_SESSION_WINDOW_RESTORE_SET_CHANGED_EVENT =
  "withmate:session-window-restore-set-changed";
/** 既に開いている会話ウィンドウに、表示対象の Auxiliary を切り替えるよう要求する。 */
export const WITHMATE_OPEN_AUXILIARY_SESSION_EVENT =
  "withmate:open-auxiliary-session";
/** 起動画面へ初期化の進捗や完了・失敗を配信し、表示を更新する。 */
export const WITHMATE_APP_BOOT_STATUS_EVENT = "withmate:app-boot-status";
/** ウィンドウの閉鎖や終了に先立ち、対象の会話ウィンドウに未送信の下書き保存を要求する。 */
export const WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT =
  "withmate:session-draft-flush-request";
/** 下書き保存要求に応じた renderer が、要求 ID と保存の成否を Main へ返す。 */
export const WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL =
  "withmate:session-draft-flush-ack";
/** 下書き保存待ちを終えたことを同じウィンドウに知らせ、保存時の入力制限を解除できるようにする。 */
export const WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT =
  "withmate:session-draft-flush-release";
/** Home の管理表示に使う、開いているファイルプレビューウィンドウの一覧を取得する。 */
export const WITHMATE_LIST_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL =
  "withmate:list-session-file-preview-windows";
/** Home のプレビュー一覧で、単体またはグループの閉じるメニューを提示して選択結果を返す。 */
export const WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL =
  "withmate:show-session-file-preview-context-menu";
/** Home から、トークンで識別した既存のプレビューウィンドウを前面に出す。 */
export const WITHMATE_FOCUS_SESSION_FILE_PREVIEW_WINDOW_CHANNEL =
  "withmate:focus-session-file-preview-window";
/** Home からトークンを指定して、対象のファイルプレビューウィンドウだけを閉じる。 */
export const WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOW_CHANNEL =
  "withmate:close-session-file-preview-window";
/** Home から所有 Session を指定して、その Session のファイルプレビューをまとめて閉じる。 */
export const WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL =
  "withmate:close-session-file-preview-windows";
/** プレビューの一覧が変わったことだけを主 Home に伝え、改めて一覧を読めるようにする。 */
export const WITHMATE_SESSION_FILE_PREVIEW_WINDOWS_CHANGED_EVENT =
  "withmate:session-file-preview-windows-changed";
/** 設定画面で削除内容を確認できるよう、Session Folder の候補を走査して確認用 ID を発行する。走査では削除しない。 */
export const WITHMATE_SCAN_SESSION_FOLDER_CLEANUP_CHANNEL =
  "withmate:scan-session-folder-cleanup";
/** 設定画面が確認した走査 ID を受け取り、候補を再検証して Session Folder のクリーンアップを実行する。 */
export const WITHMATE_RUN_SESSION_FOLDER_CLEANUP_CHANNEL =
  "withmate:run-session-folder-cleanup";
/** 主 Home に Crew 一覧の一ページを返す。Main の親子関係と開閉状態、および関連 Auxiliary の概要を含む。 */
export const WITHMATE_LIST_HOME_CREW_PAGE_CHANNEL =
  "withmate:list-home-crew-page";
/** 主 Home から対象 Session の ID と世代を渡し、Crew 一覧の指定座標にネイティブメニューを表示する。 */
export const WITHMATE_SHOW_HOME_CREW_CONTEXT_MENU_CHANNEL =
  "withmate:show-home-crew-context-menu";
