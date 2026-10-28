# Desktop UI

UIの設計・変更・reviewでは、画面横断の原則と共通パターンを定めた[UI Design Guidelines](ui-design-guidelines.md)を参照する。

## Auxiliary Session (Issue #710)
Mainと選択中Auxiliaryの末尾移動は`Scroll Main To Bottom`／`Scroll Auxiliary To Bottom`としてSettingsから個別にキー登録できる。既存の有効な割当を維持するため、全platformで初期は`Not Assigned`とし、`Reset`も指定commandだけ未割当へ戻す。登録後はComposer入力中も使え、送信対象とfocusを変えず指定列だけ末尾追従へ戻す。未取得・折りたたみ中の列、Auxiliaryの読込中・取得失敗、中央Preview表示中は実行しない。Terminal本文、IME変換中、key repeatでは会話shortcutの既存抑止を維持する。

Session WindowはMain左と選択中Auxiliary右を同じchat shellで表示できる。Auxiliaryは複数保持し、中央のタイトル枠内にある`＋`から既存会話を閉じず最終使用順の一覧へ反映する。Auxiliary中央の左右矢印と表示名一覧はstable Session IDで選択し、一覧行はCharacter iconと非AIの会話previewだけを表示する。実行中のAuxiliaryはicon内にcompactなprocessing indicatorを重ね、行高とpreviewの幅を変えない。splitter幅と選択中Auxiliaryは親Sessionごとのlocal preferenceとして復元し、幅はresize interactionの完了時だけ保存する。折りたたみ時はAuxiliary面・内部境界・タイトル枠内の操作を隠し、splitterだけを再展開導線として残す。折りたたみでActionDock対象や選択中Sessionを変更しない。

Auxiliary追加のprovider pickerはHome `New Session`、Character authoringと同じloading / error / ready 0件の状態境界を使い、開始処理中のbusyをalertへ変換しない。

保存済みmessageのBookmarkは送信先Main / Auxiliaryの選択や実行中かどうかに依存せず、表示中の両会話で操作できる。read-only Sessionと未確定のlive / pending messageは変更対象にしない。本文付近の既存button、accessible nameとpressed stateを維持する。保存・競合の境界は[Message Bookmark](../features/message-bookmark-filter.md)を参照する。


## Goal

Electronデスクトップアプリとして、各Windowの現行UIと操作の入口を把握できるようにする。Window間の責務は[Window Architecture](window-architecture.md)を参照する。

## Scope

- Home の session / Character catalog 管理 UI
- Character Editor Window
- Session Monitor Window
- Session の coding agent 作業 UI
- Diff Window の閲覧 UI
- Settings Window

## UI Source Of Truth Boundary

- 各Windowの画面構成・固有の操作条件と現行動作の正本はこの文書とする

## 読込と表示言語の適用

- Sessionは基本情報からheaderとFilesを表示し、会話は独立して読み込む。会話取得が成功するまで会話全体を必要とする編集・送信を行わない。Homeの一覧はapp stateの取得を待たず、Settingsの設定draftとDiagnostics、SessionのSDK model候補はそれぞれの取得状態を持つ。
- 現役6 HTML entryのshellは`lang="en"`とする。

## Windows Session Notifications

- `Session Turn Notification`は既存のturn完了・失敗通知とCodexの構造化質問通知を有効／無効にする。Windowsの通常Session、Character作成Session、Auxiliary Sessionが対象で、対象Session Windowがfocus中なら通知しない。Auxiliaryでは親Windowのfocusを使う。
- 質問は`item/tool/requestUserInput`のblocking／nonblocking両方と、`agentMessage`の`delivery = async`かつ`questions`を持つ通知を対象とし、質問フォームを表示する時点で通知する。同一itemの開始・完了で二重通知しない。通常の会話本文を質問と推測せず、MCP elicitation・承認待ち・他providerの質問はこの通知に含めない。Monitorの分類は通知設定とは独立して入力待ちを反映する。
- 質問通知はtitleを`WithMate`、bodyを`<Session名>: Codex has a question.`とし、Character icon、通知の識別・置換、クリック時の会話復帰は既存のturn通知を共有する。質問文・選択肢・入力値・会話本文はOS通知へ出さず、`Notification Response Preview`は成功したturnの完了通知だけに適用する。
- 回答、取消、server側解決、runtime resetで質問通知を撤去する。解決後に設定読込みが完了しても古い通知を表示せず、同じ会話の後続通知を古い質問の解決で撤去しない。通知の作成・配送・撤去失敗は診断として扱い、質問への回答やprovider実行を失敗させない。
- `Session Approval Notification`は承認待ち専用の設定で、既定は有効。Codex／Copilot／Claude／OpenCodeの共通承認要求を対象とし、Main／Auxiliaryとも親Session Windowが開いていて非focusの場合に通知する。閉じたWindowは対象外とし、Auxiliaryでは親Windowのfocusを使う。
- 承認要求をlive stateへ公開した時に`<Session名>: approval required.`を通知する。Session名以外の本文、command、path、details、warningは表示せず、通知から直接approve／denyしない。クリックで対象Main／Auxiliaryへ戻り、対象が失われていた場合はHomeへ戻る。
- 同一会話・同一requestの重複callbackは通知を増やさず、解決・abort・cancel・resetで通知を撤去する。設定取得中に解決した古い通知は表示しない。通知の識別・後続通知への置換・削除時の撤去は既存の会話単位の基盤を使い、古い要求の解決で後続通知を消さない。通知失敗は承認decisionやproviderの結果を変更しない。
- 同一会話の承認要求はFIFOで先頭1件だけを既存の承認cardへ表示し、表示した要求だけ通知する。判断後に次へ進み、Monitorは未解決要求がある間も会話単位で数える。要求の識別と取消の契約は[Session Run Lifecycle](session-run-lifecycle.md#sessionapprovalservice)を参照する。

## Approval Requests

- Main／Auxiliaryの承認要求は、受信時点のassistant本文位置を要求に紐付けて一時保持し、会話内のその位置付近へ表示する。厳密なイベント位置との一致は求めず、previewでは段落・コードブロック等を分断しない境界へ寄せ、後続の本文より前に保つ。
- 会話のページング有無で配置を分けず、過去pageの先頭へ要求を移さない。待機中の要求も受信時の位置を保持し、要求IDによるFIFOと許可・拒否の操作対象を維持する。
- 要求本文と`Allow Once / Reject`を主にし、汎用の承認見出し・状態badge・内部の要求種別を重ねて表示しない。要求本文は通常の文字組みで表示し、警告は本文の近くに残す。補足引数は本文右端の情報iconから本文下へ展開し、操作列は許可・拒否のみとする。詳細は薄い区切りと等幅textで示し、色付きsurfaceや入れ子の箱を使わない。詳細の開閉は要求ごとに保持し、新しい要求は閉じた状態から始める。判断送信中も要求内容・警告・詳細へのアクセス、操作対象のaccessible name、二重操作防止とaccessible statusを維持する。
- 解決・取消・turn終了後は承認操作面を閉じる。承認card専用の会話履歴は保存せず、既存の会話本文・実行記録は維持する。

## Question Forms

- Main／Auxiliaryとも、有効な構造化入力要求を会話内で操作する。Codexの非同期質問はsource item IDに対応する本文範囲をformへ置き換え、通常本文から質問を推測しない。本文を持たない要求は受信時点の応答本文の後ろへ挿入し、後続本文より前の位置を保持する。
- 通常の質問は質問文、選択肢、自由入力欄を直接表示し、受付状態の見出しや`Custom Answer`の可視labelは置かない。自由入力のaccessible nameは維持し、単一選択の自由回答radioは入力欄に隣接させる。選択肢がない場合は自由入力だけにする。Codexの非同期質問は最初の候補を選択するが、自動送信はしない。nativeの回答制約とMCPの厳密schema・secret fieldは維持する。
- 書式指定・secretではないtextと、単一／複数選択の`Custom Answer`は複数行入力にする。`Enter`は改行し、Settingsで設定したComposer送信shortcutはfocus中の質問だけを送信する。IME変換中とkey repeatでは送信しない。
- 自由回答の`Attach`は`Close / Submit`と同じ操作行の左端に置き、確定操作は右端へ寄せる。添付先は初期状態では先頭の自由回答欄とし、以降は最後にfocusした回答欄にする。自由回答欄が複数ある場合だけ、Attachの横とaccessible name・tooltipに対象欄名を示す。選択・保存中にfocusが移っても、結果は開始時の欄へ挿入する。
- `Attach`はActionDockと同じ`File / Folder / Image`、`Session Files`の`Copy / File / Folder / Image`を提供する。既存ファイルは参照し、clipboardから貼り付けた画像・ファイルは質問を所有するSession Filesへ保存して本文へ参照を挿入する。本文とパスを元の質問への回答として渡し、内容の読取・活用はエージェント側の権限と機能に委ねる。添付専用の回答型や通常チャットへの別送は設けず、非同期質問の既存の画像解決は維持する。
- 非同期質問の`Submit`は`【質問】`、質問原文、`【回答】`、回答をそれぞれ改行で区切って現在turnへ通常追加入力として送る。複数質問は質問・回答の組を空行で連結する。UI事情の説明は加えず、チャットのuser messageには回答だけを保存・表示する。入力を受け付けないturnでは送信できず、次turnへ自動振替しない。RPC質問の回答は元のrequestへの構造化応答とする。
- 同じturnの複数質問は個別formとし、他の質問の受信、通常チャット割り込み、履歴スクロールで未送信回答を消さない。過去pageへ移動した間は質問を別の位置へ移さず、元のpageへ戻った時にdraftを復元する。
- 送信中は重複操作を止め、受付失敗時は有効なformと入力値を保持してerrorを示す。通常チャットの本文からform回答を推測せず、通常割り込みだけでは回答済みにしない。
- 添付の選択・保存中は対象入力と`Submit`を無効化する。単一選択では同じfieldの通常・自由回答radioも無効化し、添付完了による回答選択の上書きを防ぐ。他fieldと`Close`は維持し、成功・失敗後に対象fieldの再選択を許可する。添付失敗時は入力を保持してerrorを表示し、要求の終了・切替後に完了した選択・保存結果を別のSession・質問・fieldへ挿入しない。
- 回答・拒否・Close・要求失効・turn終了後はformを閉じ、元の質問文と選択肢を通常の会話として残す。回答済み等の状態ラベルは表示しない。通常チャットで回答したかどうかは判定しない。
- 通常質問の操作は`Close / Submit`とし、×と通常送信と共通の紙飛行機iconを使う。操作名はtooltipとaccessible nameへ残し、busy中もbuttonの寸法を維持する。Closeは質問だけを終了する。Codex nativeでは空の`answers`を返し、Claudeでは質問toolを拒否してturn自体は中断しない。turn停止は既存のCancelから行う。MCP formは`Reject / Close / Submit`、URL要求は`Reject / Close / Complete`の可視labelを維持する。
- 終端時の記録は通常assistant messageへ保存し、次turnや会話再表示でも操作を復元しない。記録にはformの入力値・既定値を保存しない。非同期回答を受け付けた本文は通常user messageとして保存する。強制終了前のlive formや未送信回答の復元は行わない。

## UI Implementation Boundary

Session headerの`Graph`はMainと配下Auxiliaryが共有する[Session Graph](session-graph.md)を中央previewで開き、吹き出しiconの`Back To Chat`で元の会話へ戻る。入口はヘッダーの展開時に表示する。隣の外向きiconまたはCtrl/Cmd付きの操作では元の表示を維持して独立Graph Windowを追加でき、同じ話題の複数ビューも並べられる。話題・関係を図から読み、record選択時だけ詳細を表示する閲覧専用面である。画像・mmdと同じCtrl＋wheelの拡縮とCtrl＋左dragのpanを使い、共通のwheel刻み設定・倍率範囲に従う。詳細の×は選択解除、独立Windowのnative ×はそのWindowだけを閉じる。Main削除の確認は、Auxiliary会話とGraphも削除されることを示す。

Mainの`Rename`は保存前失敗時に入力を保持してalertで失敗を示す。保存済みで通知・投影だけが失敗した場合はtitleの表示を正本summaryから復旧し、保存済みであることと他Windowの再openによる更新をalertで伝える。復旧readも失敗した場合はcommit済みtitleを表示に保持し、再openでの再取得を案内する。保存応答・復旧readが遅れても、別会話・別incarnation・後続のtitle保存へ古いtitleやalertを反映しない。

- 画面の実装ファイルは、表示される入口ではなく役割ごとの domain に置く
- `Home` 配下に置くのは Home dashboard と Home から直接見える管理ハブだけとする
- `Settings Window` の画面実装は `settings` domain に置き、Home の実装ファイルへ混ぜない
- Character catalog は `character` / `character-editor` domain を正本にし、Home には一覧と editor window 起動だけを置く
- chat layout の実装は 1 系統だけとし、`chat` domain を正本にする
- Agent は chat layout に乗せ、機能側には state / service / adapter だけを置く
- `chat/conversation/session-message-column.tsx` は会話本文、artifact、検索、仮想スクロールと pending row の配置を担当する。pending row 内の承認・入力要求は `chat/runtime/live-request-surface.tsx` が所有し、フォーム状態、validation、応答 payload、送信中の操作制御を conversation 列へ戻さない
- artifact の展開状態と開閉操作は `chat/conversation/session-chat-conversation-feature.ts` が Window 内の message key ごとに所有する。会話の切り替えで展開状態を失わず、App は状態・setter・開閉 callback を構築しない
- File Explorer と中央 file / Git preview は `file-explorer/session-files-feature.tsx` が独立した描画境界で `use-session-files-feature.tsx` を呼ぶ。タブ、再読込、preview requestと読込結果をその境界内に保持し、shellの安定したpane／preview hostへ表示する。Windowにはpreview有無、閉じる操作、composerへの挿入接続だけを渡す
- `chat/runtime/session-context-feature.tsx` はContext tab、telemetry、Glossaryの検索・選択を所有する。会話へ必要なannotation matcherと用語を開く操作だけを共有し、検索入力や結果更新でWindowを再投影しない。Retryは最小turnを参照し、Latest Commandはliveと対象turnの通常artifactを使う
- live本文・step・usageの表示snapshotは会話列、Contextの表示ownerが購読する。Window shellの購読は実行有無、入力待ち、本文出力開始、command実行有無、errorという操作・通知に必要な変化だけを反映し、本文tokenごとに他機能を再構築しない
- 会話列は確定履歴の投影とlive末尾を分離し、保存確定時のmessage key、Bookmark、検索、navigatorを保持する。Previewや幅0で見えない会話列は表示用live購読と追従を休止し、再表示時に最新snapshotへ追いつく。runとdraft保存の寿命は表示状態から独立する
- selection toolbarの位置計測は対象列に選択がある時だけ行い、DOMのresize／mutation監視も選択中に限定する。選択・Copy／Quoteとkeyboard操作を維持する
- splitterのdrag中は対象領域の寸法を局所更新し、pointer up／cancelで最後の表示値を状態ownerへ確定する。中央幅の保存も確定時だけ行い、clickとkeyboard変更はその操作内で確定する
- Session Window は機能間の接続を担当し、Composer の入力・picker・表示 props、Context Pane の選択・表示投影、Shell の dock 操作・resize props は各機能 owner が組み立てる。`chat/session-chat-window-composition.tsx` は owner が返す表示面を共通 ChatWindow へ接続し、全機能の詳細状態を受け取る projection は持たない
- `Session` という名前の UI 実装に provider 固有処理を詰め込まない。必要な差分は capability / adapter として注入する
- Session context pane の `Messages` tab は session window が明示的に capability を有効化した場合だけ表示し、既存の `LatestCommand → Messages → Glossary → Reasoning → Tasks` 順を保つ
- right pane に表示する情報がない mode では、説明文や誘導文で埋めず、空の pane shell として扱う

## Runtime

- 対応 runtime は Electron のみ
- renderer は `window.withmate` を前提に動作する
- Vite dev server は Electron 開発時の配信面として使い、browser 単体での利用はサポートしない
- 各 renderer entry point は window-level error boundary を持ち、描画クラッシュ時も `Retry` / `Reload` で復帰を試せるようにする

## Home Window startup

- 通常起動ではHomeと同じ大きさのWindowを最初に開き、起動用entry内でHomeの描画へ切り替える。切替時にWindowやentryを再生成しない。`--background`ではWindowを出さない。
- 起動中はHomeの未準備な操作を表示せず、枠のない待機表示をWindowの中央に置く。stage一覧や完了説明は表示せず、詳細statusをaccessible statusへ集約する。spinnerと`Starting WithMate`を表示し、対象領域の`aria-busy`で処理中を示す。
- 起動失敗時はstatusのtitleを見出しとするalertへdetailとerror detailを残し、成功や通常完了へ読み替えない。

## Home Window

- 黒基調の管理ハブとして表示する
- `Settings` は別 window で開く前提のため、Home は session / Character catalog 管理ハブを優先する
- 左の`RecentSessions`と右の`Monitor`／`Characters`／`Previews`を、Session WindowのMain／Auxiliaryと共通のスプリッターで分割する。初期は左右1:1で、比率は表示中のHome内だけで保持する
  - ドラッグまたは左右矢印キーで幅を変え、端へ寄せると片側を全幅表示する。クリックは右側を閉じ、どちらかが閉じているときはクリックで1:1へ戻す。閉じた状態からのドラッグ・矢印キーでは再展開しない
  - 閉じたpaneは非表示・操作不可にし、検索入力や一覧のDOMを保持する。左右の最小幅はそれぞれ300px／320pxとし、両側を表示できる幅があるときはWindow縮小後も比率を補正して最小幅を維持する。縮小だけで閉じたpaneを開かない
  - Monitor／Characters／Previews切替とSettings／Restore Sessions／独立Monitorの操作はHome共通headerに置く。切替は右寄せし、共通操作ボタン群の直前に置く。headerは左右分割の外に常設し、paneの幅調整・開閉で操作ボタンを移動・非表示にしない。開閉対象名は現在表示中のpaneへ合わせる
  - header左側には共通検索と＋iconの`New Session`を置く。検索は1つの語でRecentSessions、Home内Monitor、Charactersを絞り込み、対象切替は設けない。検索語はMonitor／Characters切替とpane開閉で保持し、`Clear Search`で全一覧の絞り込みを解除して検索inputへfocusを戻す。独立Monitor Windowへは共有しない
  - 入力文字は即座に表示し、最後の入力から300ms後に共通の検索語を3一覧へ適用する。IME変換中は適用せず、確定値から待機する。空入力・`Clear Search`は待機中の検索を取り消して即座に解除する。Recent／Pinnedの取得中は前回の結果を保持し、scopeごとの取得成功時に置換する
  - Session検索は`taskTitle / workspacePath / workspaceLabel / kind label / Mainの保存済みCharacter表示名`のいずれかへの部分一致とする。Charactersはcatalogの名前のみを対象とする。前後の空白とASCIIの大文字小文字を無視し、AuxiliaryのCharacter名、会話本文、Character説明文は検索しない。通常SessionのCharacter名はcatalogの改名へ追従しない
  - 検索inputのplaceholderは表示せず、accessible nameは`Search Sessions And Characters`とする。`New Session`は表示中のpaneにかかわらず同じdialogを開き、初期データの準備状態によるdisabled条件は維持する。狭幅ではheaderの操作群を折り返し、検索・作成・共通操作へ到達可能にする
- 2 カラムの外側とMonitorのAttention／Running／Stopped sectionを装飾cardで囲まず、余白と区切り線で構成する
- `RecentSessions` / `Characters` 見出しは dark background 上で十分読める色を明示する
- `Monitor & Resume` / `Manage Cast` の補助ラベルは置かない
- Mate ProfileのAvatar編集では、`Select Image`と`Clear`の実行した操作だけをbusy表示にし、処理中は両操作を無効化する。Mate保存中も両操作を無効化するが、Avatar更新中とは表示を区別する。Mate未作成・Profile利用不可ではAvatar編集を提供しない。画像選択のキャンセルと更新失敗では元のAvatarを保持して操作可能状態へ戻し、成功時は取得したProfileを反映する。Avatarがないときは`Clear`を表示しない。
- `Monitor`
  - Home共通headerのsegmented toggleで `Characters`／`Previews` と排他的に切り替える
  - 初期表示は `Monitor`
  - 共通`HomeMonitorContent`の先頭に有効providerの詳細icon・名前・期間別残率をcompactな横並びで表示し、幅に応じて折り返す。直下のclick専用splitterで残量一覧だけを開閉し、閉じてもcomponentとcache購読を維持する。監視一覧のscrollとは独立し、独立Monitorにも同じ構成を適用する。詳細は既存のprovider別popupで開き、表示中のloading・取得失敗・前回値を区別する。[Provider Usage Telemetry](provider-usage-telemetry.md#共通の残量表示)に従う
  - 親Sessionは1行にまとめ、左側で`Main`状態をavatarと親titleへ近接させる。右端はSession Windowと共通のAuxiliary icon・状態別件数・展開矢印を一つのbuttonへまとめ、配下の一覧との関係を示す。列見出しは置かず、Auxiliaryがない親には右端のbuttonを表示しない。Auxの複数状態は必要に応じて折り返し、承認・error・実行有無を落とさない。状態と操作のaccessible name・tooltipは維持する
  - source は `src-electron/windows/session-window-bridge.ts` が所有する監視対象Session IDと、共通検索語に一致するSession summaryの交差集合を使う。対象は開いているWindowと、Main／Auxiliaryの実行後に保持したSessionであり、Recent／Pinnedの取得範囲に依存しない。親を最大100件ずつ取得し、全pageの親・Auxiliary summaryを投影する
  - Running／Attention／取消終了待ちでWindowを閉じても監視を継続し、閉鎖後に完了してもStoppedへ移すだけで除外しない。同じSessionを再openし、Mainと全AuxiliaryがStoppedに属する状態で通常closeした時に監視を終了する。確認・draft flush中の完了をStopped closeへ読み替えず、その間の新規実行も保持する。監視の保持はMainの生存期間内だけで、アプリ再起動へ永続化しない。未実行Windowは通常の開閉に追従する
  - section
    - `Attention`: Main／Auxiliaryのいずれかに有効な承認待ち、質問・MCP form／URLの入力待ちがある親Session。Codexのblocking／nonblocking／async質問を含む。会話単位では取消状態を承認・入力待ちより優先するが、別の会話が承認・入力待ちなら親はこの枠へ入る
    - `Running`: Attentionに該当せず、`running` またはMain／Auxiliaryのlive取消待ち（`requested`／`terminating`）
    - `Stopped`: 他の2枠に該当しない`interrupted` / `error` / `neutral`を含むnon-running
  - 3枠は常に`Attention`、`Running`、`Stopped`の順に表示し、親Sessionを重複表示しない。最後の承認・入力待ちが回答・拒否・Close・要求失効・turn終了で解消すると現在の実行状態で再分類する。承認・入力待ちは表示用のlive状態であり、内部の`runState`を変更しない
  - 3分類は初期1:1:1の縦分割とし、各分類の一覧を独立してscrollする。隣接分類間の共通splitterをdragまたは上下キーで調整し、Home／Endは境界の限界へ動かす。開いている分類は48pxの最小領域へ補正する。開閉・Window resizeによる一時的な高さ配分で、保持する分類比率を変更しない
  - Monitor本文幅が740px以上なら各分類の親行を2列、それ未満は1列にする。Window全体ではなくHomeの分割後の幅で判定する。2列は前半を左、後半を右へ上から順に積み、Auxiliary展開で反対列の親行を押し下げない。分類ごとのscrollは共用し、狭幅では左列から右列の順に1列へ戻す。幅の切替や他Sessionの追加・除去・再分類で一覧を再mountせず、同じ分類に残るSessionのAuxiliary展開・focus・scrollを保持する
  - 分類splitterのclickは隣接2分類の親Session件数が少ない側の一覧を閉じる。同数ではStopped、Running、Attentionの順で閉じる。Auxiliary数は比較へ足さない。片側が閉じている場合はその側を開き、両側が閉じている場合は優先度の高い側（Attention、Running、Stoppedの順）を開く。件数変化だけで自動開閉しない。矢印とaccessible nameは操作対象を示す
  - 閉じた分類は見出しと件数を残し、一覧のDOM・展開・scrollを保持したまま非表示・操作不可にする。領域が狭く親行を表示できない場合も一覧だけを非表示にし、広げると戻す。隠れる一覧内にfocusがある場合は隣接splitterへ移す。開閉は表示領域だけでありSessionを終了・停止しない
  - 常設の workspace / provider / command / transcript は表示せず、親titleとAuxiliary previewは既存の省略表示規則を使う
  - 親titleのクリックで親Windowを開き、disclosureでAuxiliary一覧を展開する。展開行のクリックはstable Auxiliary IDを指定して同じ親Window内の対象を選択する
  - 親行の右クリック、またはfocus中のShift+F10／Context Menu keyで共通のnative menuを開く。`Copy Session ID`は親Session ID、`Copy Session Title`は選択時に取得した現在のタイトル全文をコピーする。表示の省略はコピー内容へ適用せず、取得・コピー失敗はMonitor内へ表示する。Homeと独立Monitorで同じ操作を使い、`Close`は対象Windowが開いている場合だけ有効とする
  - Main／Auxiliaryの新しい終了結果は、未読の間だけMain title、Aux状態集約、対象Auxiliary previewを青で示す。実行状態とは分け、件数ラベル・未読dot・未読による並べ替えは追加しない。成功・失敗・取消の結果を対象とし、OS通知の設定や配送とは独立する
  - 対象Session Windowがfocus中で、その会話の保存済み最新結果が表示領域内に見えていると自動で既読にする。本文なしの結果は失敗理由、または取得済みDetailsの展開表示で判定し、Detailsの読込中・取得失敗だけでは既読にしない。Windowの単なる表示・最前面固定、過去履歴・別会話の閲覧、Auxiliary一覧の展開だけでは既読にしない。Main／Auxiliaryを独立に扱い、古い結果の既読要求で新しい結果を既読にしない
  - 既読・未読はMain Processのメモリだけで共有し、アプリ再起動やDB切替・初期化でリセットする。過去の結果から未読を復元せず、新たに保存された終了結果から追跡する
  - running / interrupted / error は形状を含む状態アイコンで判別でき、待機と終了は中空円形で揃えつつ状態ラベルと集約単位を分ける
  - 承認・入力待ちは静止した黄色系の丸囲み`!`アイコンで示し、常設の状態文字は追加しない。Main／Auxiliaryの個別行・Aux状態集約で同じ表現を使い、tooltipとaccessible nameは`Attention`とする。Auxの件数は会話数であり要求数ではない。要求の詳細と回答・判断操作はSession画面で扱う
  - 取消要求中は`Canceling`、実終了待ちは`Waiting For Stop`をMain／Auxiliaryごとのtooltipとaccessible statusへ反映し、Auxiliaryの件数も状態別に集約する。保存済みidleより取消待ちを優先し、最後の実終了で解除する
  - 取消・承認・入力待ち状態はMainが既存の軽量summary応答へ現在のlive状態から付与し、永続化しない。summaryと本文を含まないlive状態通知は共通の投影を使い、`approvalPending`に承認・入力待ちを集約する。Home／Monitorは初回・再表示時にsummaryを取得し、取消・承認・入力待ち状態の変化を再取得契機とする。通知payloadを直接投影せず、無効化前の遅い取得結果は適用しない
  - 監視対象の親・Auxiliary summaryの取得状態はMonitor領域のstatus feedbackで示し、失敗時は`Retry`で再取得できる。取得済みのcardは再取得中・失敗時も保持し、未知のAuxiliary集約や正常な0件へ置き換えない
  - 監視対象がないときは、正常なempty本文を出さず、Monitorのshellと必要なstatus/accessibilityだけを保つ
  - `MonitorWindow` button から独立した monitor window を開ける
- `RecentSessions`
  - 作成は共通headerの`New Session`から行う。保存済みWindowの復元操作は`Restore Sessions`とする
  - resume picker
  - 検索は共通headerの入力を使い、上下に余白を持たせたsession listだけをスクロールする
  - Recent、Pinned、open Session summary、Random用のCharacter利用履歴は取得結果と失敗を分離する。Recent／Pinnedの取得・追加page取得の失敗は既存rowの有無によらず一覧のfeedbackと`Retry`へ表示し、New Sessionの開始エラーには混入させない。追加pageの失敗は自動再試行を続けず、`Retry`で続きの取得を再試行する
  - 同じSession IDがopen summaryとPinned／Recentのpageにある場合は、page順序を維持してopen summaryの内容を一覧へ反映する。Monitorは独立した監視対象queryを使い、履歴やRandom用取得の失敗をMonitorの失敗として扱わない
  - session list は全 session を正本として表示し、storage 既定の `last_active_at DESC` を崩さない。検索0件でも本文を埋める説明文は出さない
  - `sessionKind === "character-authoring"` の Character authoring session は通常 session と同じ削除・再開導線へ到達できるよう表示する
  - session card の常時表示情報
    - `avatar / taskTitle / workspacePath / updatedAt`
    - `taskSummary` は 1 行補助情報として、空なら省略可
    - 通常種別の`Agent`と実行状態badgeは表示しない。履歴の検索・再開を役割とし、実行状態はMonitorで確認する
    - Character authoringの`Character`と旧schema等の`Read Only`は、種別・利用制限の識別として表示する
  - card theme
    - background = mate `main`
    - left accent bar = mate `sub`
    - text color = themeのcontrast helperで決めたdark / light palette
- `Previews`
  - Home共通headerのsegmented toggleで`Monitor`／`Characters`と排他的に切り替える。既存MonitorのAuxiliary欄は変更しない
  - 開いているSession Windowをpreviewの有無にかかわらずすべて一覧化し、Main／Auxiliary由来のFile Preview Windowを親Sessionへ集約する。Session Windowを閉じても残っているpreviewを含め、Recent Sessionsの検索・取得範囲や実行状態では絞り込まない
  - 親行は現在開いているFile Preview Window数の降順に並べる。同数ではMainから受け取る基準順（開いているSessionのWindow map順、その後ろにSession Windowが閉じた残存previewの親）を維持し、previewの開閉で件数と順序を更新する
  - Monitorと共通の親行にCharacter avatarとSession titleを置き、titleのclickでそのSession Windowを開く。右側のPreview icon・件数・展開buttonからfile一覧を開閉する。Attention／Running／Stoppedの分類は設けない
  - 開いているSessionはClose All後も親行を残し、0件の位置へ並べ直す。previewが0件なら件数のみ表示して展開とClose Allを無効にする。Session Windowが閉じていてpreviewも0件になった親は一覧から除く
  - 子一覧はMonitorのAuxiliaryと同じ高さ上限と枠内scroll、1行省略表示の密度を使い、件数が増えてもcardを無制限に伸ばさない。開いているpreviewの総数や取得件数は制限しない
  - fileの子行はfile名だけを常設表示し、識別pathはtooltipとaccessible nameに残す。Graphの子行は`Graph`と現在の話題・選択記録を示し、file pathは表示しない。clickは既存previewを前面化し、表示内容を再navigateしない
  - 個別Closeは子行、Close Allは親行のnative context menuから実行する。常設のClose buttonは置かず、右クリックに加えてContext Menuキー／Shift+F10でも操作できる。親単位CloseはそのSession配下のpreviewだけを閉じ、Session本体や他Sessionへ影響させない
  - 通常file、live Git Diff、commit file、Git履歴diff、独立Graphを対象とし、chat artifactのsnapshot Diffは含めない。Window数は制限せず、Close後も同じresourceを再度開ける。Graphは閲覧ビュー単位で、明示した新窓操作のたびに追加する
  - 開閉・再利用による一覧の変化を反映し、読込中・取得失敗・正常な0件を区別する。取得失敗には再試行を提供し、操作失敗を正常なCloseとして表示しない
- `Characters`
  - Home共通headerのsegmented toggleで `Monitor`／`Previews` と排他的に切り替える
  - Character catalog の active Character は意味のある card item として表示する。必要な識別情報と操作をまとめるが、入れ子の装飾cardは作らない
  - 共通headerの検索語で絞り込み、Characters内上部の＋icon `Create Character`は固定してCharacter listだけをスクロールする
  - card には avatar / name / description（空なら Character ID）を表示する
  - card click で `Character Editor Window` を開く
  - Character 0 件または検索0件時は本文を空にし、`Create Character`と共通検索を利用可能に保つ
  - Home には archive / delete を置かない
  - card theme
    - background = Character `main`
    - left accent bar = Character `sub`
    - text color = WCAG AA の contrast ratio を満たす dark / light 候補から自動決定
- `New Session` dialog
  - session title 入力
  - Agent Mode の workspace は既存 directory を選ぶ `Browse` と、WithMate 管理下の directory を開始時に作る `Session Folder` から選ぶ
  - Workspaceのパス入力は`Add Directory By Path`と共通の入力部品・検証controllerを使う。入力停止から300ms後に検証し、検証待ち・確認中は入力内spinnerとaccessible status、無効理由はlabelの隣へ表示する。手入力のpathは検証成功まで開始条件を満たさず、古い応答や取消後の応答を現在の選択へ反映しない
  - enabled provider の選択
  - Home の `New Session`、Character authoring、Auxiliary の provider picker は同じ状態境界を使う。取得中は picker 内の spinner と busy / accessible statusだけを表示して開始buttonをdisabledにし、取得失敗はprovider errorだけをalertで示して開始不可にする。取得成功後の0件だけ作成不可の説明を表示し、loading / error / ready 0 件を混同しない。開始処理中は各確定button内のspinnerとbusyだけを示し、busyをalertへ変換しない
  - Home `New Session`、Character authoring、Auxiliary の launch-section は意味上のgroupとして維持するが、装飾用のnested cardを描画しない
  - Character selector は開くたびにランダムを初期選択する。明示選択したactive Characterはそのまま使い、Characterが0件の場合はneutral fallbackを使う。詳細はADR 004を参照する
  - Random開始には取得済みの利用履歴とopen Session情報が必要で、再取得中・失敗時は開始を拒否する。使用中Characterはopen summaryから判定し、表示用Recent／Pinnedの失敗だけではRandomを止めない。取得回復時は取得由来のfeedbackだけを解消し、Session作成など別の操作失敗は保持する
  - Homeの管理用Character一覧は初回とWindow再フォーカス時に再取得する。New Sessionは開くたびに取得した一覧と取得状態を閉じるまで保持し、表示・選択・起動候補に同じ一覧を使う。Homeの再取得や外部のCharacter変更は開いているdialogへ反映せず、閉じて再度開いた時に最新化する
  - New Sessionを開く時のCharacter取得に失敗した場合は保持済みの一覧を起動候補として使わず、Character selectorに取得失敗を示してSession作成を無効にする。取得成功後の0件だけneutral fallbackを使う
  - New SessionはCharacter取得を待たずに開き、取得中はCharacter selectorの既存loading表示と開始不可状態を使う。表示中の重複openは取得・入力初期化を行わず、取得完了で入力・選択・focusを作り直さない。Cancelは取得中も操作でき、終了した試行の遅延成功・失敗はdialogの一覧・feedbackへ反映しない。開き直しは新しい試行として最新一覧を取得する
  - Random選択の`Start`はCharacter利用履歴とopen Session Window一覧の両方が取得成功した場合だけ有効にする。どちらかがloading / errorの間は開始不可とし、固定Character選択にはこの2取得を要求しない。選択と取得状態の変化に開始可否が追従し、実行時も同じ取得条件を再検証する。取得成功後の0件と未取得・取得失敗を区別する
  - model / depth / approval / sandbox / Reviewer / Speed / custom agent は dialog には出さず、Main Process が作成直前に provider ごとの現在選択を優先して解決する。現在選択がなければ保存済みの直近 Session 一件を参照する。詳細は [Electron Session Store](electron-session-store.md#実行設定と-send) を参照する
  - open 時は dialog 内の最初の主要入力へ focus する。Home の `New Session` は入力途中の意図しないdismissを避けるため、footerの`Cancel`で閉じ、backdrop clickや`Escape`では閉じない
  - 開始中も`Cancel`で閉じられるが、送信済みのSession作成は取り消さない。開始要求はそのdialog表示に所属し、閉じた要求の成功・失敗・busy解除で再表示後の入力・選択・feedback・開始中状態・focusを変更しない。同じ表示内の開始要求は同時に一つだけ受け付ける
  - Model取得を含むSession作成要求の失敗では入力・選択を保持し、footerにerror詳細のiconと成否不明時のRecent Sessions確認の注意を表示する。診断全文は非modal popoverで開き、`Retry`は同じ入力で作成要求を明示再試行する。validationや開始前の取得待ちを作成失敗へ変換せず、自動再送しない。詳細はEscape・閉じる操作で入口へfocusを戻し、外側の操作ではfocusを奪わない
  - 閉じた要求がSessionを作成した場合はRecent Sessionsへ反映し、Windowは自動で開かない。作成結果・確認不能の失敗はtitle付きの独立した結果通知としてHome Window内のRecent Sessionsに保持し、利用者が`Dismiss`するまで表示する。通知自体はWindowをまたいで永続化しない。別のNew Session表示中は通知を保留し、閉じた後に表示する。`Dismiss`は通知だけを消し、Sessionを削除しない。結果不明の自動再送やrollbackは行わない
  - `Tab` / `Shift+Tab` で dialog 外へ focus を逃がさない
  - provider の single-select chip は矢印キーで選択を移動できる
- `Settings` button
  - 独立した `Settings Window` を開く
- `Settings Window`
  - dedicated window の全面を本文と保存footerで使い、外側の余白やdialog shellを置かない
  - header copy や `Home / Close` は置かず、内容本体と保存 footer に分ける
  - 本文はWindow幅を使うinner scrollで流し、scrollbarを右端へ置いて保存footerの操作領域と分ける
  - `Session Window`
    - `Close Action Dock After Send`
  - `Prompt Context` の4項目を個別に切り替える。説明だけのhelper文やHelp iconは常設しない
  - `Coding Agent Providers` で provider 名と checkbox を 1 行 row で見せ、provider ごとの enable / disable を切り替える。sectionやproviderを装飾cardで入れ子にしない
  - `Diagnostics`
  - `Repository Glossary` の自動追加上限
  - `Storage Maintenance` の古いSession削除
  - 縦が小さいときも overlay 内スクロールで末尾まで操作できる

## Character Editor Window

- Home の `Characters` panel から create / edit mode で開く
- 1 Character に集中して編集する独立 window とする
- 既存Characterの未取得中・取得失敗・not foundでは新規作成draftを表示せず、編集・保存・Archive・Authoringを無効にする。読込中は対象領域のbusy/status、失敗は対象を示すalertと詳細icon、同じCharacterを取得する`Retry`を表示する。not foundは短い理由を表示し、診断の原文は非modal popoverで開く。popoverは本文・回復操作を押し下げず、長文のscroll/選択、Escape・閉じるbutton・入口再操作・外側clickによる閉鎖と適切なfocus復帰を維持する
- header
  - avatar / name / description
  - create / edit / archived の mode
  - 未保存時は`Unsaved`、archive済みは`Archived`だけをheader badgeで表示する。保存・authoring中はheaderへ状態chipを追加せず、各`Save` / `Author With Agent` / `Improve With Agent` buttonの`aria-busy`と局所spinnerで示す。正常な保存済み状態を常設の`Saved`で宣言しない
- tabs
  - `Profile`
  - `character.md`
  - `character-notes.md`
  - `Preview`
- `Profile`
  - name
  - description
  - icon path + Browse
  - theme main / sub
- `character.md`
  - runtime definition の正本である説明
  - save 前 validation issue。正常時の validation 宣言は常設しない
  - raw markdown editor。file名はaccessible labelとして保持するが、visible headingとruntime説明を重複表示しない
  - import / replace
- `character-notes.md`
  - authoring notes / evidence / revision notes 用である説明
  - `character-notes.md`はruntime promptに常設注入せず、editor内で同じ説明を常設表示しない
  - raw markdown editor。file名はaccessible labelとして保持するが、visible headingとnotes説明を重複表示しない
- `Preview`
  - Home card preview
  - launch selector row preview
  - runtime snapshot boundary の説明
- footer
  - destructive な `Archive` は左へ離して置き、confirm を挟む
  - `Reload` / `Cancel` / `Save`
- close
  - dirty draft では discard confirm を出す
- 保存開始時の draft と保存中の追加編集を区別し、完了時に新しい編集を保存結果で上書きしない。追加編集がある場合は保存成功表示で clean に見せない
- Authoring後のfocus再取得は、保存済み内容から変更されたローカルdraftを保持する。失敗後も入力を保持し、次のfocusまたはfooterの`Retry`で同じCharacterを再取得する。失敗の診断原文は初回取得と同じ非modal popoverで開き、再取得busyは`Retry`内へ限定する。再取得中の連続focusやRetryは重複要求にしない。後続の保存・Archive・Authoring開始後に古い再取得応答を反映しない。後続操作で中断しても、再取得または保存後の再取得が成功するまで再取得要求を保持し、操作失敗後は次のfocusで回復できる
- Character 定義自動生成、LLM 添削、section editor、revision / rollback、Character Update Workspace は current UI に含めない

## Session Monitor Window

- `Home` とは別の独立 window として開く
- 既定サイズは細く縦長の compact window とする
- 幅上限を設けず手動で拡大できる。Session件数の変化でWindowを自動resizeしない
- `always on top` を初期 slice から有効にする
- renderer は `HomeApp` の compact monitor mode を再利用する
  - 表示内容は Home 右ペインの `Monitor` と同じ truth source を使う
  - Homeと同じ監視対象と保持条件を使い、閉鎖後も監視中のSessionを表示する
  - `Attention` / `Running` / `Stopped` の3枠を、0件でも常に表示する
  - 親SessionはHomeと共通のcompactな行で表示し、Main状態を親名の側、Aux状態集約と展開操作を右端へ分ける。3分類はHomeと共通の高さ調整・件数/優先順位によるclick開閉・個別scrollを使い、本文幅740px以上では各分類を2列にする。文字の縮小だけで件数を詰め込まない
  - workspace、provider、command、transcriptなどの常設情報は表示しない。titleとAuxiliary previewは既存の省略表示規則を使う
  - `running`はaccent色のspinner、承認・入力待ちは静止した黄色系の丸囲み`!`、待機と終了はsubduedな中空円、errorはwarning triangleで表す。状態はアイコンのみとし、cardの点滅や状態別の面色変更は行わない。reduced motionではspinnerを停止する
  - Auxiliaryが存在する親だけ、右端に状態集約を含むdisclosureを表示する。展開時は親card内へ、実行中を先頭グループとし各グループを`updatedAt DESC, id DESC`で並べたAuxiliary rowを追加し、各rowのicon、preview、省略状態を表示する。Auxiliary rowの表示領域は約5行分に制限するが、6件目以降も一覧領域内をスクロールして全件へ到達できる
  - Auxiliaryの状態集約では`Attention`、`Running`、取消状態、`Error`、`Idle`、`Closed`を別々に数え、closed Auxiliaryをidleへ変換しない。idleとclosedは同じ円形だが、状態ラベルと集約を分ける。interruptedとerrorも別の形状で表示する
  - section countは親card group数とし、Auxiliaryをtop-level rowとして重複表示しない。Main／Auxiliaryの有効な承認・入力待ちを優先して親card groupを`Attention`へ分類し、それ以外は実行・取消待ちがあれば`Running`、残りは`Stopped`へ分類する。個々のMain／Auxiliaryの状態は分離して保持する
  - 親titleは既存の親Windowを開き、Auxiliary rowは同じ親Windowを指定したstable Auxiliary IDで開いて選択する。対象が消えた、親が一致しない、Windowを開けない場合はfallbackせずMonitor内へ失敗を返す
  - 展開状態は親kindとstable IDごとのWindow local stateとし、複数親を同時に展開できる。再描画、状態更新、section移動で失わず、Homeと独立Monitor Windowの間で永続化・同期しない
- window 内の `Home` button から通常の `Home Window` を前面へ戻せる
- close は通常の window close と同じ扱いで、session 実行自体は止めない

## Session Window

- Home と同じ dark base を使う
- キャラカラーは限定的に使い、過度に Session 全体へ広げない
- チャット UI の実装正本は `chat` domain の単一 UI 定義だけとする
- Agent は同じ chat screen / header / message list / composer / pane shell を使い、service adapter で差分を切り替える
- 新しい会話機能を追加する場合も、chat layout 実装を増やさず、Session UI の mode を追加する
- session title の rename / delete
- approval表示はprovider別候補のdisplay labelを使い、native値との対応は[Provider Adapter](provider-adapter.md#approval-modes)を正本にする
- `Work Chat`
- 空 session では初期 assistant メッセージを置かない
- assistant / user message の markdown-like rich text 表示
- Main／Auxiliaryの会話は最新60件を初回表示する。追加読み込みはHomeのSessionListと逆方向で、上端付近へスクロールすると古い本文を60件単位で取得し、現在のmessage keyとviewport内offsetを維持する。閲覧範囲は最大180件と最新tailに限り、離れた本文は解放する。下端付近では必要な新しい側の本文を再取得し、実際の最新末尾へ戻った時だけ追従を再開する。FindとMessages navigatorは全履歴を対象とし、検索結果・message・Bookmarkへの移動時に必要な本文を取得する。読込中・取得失敗と`Retry`は対象会話内のoverlayで表示し、本文領域を移動・縮小せず取得済み本文とComposerを保持する。失敗後は自動再試行せず、`Retry`で同じ方向の追加取得を再試行する。後続の移動や会話切替・非表示後に古い追加取得を適用しない。Auxiliary再選択では閲覧anchorを含む範囲を再取得し、別messageへの位置ずれを防ぐ
- 全履歴FindとMessages navigatorは64件の結果pageを使い、現在と隣接の最大3pageだけを保持する。Findは保存済み全履歴の総件数とglobal ordinalを維持し、未保存末尾とpending本文だけを重複なく加える。PreviewのFindは表示文字列と元Markdown本文を対象にし、messageごとに表示一致を表示順、その後に原文だけの一致を原文順で辿る。同じ原文出現の表示・原文一致は一度だけ数え、リンクラベルとリンク先など別の出現は区別する。原文だけの選択結果は該当messageのそばに`Source Match`として前後の原文を抜粋し、一致箇所を強調する。通常のMarkdown表示・リンク操作・保存本文は変更しない。SourceのFindは元本文だけを対象にする。生成CSS・SVGや埋め込みdocument内部、リンク先fileの内容は検索対象に加えない。未取得位置への移動では必要な結果と本文pageを取得する。query変更、Close、会話owner変更、非表示では旧queryを取消し、遅い旧応答を適用しない。読込中はspinner／busy、失効・errorは理由と`Retry`を表示し、成功0件とは区別する
- 全履歴Messagesの縮小状態は、会話owner単位の既定意図と個別messageの例外で保持する。全縮小・全展開は未読込の履歴pageにも適用し、個別の操作はpage復帰時も維持する。別incarnationの会話へ持ち越さない
- wide desktop (`1920x1080` baseline) では Session 本体を、中央の `message list または preview` と上下左右の dock に分ける
  - HeaderとActionDockは常に全幅を使い、外側をカードの枠・背景で囲まない。中央surfaceと左右paneの下に単一のActionDock splitterと共有下部パネルを配置し、パネル内をPrompt／Terminalで切り替える
  - Headerと共有下部パネルはclickで開閉する。左右paneは排他表示とし、clickで開閉する。閉じた領域からのdrag展開は行わない。共有下部パネルは開いた状態でdragと上下矢印キーによる高さ調整ができ、最大高はHeaderとsplitterを除いた残余高。中央領域が160px未満になる場合は高さ0で非表示にし、戻すと会話stateとスクロール位置を保って再表示する
  - 共有下部パネルの高さ・Prompt／Terminal選択、Terminalタブ、左右paneの幅はWindow local stateとし、別Windowや再起動へ引き継がない。入力modeの切り替えで共通高さを維持し、Window縮小時には利用可能な高さへ補正する
  - Header、ActionDock、side pane の表示 preference は app 共通設定へ保存し、新しく開く Window の初期値にだけ使う。既存 Window は別 Window の変更へ追従しない
  - title 編集などの強制表示は保存済み preference を変更しない
  - wide layoutでは中央surfaceの最小高さを160pxとし、それ未満では中央を高さ0で非表示にする。narrow layoutではactive side paneとwork surfaceを縦stackにし、dockの必要高を確保できない場合はside paneも状態を保って一時的に畳む
  - work surface: `message list または file / live Git Diff preview`
  - context pane: `Latest Command`
  - 左右splitterはclickで開閉し、開いた領域をdragと矢印キーでサイズ調整する。幅0でもclick用の操作領域を残す
  - 横配置の左右pane開閉では中央本文を最終幅へ一度だけ再配置し、paneのslideと中央内容の短いfadeで接続する。幅を補間して改行を繰り返したり文字を横伸縮させたりしない。ActionDockや縦配置paneの高さ変更では本文幅を保ち、末尾追従中はviewportの変化を描画前に補正する。読み返し中は既存のmessage anchorとoffsetを保つ。dragはpointerへ直接追従し、fadeや遅延を加えない
  - 中央が高さ0の間もHeaderとActionDockのsplitterを操作可能に保つ。中央内のsplitterは操作不可とする
  - 共有下部パネルの展開時最小高さは296pxとする。Promptでは実行設定を常時表示し、textarea自体は最低100pxを保ち、feedbackの高さは別に確保する。候補一覧は既存の高さ上限内で表示し、縮めて消さない。高さが不足する場合は内部スクロールで設定と送信操作へ到達できるようにする
  - 最小サイズは各領域のCSS custom propertyで所有し、レイアウト側が読み取る。File Explorerの最小幅は260px、Context paneは360px、縦stack時は各200px、中央の最小高さは160pxとする。Main／Auxiliaryは各360pxで、両側表示中に中央の実幅が両者とsplitterの合計未満なら送信対象側だけを表示する。中央splitterは1本とし、端へ寄せて片側の要求幅が最小幅の半分未満になるとその側を閉じ、反対側を全幅表示する。閉じた側はclickで両側表示へ戻す。表示比率と送信対象は独立して保持する
  - pane を隠した時も splitter は再表示 affordance として残す
  - side pane の表示状態は `files | context | none` の値として app 共通設定へ保存し、初期値は `none` とする。新しく開く Window は利用可能な永続値を初期値として使う
  - 開いている Window の表示状態は renderer local state とし、別 Window での切り替えには追従させない
  - viewport が `1400px` 未満では表示中の左右paneとwork surfaceを縦stackにし、左右splitterは縦方向のdragと上下矢印キーで高さを調整する。`1400px` 以上では横方向のdragと左右矢印キーで幅を調整する。サイズはWindow内で保持し、領域の最小サイズと利用可能領域に合わせて補正する
  - Session Windowの最小サイズは1100x720 DIPとし、current minimumはsplit-screenを考慮して到達性を維持する
  - Full HD では文字サイズそのものより density を先に調整し、Session 専用の gap / padding / chip / button 高さをやや詰める
  - user bubble は assistant avatar 分の左 gutter を持たず、row 幅いっぱいを使えるようにする
- `Terminal`
  - Windowsの内蔵PTYは、アプリが継承したPATHの記載順で`pwsh.exe`、次に`%ProgramFiles%/PowerShell/7/pwsh.exe`を探索し、どちらも見つからない場合だけ`%SystemRoot%/System32/WindowsPowerShell/v1.0/powershell.exe`を使う。PATHと標準候補の環境変数には、ドライブ付きまたはUNCの完全修飾pathを要求する。PATHの空要素・相対path、現在ドライブに依存する`\tools`や`/tools`は探索せず、引用符で囲まれた完全修飾PATHは扱う。ファイル／親directoryの不在だけを未検出として次候補へ進み、アクセス拒否などの探索異常、両方の未検出、選択後の起動失敗は失敗として通知する。検出済み7の起動失敗では5系へ切り替えない。自動installや選択Settingsは持たず、macOSは`/bin/zsh`を使う
  - 初期選択はPromptで、最初にTerminalを表示するまでシェルを起動しない。Workspaceの`Terminal`は共有下部パネルをTerminalへ切り替えて開き、`Open External Terminal`は既存の外部起動を行う。Session Folderの外部Terminal起動は変更しない
  - xterm.js本体・標準CSS・FitAddonの公開APIを使う。WindowsではMainが取得したOS build情報を`windowsPty`へ渡し、resize時のscrollbackを標準のWindows向け処理へ任せる。ANSI解釈、描画、選択、IME、scrollback、シェルの履歴・補完は標準機能へ任せる。専用の最大化モードや端末独自の入力欄は持たない
  - FitAddonの提案寸法をnative座標の上限32,767列・行までxtermへ適用し、同じ寸法をPTYへ渡す。Mainは正の整数と上限を検証する。IPC操作の拒否は端末内のエラー表示に留め、生存PTYの入力・resizeを維持する。PTY自体の障害は`Failed`として入力を停止する
  - 1タブにつき独立したxtermとPTYを持ち、親SessionのWorkspaceから起動する。Main／Auxiliaryの切り替えは端末の選択・cwd・processへ影響しない
  - dock内の1段タブバーはタブ部分だけ横scrollし、右端の`New Terminal`は固定する。選択タブ、終了ボタン、新規追加へkeyboardで到達でき、端末本文から`Ctrl+Shift+Tab`でタブへfocusを戻せる
  - `Close Terminal`の失敗は対象番号と再試行・詳細入口をコンパクトに表示する。再試行は現在の選択タブでなく失敗した端末を対象とし、同じ非同期終了確認を通す。診断原文は非modal popoverで開き、再試行を覆わず本文を押し下げない。詳細内のEscape／閉じる操作は入口へfocusを戻し、外側の操作によるfocus移動は保持する。Prompt切替・折りたたみでは詳細を閉じる
  - 表示の折りたたみ・Promptへの切り替え・タブ切り替えではprocessを維持する。`Close Terminal`は入力待ちと確認できた端末と終了済み端末を確認なしで閉じ、実行中・起動中・判別不能の場合は終了を確認する。確認は非同期で、Mainのイベント処理・AI更新・他端末の進行を待たせない。同じ端末の重複要求は一つの確認を共有し、取消では維持し、承認では対象の端末だけを閉じる。確認中の自然終了・owner破棄・起動完了は元の端末identityで扱う。最後のタブを閉じると共有パネルをPromptへ切り替えて展開し、その後の折りたたみ・再展開では端末を自動追加しない。Terminalを明示的に選び直すと新しい端末を作成する。自然終了は`Exited`と終了結果、失敗は`Failed`と理由を表示し、出力を残す
  - 入力待ち検出はPowerShell 7／Windows PowerShell 5系の`PSConsoleHostReadLine`を保持して包み、入力待ちへ入る時の未完了Job、同じconsoleのprocess、接続前も含む直下の子processを調べる。通常のトップレベルでこれらの作業がなく、read-line中の`PowerShell.OnIdle`で編集bufferが空かつconsoleに入力が残っていないと確認できた場合だけidleとする。read-line開始時点では貼付けの後続キーが残るためunknownとし、複数行・分割貼付けの未確定行や、処理を中断しているnested promptは確認する。PSReadLineの待機通知前に閉じる場合も確認する。単独のfocus-in/out通知はPTYへ転送しつつ状態を維持し、終了ボタンへのfocus移動だけでは確認を増やさない。実入力やfocus通知と混在した入力を送る時点でidleを失効させ、read-lineから戻った通知を挟まずに届いたidle通知は受理しない。コマンド名・プロンプト文字列・出力の静止時間では推測しない。通知は端末ごとに区別して出力から除き、分割された通知や終了時の未完出力も扱う。zsh、検出を使えないPowerShell、調査失敗、入力編集中は判別不能として確認する。Job・processの検出は入力待ちへ入る時点の状態であり、独立したprocessや入力待ち中に別経路で新たに始まる処理まで保証しない
  - Session Window全体を閉じる時も同じ端末判定を使い、入力待ち・終了済み端末だけなら端末理由の確認を省略する。実行中・起動中・判別不能な端末があれば非同期で一括確認し、AI実行中ならWindowを閉じてもAI実行を継続する確認へまとめる。同じWindowの確認は重複させず、取消では維持する。通常closeでは承認後に下書き保存を試み、その成功・失敗・timeoutの確定後にWindowを閉じてownerの端末を解放する。未保存入力は破棄可能であり、入力救済専用の保持・破棄確認は追加しない。保存済みdraft・送信済み会話・MainのAI実行と応答保存を維持し、app quitの保存契約とは区別する。詳細は[Session Run Lifecycle](session-run-lifecycle.md#session-window-close)を参照する。破棄済みWindowへの遅い承認を再作成したWindowへ適用しない
  - 入力はAI実行と独立し、端末scopeではPrompt／Terminal切替だけをアプリshortcutとして扱い、会話のshortcutを発火させない。`Ctrl+C`は端末の文字選択があればその文字をコピーしてシェルへ送らず、選択がなければシェルへ渡す。`Escape`はシェルへ渡し、`Ctrl+Shift+C/V`はコピー／貼り付け、macOSの標準コピー／貼り付けはOS/xtermに従う。Windowsの`Ctrl+V`もアプリのClipboard貼り付けとして扱い、WSLを含むshell／実行プログラムへ制御文字として送らない。貼り付けはxtermの公開`paste` APIを通し、shellが指定するbracketed paste modeを維持する。macOS／Linuxの`Ctrl+V`は制御入力として維持する
  - PowerShell／WSLを含む端末出力のHTTP(S)リンクはWebLinksAddonで検出し、`Ctrl＋左クリック`で既定ブラウザーへ開く。OSC 8で表示されたWebリンクも同じ操作と既存の`openPath` APIを使う。通常クリック・中／右クリックでは開かず、文字選択とコピーを維持する。HTTP(S)以外は開かず、開けない場合は端末内にエラーを表示し、PTYの入力・出力を維持する
  - ローカルシェルはアプリのOS権限で動き、Providerのapproval／sandboxとは独立する。Workspaceは開始cwdであってアクセス制限ではない
- `Top Bar`
  - default は hidden とする
  - 上 splitter を押すと Header の表示と `Rename / Terminal / Delete` を切り替える
  - Header は1行分の固定高とし、splitter の drag による高さ変更は行わない
  - `Workspace` / `Session` のgroup名は文字で残し、各`Explorer`をfolder icon、Workspaceの内蔵`Terminal`を端末icon、WorkspaceとSession Folderの外部Terminalを端末＋外向き矢印iconで表示する。各操作には対象込みの英語tooltipとaccessible nameを付け、disabledとfocus表示を維持する
  - title、`Collapse / Expand`、編集時の`Save / Cancel`は文字で表示する。低頻度の`Pin / Unpin / Rename / Delete`は`Session actions`の`⋯`menuに文字でまとめ、`More`の文字buttonと`Close`は置かない
  - title 編集中は effective state として表示を維持する
- `Action Dock`
  - compact / expanded の 2 状態を持つ
  - 常に全幅の下dockとして置く
  - 操作群の間隔は12px、対象・mode・directory追加groupの内側は4pxを確保する。Promptのscroll領域内側にも6pxの余白を置き、compact／Terminalを含めてfocus outlineを外枠で切り落とさない
  - Agent Sessionは最上段操作欄に送信対象providerの期間別残率を表示する。Promptでは添付操作群とCancel予約領域の間、Terminal／compactでは操作欄の先頭へ置き、専用段は増やさない。詳細iconは残量表示の左端に固定し、provider名とRemaining labelは常時表示しない。残量部分は1行を保ち、狭ければ横scrollする。操作欄全体が収まらない場合は既存操作の折り返しを許容する。Main／Auxiliary切替時は送信対象へ追従し、最小限の詳細と取得状態は[Provider Usage Telemetry](provider-usage-telemetry.md#共通の残量表示)に従う
  - Agent Sessionでは`Preview / Source`の右に同じ表示形式の`Prompt / Terminal`切替を置き、押したmodeを展開する。初期選択はPrompt。既定shortcutはWindows／Linuxの`Ctrl+Shift+T`、macOSの`Cmd+Shift+T`で、Settingsから変更できる。composerと端末本文のどちらにfocusがあっても切り替えられ、IME変換中とkey repeatでは発火しない
  - PromptとTerminalは同時表示せず、非表示側をinertにしてmountを維持する。Promptのdraft・selectionとTerminalのタブ・出力・PTYを保持し、Promptへ戻るとcomposerへ、Terminalを選ぶと選択端末へfocusする。splitterで再展開した時は選択modeを維持する。Quote／参照挿入などcomposerを開く操作はPromptへ戻す
  - compact では末尾移動とmessage表示切替を必要に応じて操作列に残す。draft入力と`Send`はPromptのexpandedで表示し、実行中indicatorはmessage listに置く
  - `Preview / Source`は同じ本文の表現変更として、選択buttonを即時反映し、本文だけを70msのfade-out、表現の交換、110msのfade-inでつなぐ。行・avatar・質問入力・実行状態は維持し、検索と文字選択は実際の本文表現へ合わせる。読み返しのmessage anchorとoffset、末尾追従を維持し、連続操作は最新選択を優先する。会話切替・非表示・reduced motionでは旧演出を取消し、最新選択へ直接切り替える
  - compact / expanded の上段操作列には `Main / Auxiliary` の直前に `Cancel` 用の40px固定幅領域を常時予約し、非実行中は不可視にする。Sendは下段右端の40×40pxの円形buttonと約20pxの紙飛行機iconで表示し、busy中は同寸法のspinnerへ切り替える。設定群が狭幅で折り返してもSendを独立した右列に保ち、開閉やMain / Auxiliary切替で主操作の位置を変えない
  - 開閉は下 splitter を主導線とし、compact では実行状態によらずdock全体の余白からも展開できる。非表示の `Cancel` 予約領域と操作間の隙間も対象とし、表示中の操作ボタンは自身の操作を優先してdockを展開しない。dock 内に `Hide` は置かない
  - Promptのexpandedでは上部操作列と下部設定・送信列の高さを固定し、dragで中央のtextarea領域を伸縮させる。Main／Auxiliaryの実行中も次の依頼を準備するため、Template・Skill・添付・Additional Directory・対応する実行設定を使える。実行中Turnの設定・認可済みdirectoryは捕捉値を維持し、編集値は次の送信から適用する。read-only、入力のblocked条件、quit／close凍結は維持する。Terminalでは切替操作列とタブバーを固定し、端末本文へ残りの高さを割り当てる
  - 通常送信はworkspace確認・preview・受付ACKを待たず、対象Columnへ送信文と通常の応答待機枠をDOM反映してから、設定に従ってcompactへ戻し、`Scroll To Latest On Send`を一度適用する。既に実行中なら次Turnの予約本文を現在の応答より後へ置く。内部の準備・受付・実行は表示から独立して進め、固定delayやdockのtransition完了待ちは追加しない。受付再照会・元要求の再試行によってdock開閉や末尾追従を繰り返さず、後続の手動操作を上書きしない
  - 送信時のhandoffは入力から会話へ読む位置を渡す一つの遷移とする。送信前のscroll位置から末尾までの差を、dockの外寸変化と共通の300msのease-outで解消し、途中の本文高・viewport高の変化を吸収する。新しい送信文と応答待機枠だけを180msでfade-inし、既存行や本文到着・保存時には入場演出を繰り返さない。dock内の共通操作列は上端からの位置を揃え、内容は独立した上下移動を加えず120msで切り替える
  - auto close OFFでも送信時のhandoffを使う。`Scroll To Latest On Send`がOFFで読み返し中なら位置を動かさない。遷移中のwheel・scrollbar・touch・scroll keyは手動操作を優先し、会話owner変更・非表示では旧Columnの補正を破棄する。`prefers-reduced-motion`では移動とfadeを省き、同じ状態・操作可否へ直接切り替える
  - この auto close は Settings の checkbox で ON / OFF を切り替えられ、初期値は ON とする
  - Promptではskill picker、`@path` 候補、blocked feedback がある時は expanded を維持する。Terminalへ切り替えるとpickerを閉じ、非表示Promptの候補やfeedbackは共有パネルの折りたたみを妨げない。skill pickerの候補panelは中央work surfaceのほぼ全体へ一時表示し、composerはtriggerとprompt挿入先を担う。recovery action surface は dock の状態へ影響しない
- Agent の `File Explorer`
  - Directoryの表示・追加・一覧は親Mainと配下の全Auxiliaryで共有し、パス追加dialog、追加済み一覧に`Shared · Main + Auxiliary`を表示する。送信先や選択Auxiliaryを変えても同じ一覧を使い、追加・削除は共通一覧へ反映する。削除可否は親MainのProviderに従う。認可境界は[Auxiliary Session](auxiliary-session.md#context-boundary)に従う
  - ヘッダーは既定の文字サイズで最小幅260pxから`Files / Changes / History`とPinフィルター・更新操作を1行に収める。文字サイズとラベルを維持し、横余白を抑え、操作領域は高さ28px以上とする。文字拡大等で収まらない場合は折り返しを許容し、操作を切り落とさない
  - `Workspace`、`Session Folder`、`Add Directory` で許可した directory を root として表示する
  - dotfile や ignore 対象を除外せず、展開した directory の直下だけを Main process から取得する
  - 未作成の既存 `Session Folder` は root の初回展開時に空ディレクトリとして作成する
  - tree row は仮想化し、file 本文は選択時に 1 件だけ chunk read する
  - 表示中のtabは初回表示・tab／pane／Windowの復帰、関連するMain／Auxiliaryのturn終端（成功・失敗・取消）で再取得する。非表示tab・折りたたんだpane・非表示Windowでは新しい取得を開始せず、復帰時に一度最新化する。短時間の通知を集約し、取得中の追加要求は最後の1回へまとめる。定期polling・再帰watcherは持たず、見続けている間の外部編集やTerminal実行途中の即時反映は保証しない。必要な時は`Refresh`で更新できる
  - Filesの更新はroot一覧、展開中directoryの直下、Pin状態に限定する。同一owner／rootでは取得済み内容・展開・選択・focus・scroll位置を保持し、削除されたpathは一覧から除く。Changesは許可済みGit rootを再確認してstatusを取得し、並列数を2に制限する。更新失敗は取得済み内容を保持してerrorと再試行を示し、空の正常状態へ置き換えない。owner／root変更前の遅延応答は適用しない
  - Historyの同一repository更新では選択中branch、commit詳細、Compareと中央Diffを保持する。詳細／Compare閲覧中のcommit一覧更新は一覧へ戻るまで延期し、一覧の更新では新しい先頭pageと古いoffset cursorを混在させない。file preview本文と開いているDiffはFile Explorerの自動・手動更新では再取得せず、各previewの再読込操作で更新する
  - Filesのregular file／directoryは行末の`Pin`／`Unpin`で目印を付与・解除する。Pin状態は塗りつぶしiconとpressed stateで示し、hoverや色だけに依存しない。TabとEnter／Spaceで操作でき、通常treeはroot順序と階層を保ったまま、同じ親直下でPinを第一条件、同条件で既存のdirectory優先・名前順とする
  - `Pinned Only`はroot名と相対pathを併記するPinだけの一覧へ切り替える。未展開の祖先配下も表示し、Pin directoryの未Pin子孫は含めない。fileは既存previewへ開き、directoryは通常treeへ戻して対象まで展開・移動する。解除後は次のPin、末尾なら直前のPinへfocusを移し、最後の解除後はfilterへ戻す。Pinが0件なら本文はblankとし、filterのON/OFFと通常表示へ戻る操作は残す
  - Pinは親Session内のMain／Auxiliaryで共有し、同Workspaceの別Sessionとは共有しない。再起動後も保持し、親Session削除時に削除する。filterはWindow内の一時状態で起動時OFF。保存構造は[Database SchemaのFiles Pin](database-schema.md#files-pin)を参照する
  - Pinはroot種別・root path・相対pathへの目印であり、本文の版やfile実体を固定しない。rename先や別rootの同名pathへ自動追従しない。削除・root除去・認可外・種類変更等は一覧に理由付きの利用不可項目として保持し、解除できる。元の認可済みpathが再び利用可能なら再読込後に使える。Pinによるroot追加やアクセス権拡大は行わない
  - Pin保存成功後に表示を確定する。読込・保存失敗時は取得済みPinを保持し、errorと`Retry Pins`を表示する。結果不明の保存も成功や未Pinへ変換せず、再取得後に変更を再開する。Session／root変更前の遅延応答は新しい表示に適用しない。Pin取得は登録参照先の検査だけに限定し、通常ソートとfilter切替は取得済み状態を利用する。再帰走査・本文読込・追加watcherは行わない
  - `Files | Changes | History` を切り替え、Changes は各 Git root の Working Tree / Staged を 1 file 単位で中央 live Git Diff へ開く。History は同じ File Explorer shellでcommit履歴とcommit時点のfileをread-only表示し、History内のCompareでlocal branch / remote-tracking branch / tag / HEAD / commitをDirect comparisonまたはBranch changesとして比較する。非 Git root は表示しない。包含関係にある root は独立した scope とし、同じ file も各 root からの相対 path で表示する
  - Historyのbranch selectorは現在選択中のbranchを`Current`で示し、branch名自体はraw valueのまま表示する
  - History Compareは4つ目のtabや独自のdiff surfaceを増やさず、Historyのfile tree、filter、Open All Changesを再利用する。比較時に解決したcommit object IDを保持し、branchの移動でpatchを暗黙に差し替えない。patchはcentral surfaceまたはdetached File Preview Windowで開け、before / after previewはcentral diffのactionからcommit-scoped File Preview Windowで開ける
  - Changes は user configuration から外部 command を実行しない。root の認可と表示 scope は ADR 015、Git executable、directory identity、config / index の隔離境界は ADR 014 を正本とする。有効な clean / process filter が必要な repository では、他の操作 feedback がある場合も理由を表示して利用不可にする
  - Git rootがない、または変更が0件という正常状態はblankで表現する。Git repositoryのdiscovery・availability・rejectと、Changes / Historyの取得・diff操作の失敗は理由を持つ実エラーとして扱い、正常blankへ潰さない。File Explorerのroot読込失敗は`role="alert"`で示し、読込中はspinner/statusと区別する
- 中央 file preview
  - message list だけを置き換え、Action Dock は表示したまま入力、添付、送信を受け付ける
  - ファイル名・操作のheaderと本文の間に、絶対パス専用の全幅領域を置く。pathはread-onlyで、長い場合は折り返して全文を表示し、Tabでfocusして選択・copyできる。狭幅では操作群も折り返す。通常fileはMainが解決したcanonical path、commit snapshotは選択root内の対応pathを表示し、Commit表示で本文の版を区別する。resourceの識別・認可や読込先は表示pathから変更しない
  - Text、Markdown、Mermaid（`.mmd`）、HTML（`.html` / `.htm`）、raster image、SVG、PDF、unsupported binary metadata を表示する。Text と source は行番号、soft wrap、文字コード切替を持つ
  - PDFは中央・独立PreviewとCodexの`visualize`による本文埋め込みで同じ閲覧専用readerを使う。本文埋め込みは会話の幅に収めた独立scroll領域とし、上部に元fileのlinkとReloadを置く。文書を主面積とし、reader上部にページ番号／label指定、前後ページ・移動履歴、10%〜800%の倍率、100% reset、Fit Width／Page、90度回転、Continuous／Single Page／Two Pages／Two Pages With CoverとFindを置く。本文はnative scrollとCtrl＋左dragによるpanを持ち、Ctrl＋wheelは保存済みの`Preview Wheel Zoom Step`を次の操作から適用する。折り畳みsidebarはThumbnails、Outline、Layers、Attachments、Infoを切り替える
  - PDFのFindは全文検索・一致強調・次前移動を提供し、ホスト側でのFile Preview Find shortcutもreaderへ渡す。文字選択後のCopyと、中央Preview・本文埋め込みで利用可能なQuoteはホスト側の明示buttonから実行する。既存注釈・コメント・フォーム値は閲覧のみとし、編集・保存・印刷は提供しない。画像PDFは表示できるがOCRは行わず、署名の外観表示は電子署名の検証を意味しない
  - パスワード付きPDFはreader内のdialogで入力し、誤入力時に再入力できる。Cancelでは解析を終了し、再入力はPreviewのReloadから行う。パスワードは永続化しない。readerの初期起動確認は15秒で打ち切り、応答がなければLoadingを終了してReloadを案内する。この期限は起動確認後のPDF解析・描画には適用せず、期限後の遅延応答では自動復帰しない。破損・解析失敗・XFAフォーム等の未対応は理由を示し、空白の表示成功へ置き換えない。通常fileのOpen等は既存の利用条件を維持する
  - PDF添付は一覧から明示的にreader内で開く。PDF、PNG／JPEG／GIF／WebP／BMP画像、対応拡張子のUTF-8テキストを扱い、HTMLも文字列として表示する。未対応形式はその旨を表示し、添付の実行・保存・自動openは行わない。文書外linkはホストで対象を表示し、Openを選んだ場合だけ既存のMainのlink解決・認可へ渡す。iframe自身は外部へ遷移しない
  - PDFも既存のfile認可・全量byte取得と50MiB以上のLoad Anyway確認を使い、原本は変更しない。Git commit snapshotは同じreaderで表示し、working treeのOpen／Show In Explorer等を追加しない。resource切替・Reload・unmountでは旧frameを破棄し、旧messageと解析・描画資源を残さない。隔離とasset配信は[Window Architecture](window-architecture.md#pdf-readerの隔離境界)を参照する
  - Markdown は shared rich text renderer、Mermaid は shared Mermaid renderer の Preview を既定とし、Source へ切り替えられる
  - HTMLは中央・独立File Previewで共通の隔離webviewを使い、残りの本文領域をPreviewへ割り当てる。相対CSS／JavaScript・画像・font・mediaとWebの通信・worker・iframe・一時storageを扱い、アプリのNode／preload／IPCは公開しない。local資源のrootとGit commitの境界は[HTML Preview Isolation](electron-window-runtime.md#html-preview-isolation)に従う。権限要求・子Window・外部protocolは信頼済みhost UIで確認し、downloadは保存dialogで保存先を選ぶ。確認はHTMLを背後に残すdim overlayとし、Cancel／Escapeとkeyboard focus循環を持つ。Sourceは文字コード切替後の原文を保持し、既存のCopy / Quoteを利用できる。FindはSourceへ切り替えて検索する。復号・IPCの安定性のためPreview入力はUTF-8で50 MiBまでとし、上限超過や描画失敗でもSourceは利用できる。描画失敗は理由とReloadを示す。Reloadは同一本文でも新partitionで描画環境を作り直し、以前の権限とstorageを引き継がない。focusしたPreview枠のEnterでHTMLへ移り、F6でアプリへ戻る
  - Mermaid内のlinkは通常のMarkdownと同じMainの解決・認可経路へ渡し、相対pathはpreview fileの親directoryを基準にする。diagramのanchorからWindow自体を遷移させず、無効・不存在・不許可の場合も図を保持してerrorを表示する。strictが除去したdestinationは復元しない。auxiliary clickとCtrl＋drag後のclickはopenしない
  - Mermaid flowchartの標準image nodeとnode・edge・subgraph見出し内のHTML `img`でlocal画像を図内表示する。`.mmd`、Markdown file内の図、会話内の図と通常Markdown画像に共通の画像resolverを使用し、登録root外も表示する。相対pathはfileでは元fileの親directory、会話ではWorkspace基準とする。画像ごとの読込失敗はplaceholderと対象・理由を示して図全体を保持する。記法、サイズ、安全境界は[Mermaid Images](message-rich-text.md#mermaid-images)を参照する
  - `.mmd`のFile Previewは、header・path領域・Find・feedbackを除く残りの表示領域を図の枠に割り当て、中央paneと独立Windowのresizeに追従する。Markdown／会話内の図は本文の流れを保つ高さ上限を持つ
  - Mermaidは中央・独立File PreviewとMarkdown／会話で共通の図単位のZoom Out／Zoom In、現在倍率兼100%リセット、Fitを持つ。初期表示はFitで、buttonによる手動倍率は10%〜800%を10ポイント刻みで変更する。Fitは小さい図を拡大せず縦横を表示領域へ収め、領域のresizeへ追従する。拡大後は図内のnative scrollで移動し、toolbarはスクロール外へ置く。各buttonはTabとEnter／Spaceで操作し、図領域へのfocus後はkeyboardでもscrollできる。Ctrlなしの左drag文字選択、通常の右clickとCtrlなしのwheelによるnative scrollを維持する。検索中に拡縮しても現在の一致位置を保持する。倍率・位置を他の図やWindowへ共有・永続化しない
  - 共通の倍率操作を持つMermaid、中央・独立File Previewの画像／SVG、会話・Markdownの画像lightboxは、表示領域上のCtrl＋左dragでscroll位置を移動し、Ctrl＋上wheelで拡大、Ctrl＋下wheelで縮小する。wheelはSettingsの`Preview Wheel Zoom Step`で整数1〜100ポイントを選べ、既定は5ポイント刻み（100%→105%）。刻みはapp共通で保存し、保存後の次のwheel操作から適用するが、現在倍率・Fit状態・pan位置は変更しない。Zoom In／Out buttonは10ポイント刻みとし、上下限は共通の10%〜800%で、Fit中は現在の実効倍率を起点にする（10%未満のFitからwheelで拡大する際は10%へ移る）。Ctrlなしのwheelはnative scrollに任せ、Ctrl＋wheelは表示対象だけに作用させてWindow全体のzoomや親scroll操作へ渡さない
  - image は 100% を既定とし、Zoom と Fit を受け付ける。単体Image / SVG previewはtoolbarと画像上のcontext menuから、表示中の画像をbitmapとしてclipboardへcopyできる。通常Markdown画像とchat画像は本文内・拡大表示のnative context menuに`Copy Image`を持ち、local画像には元fileの絶対pathをcopyする`Copy Path`も表示する。focusした画像previewからShift+F10／Context Menu keyでも操作できる
  - File Explorerのroot、directory、regular file rowはnative context menuに`Copy path`と`Insert path`を表示する。pathはMain processが現在のSession rootから再解決し、copyはlexical absolute pathをclipboardへ書く。insertはworkspace内をworkspace相対、workspace外をslash正規化したabsolute pathとして、既存の`@path`挿入処理へ渡す。menu表示後にactive ownerまたはcomposerの書き込み可否が変わった場合は挿入しない。symbolic linkとother rowは対象外とする
  - Windowsでは、File Explorerのregular file rowでpath操作の後ろをseparatorで区切り、file preview header、root-scopedなMarkdown local-file linkと同じく、既存regular file一件をExplorer互換のfile objectとしてclipboardへcopyできる。directoryとroot外Markdown linkは対象外とし、Copy Imageやpath文字列のcopyとは別操作にする
  - File PreviewのCopy File / Copy Image結果は、共有`AppNotification` primitiveを使ったheader内のoverlayとして表示する。通知は操作列のflex配置に参加せず、操作列の直下・右寄せに重なるため、既存の操作ボタンを移動・折り返しさせない
  - Copy成功はsuccess toneと`role="status"` / `aria-live="polite"`、Copy失敗はerror toneと`role="alert"` / `aria-live="assertive"`で表示する。下端の`session-file-preview-feedback`はpreview自体のエラー専用で、Copy成功通知には使わない。`AppNotification`の現在のconsumerはFile Previewだけとし、他画面への適用は各UIの意味と配置を確認してから行う
  - Ctrl+F は active な chat / Text / Markdown / Mermaid / HTML Source / live Git Diff を検索する。Preview 中の chat component は状態保持のため mount したまま非表示にするが、shortcut と検索対象からは外す。Text、Markdown、Mermaid、HTML Source、live Git Diff の選択範囲には chat と同じ floating Copy / Quote を表示し、Quote は現在の writable composer へ挿入する。Preview 表示中の Ctrl+A は、Find input または Action Dock の入力中を除き、Window 全体ではなく表示中の document または diff の文字列だけを選択する。rich previewのCopy／Quoteはブラウザーが選択した本文を使い、倍率toolbarなど選択不可の操作表示を含めない
  - file、live Git Diff、Template workspace から chat へ戻る操作は、左向き icon-only control と具体的な accessible name を持つ同じ navigation primitive を使う。run、approval、elicitation の状態は preview 中も確認できる
  - Template workspaceのSave / Delete処理中は入力を固定し、成功・失敗後に操作を戻す。本文・template IDを表示文言の変更で書き換えない
  - Template workspaceの診断エラーはアイコンで示し、詳細アイコンから非modal popoverで原文を開く。本文と回復操作の配置を保ち、画面端で位置・高さを補正する。重複見出しは置かず、本文右上のClose、Escape、入口の再操作、関連領域外のclickで閉じる。CloseとEscapeでは入口へfocusを戻し、外側で移ったfocusは奪わない。取得失敗にはRetryアイコンを併置し、短い失敗通知・操作名・開閉状態を支援技術へ伝える。名前や本文の入力不備・名前の重複は修正に必要な短い説明を表示し、失敗時の編集値は保持する
  - Skill 候補のような一時 surface は右上の × と具体的な accessible name を使い、`Escape` でも dismiss できる。view 間 navigation の Back とは表現を分ける
- detached file preview
  - File Explorer は通常 click で中央 preview、Ctrl+click / Cmd+click で detached preview を開く。Changes は通常 click で中央 live Git Diff（untracked は中央 file preview）、Ctrl+click / Cmd+click で detached live Git Diff（untracked は detached file preview）を開く。Session message の local-file link は detached preview を開く
  - Session messageとMarkdown previewのdirectory linkは、登録root内外とも明示clickでOSのfile managerを開く。macOSは通常folderとapp bundle／packageを区別せずFinderで対象を選択表示し、アプリの起動は行わない。追加dialogやAdditional Directoryの自動登録は行わず、アプリ内列挙とProvider権限は変えない。成功時は操作元の既存errorを消し、失敗時は同じfeedbackへ理由を表示する。対象検証は[Message Rich Text](message-rich-text.md#link-handling)を参照する
  - 中央 preview と同じ `SessionFilePreview` / `SessionDiffPreview` を使用し、Quote と Action Dock は表示しない
  - live Git Diff の `Open preview` は対象 file を通常 preview として開く。detached file preview から開いた live Git Diff と Changes から直接開いた detached live Git Diff は、左向き icon または `Open preview` で同じ Window の preview へ戻る。独立 File Preview、snapshot Diff、Character Editor の Window 自体は native window chrome で閉じ、各Window内に重複するClose操作を置かない。File PreviewはHomeのPreviews一覧からも個別・Session単位で閉じられる
  - Character Editor が dirty な状態で native window chrome から閉じようとした場合は、編集内容を保持したまま in-app の破棄確認を表示する。キャンセルでは編集へ戻り、明示的に破棄した場合だけ Window を閉じる
  - `New Session` dialog はfooter左端の`Cancel`で閉じ、右端の`Start`で開始する。開始前の`Cancel`では作成せず、開始後は送信済みの作成を取り消さない。`Start`がdisabledでも`Cancel`は使用でき、重複する常設 Close control は置かない
  - Auxiliary 起動 dialog も backdrop click と `Escape` で dismiss できるため、重複する常設 Close control を置かない
  - 破棄確認は単一の dialog surface に確認対象と操作を直接配置し、見出しと重複する補足文や装飾目的の card を置かない。破壊的操作は neutral なキャンセルと色・文言の両方で区別する
  - 同じ root-scoped resource は既存 Window を前面化し、異なる resource は複数 Window を開ける。navigation、認可、lifecycle の決定は ADR 020 を正本とする
- live Git Diff と chat artifact Diff は別機能とする。artifact の永続化・Diff modelは維持するが、Details UIには `Changed files` と `Open diff` を表示しない。File Explorer の Changes や中央 live Git Diff へ接続する判断は別consumerの契約で扱う
- 中央 live Git Diff は Split を既定表示とし、Inline へ切り替えられる。両表示は同じ unified patch と検索modelを投影し、Split でも表示rowをvirtualizeする
- work surface は外側 card を持たず、padding / gap を抑えて message viewport を優先する
- message list は条件付き follow mode で動かす
  - user の scroll intent と末尾移動は一つの follow owner が決定し、virtual row の再計測は visible anchor の補正だけを担当する。viewportより完全に上側の行の高さ変更を補正し、読みかけの行自身の高さ変更では行先頭のviewport内offsetを変えない
  - 上方向のwheel・キー・touchとscrollbarによる読み返し、検索・一覧からの移動で追従を停止する。子のスクロール領域が消費する操作、入力欄操作、zoom、クリック・選択だけでは会話の追従意図を変えない
  - 遅延描画・行高再計測・viewport resizeによる位置変化では追従意図を変更しない。通常の末尾補正は同frameに集約し、既に末尾1px以内なら書き込まない。送信handoff中は変化したviewportをpaint前に反映し、dockに対して1frame遅れた位置へ補正しない
  - virtual rowのResizeObserver計測は通知内で反映し、サイズ変更後の配置をpaint前に揃える。anchorの補正条件や追従意図は変えない
  - 追従停止中は位置を維持し、userの下方向操作で末尾24px以内へ戻ると追従を再開する。layout変化だけで末尾へ近づいても再開しない
  - 会話の初回表示は末尾へ追従する。切替・previewからの復帰では会話incarnation別cacheの追従状態と閲覧位置を復元し、読み返し位置はmessage keyとviewport内offsetを優先する
  - 追従停止中だけ列内overlayの`Jump to latest`を表示する。本文・予約状態の更新有無によらず、通常の下矢印icon-only buttonの外観と操作名を維持する
  - `Jump to latest`は履歴pageを解除して末尾へ復帰し、ボタンが消えた後はmessage listにfocusを戻す
  - 通常Send・送信shortcut・実行中の予約送信は、先行表示を反映した送信時に`Scroll To Latest On Send`を対象Columnへ一度適用する。受付ACK・再照会・元要求の再試行は新たな移動を起こさず、送信後の読み返しや会話・送信対象切替を維持する
- pending 中の live activity / streaming response
- Main／Auxiliaryは送信直後に会話ID・incarnation・request IDと捕捉本文のWindow内表示を作る。準備・受付待ちは正常な待機枠または予約本文を保ち、明示的な処理エラー・timeoutだけを対象送信のerror表示へ切り替える。受付後は同じrequest IDのreceiptへ、実開始後は保存user seqへ接続する。ACKや高速な終端が会話取得より先でも送信文と応答面を保持し、確定時に重複追加しない。先行表示から保存済み本文・実行状態を生成しない
- streamingの`assistantText`は会話本文として表示する。送信時から応答用のassistant行にCharacter avatarとdot bubbleを置き、準備・受付・実行開始を待たず通常の応答面を確保する。本文の到着後も同じレスポンス枠内にdot bubbleを維持する。処理中表示だけの独立したavatarや行は作らず、同じrunの既定待機文を会話本文へ重ねない
- Main／Auxiliaryの通常応答はrequest／turnの表示identityを保ち、待機・live本文・保存済み本文への接続でassistant行・avatar・応答cardを差し替えない。表示中の応答本文はPreview／Source共通で100ms単位の最新snapshotへ集約し、通信の細かな到着間隔をそのまま高さ更新へ流さない。timerの実行が遅れても中間本文を順次再生せず最新を表示する。終了・失敗・取消・承認・質問・本文検索では集約待ちを解除し、会話切替・非表示・unmount時は旧応答の待機更新を破棄する。実行・保存と操作可否は実状態のままとし、表示待ちにはしない
- 確定した送信・実行失敗は応答側の共通エラー欄へ`Failed`と理由を一度だけ表示する。開始前・本文なしでは同じ欄だけを置き、途中失敗では受信済み本文・Detailsを保持して本文の下へ置く。失敗通知は生成本文に追記せず、Copy／Quote対象の本文と分離し、本文を折りたたんでも理由を隠さない。送信側の失敗理由・Failed表示は重ねない。`Resend`／`Edit`、結果不明の`Interrupted`と`Release Later Turns`、取得失敗の`Retry`はそれぞれの責務を維持する
- 確定失敗の応答枠はCharacter色ではなく固定のエラー色で左線と薄い背景を表示し、エラー欄自体には枠・背景を重ねない。通常応答のCharacter色とavatarによる識別は維持する
- 処理中表示の所属は、投影が会話ID・thread・メッセージ位置から生成するmessage keyで識別する。保存済み本文とlive本文が異なる場合も対象の応答枠を使い、本文一致や最後のassistantから推測しない。Main／Auxiliaryで所属を分離し、完了・失敗・キャンセル後は本文を重複させず処理中表示を消す
- pending bubble には provider-native pending item を差し込める
  - `approvalRequest`: `Allow Once / Reject`
  - `elicitationRequest`: 会話内の[Question Forms](#question-forms)。通常質問は`Close / Submit`、MCPは`Reject / Close`とformの`Submit`またはURL completionの`Complete`
  - Elicitationの入力待ちでは、応答行が履歴の表示範囲外へ出ても同一requestの未送信回答を保持する。入力待ちの応答行だけを仮想化の描画対象に残し、requestの解決・run終了後は通常の描画範囲へ戻す。異なるrequestへ回答を持ち越さない
  - Approval / Elicitation の解決中は既存 pending item 内の spinner と `aria-busy` で待機を示し、同じ対象の状態文を重複表示しない
- `live run step` は pending bubble に混在させず、right pane の `Latest Command` へ要約して分離する
- right pane は `Latest Command` を基本 tab とし、provider が `Copilot` の時だけ `Tasks` tab を追加する
- right pane 上部には collapsed state の `title handle` を置く
- right pane shell は Agent で共有する。表示する内容がない mode では pane 構造だけを残し、説明文や空メッセージを常設しない
- right pane の本文scrollbarはtab直下からpane下端まで共通の高さにし、`Messages`のfilterと`Glossary`の検索欄は本文の上端へ固定して一覧だけを流す
- Messages navigatorと全履歴query pageは総件数に対してrowをvirtualizeし、All／Bookmarkのいずれも未取得pageを含む全履歴を対象にする。native rowのaccessible nameとfocusを保ち、Arrowで全件内を巡回、Home／Endで先頭／末尾、Enterで本文へjumpする。結果pageの到着でscroll位置を初期化しない。Bookmark切替と会話owner変更では一覧を先頭へ戻し、owner変更ではAllへ戻す。loading／error／Retryと成功0件の空本文を区別する
- `Generate Memory` は current UI では表示しない
- command 実行中は `Latest Command` を最優先で自動表示する
- MemoryGeneration / 独り言の right pane 自動切り替えは行わない
- right pane の正常empty / idle bodyはblankにし、pane shell・tab・必要な操作・accessible statusだけを残す。実エラー、validation、安全・復旧説明は維持する
- `Latest Command` には raw command、status、source、rough risk badge、必要時だけ開く `details` を出す
- 同owner・同turnの保存済みcommandと詳細は、通知・Session更新・Retryによる再取得中と失敗時にも保持する。loading／errorと`Retry`はcommandの有無に依存せず同じpaneへ表示する。新turn、会話やincarnationの切替では旧commandを表示しない
- 実行中に確定した live step があれば、`Latest Command` の下に `Confirmed Details` として直近数件だけ補助表示してよい
  - 直近の in-progress command とは分ける
  - full timeline には戻さず、summary + optional `details` に留める
- provider が `Copilot` で background task snapshot が来た時は、right pane の `Tasks` tab で `agent / shell` の running / completed / failed を確認できるようにする
- `Tasks` tab は `/tasks` 全機能の再現ではなく、current session に紐づく background task の coarse な観測面に留める
- `Memory生成` tab は current UI では表示しない
- provider が `Copilot` の時だけ、`Latest Command` の下に `Copilot Usage` の薄い strip を常設し、残量だけを即読できるようにする
- `Context` は同じ領域の collapsed details として置き、ユーザーが開くまでは右 pane の面積をほとんど使わない
- `assistantText` は会話本文としてのみ扱い、`agent_message` を activity row へ戻さない
- 応答内のdot bubbleは準備・受付・応答の待機を示し、`assistantText`の出力開始後もrun中は維持する。保存上の`running`やCancel可否は実run状態から判断し、先行表示で有効化しない
- Main / Auxiliaryのtarget切替buttonは左右paneのiconと選択状態で送信・操作対象を表し、実行状態によらずtooltipとaccessible nameを維持する。実行状態は主にHomeのMonitorで確認し、会話内の処理中表示、Auxiliary一覧のprocessing indicator、選択対象のCancelは維持する。片側の会話欄が非表示の場合やPreview表示中も、target切替内に実行状態の表示や通知を追加しない
- 実run終了後も確定応答の取得待ちなら同じ応答面と取得済み本文を保つ。確定本文への接続または明示失敗で待機表示を終え、success固定の完了表現にはしない
- `assistantText`未着でもright paneの `Latest Command` があればraw commandを表示し、command未到着の正常局面では本文copyを表示せず、末尾のdot bubbleとaccessible statusで待機を示す
- screen readerには会話本文全体でなく末尾行の状態変化を通知する。Action Dockから重複して通知しない
- retry draft conflictとcomposer feedbackはvisible textを正本にして常時live通知しない
- `command_execution` は通常 paragraph ではなく shell command と即判別できる専用の monospace block で表示する
- `details` は stdout / stderr など二次情報だけを折りたたみ表示する
- `liveRun.errorMessage` は `Latest Command` のalert blockとして扱い、`Run Error` 見出しを `var(--ink)` の前景色で表示する
- right pane 自体の描画失敗は pane 専用 fallback に切り替え、`Retry Right Pane` と `Reload Window` を出す
- right pane は run 中の command 安全確認面として扱い、full timeline や `Turn Inspector` は常設しない
- 実行中は上段に `Cancel` を表示する。下段の主ボタンはMain／Auxiliaryとも常に単一の `Send` とし、入力欄を編集可能に保つ。通常送信shortcutも同じ永続受付を使い、実行中は次Turnを予約する。現在Turnが追加入力を受け付けないproviderや取消終了待ちでも予約を受け付け、実guard解放まで開始しない。quit／closeの入力凍結中は送信と添付を無効にする
- Codexの現在Turnが入力受付可能な間はチャットの予約項目に `Steer` を表示する。捕捉した本文・添付を同じTurnへ一度だけ送り、開始準備中・取消中・終了後の操作を新Turnへ振り替えない。追加入力は実行中Turnの設定を維持する。独立した追加入力shortcutは現在のComposer下書きを直接送り、通常Sendとは混在させない
- 予約は通常のuser bubbleとして現在Turnの応答より後へ受付順に置く。本文を主役にし、下部に右寄せの個別`Cancel`と、利用可能な時だけ`Steer`を添える。待機順や開始・実行中の状態文字は表示しない。空queueに専用sectionは出さず、通常履歴と別のreceipt一覧や重複本文も表示しない。狭幅では操作を折り返し、本文を縮小しない
- 失敗・結果不明は対象bubbleに状態と理由を示し、必要な回復操作だけを近接表示する。結果不明の`Release Later Turns`は元要求を再実行しない。queue取得・操作の失敗は取得済み本文を保ち、理由と`Retry Queue`を表示する。受付応答が不明ならComposerに`Check Receipt`／同じIDの明示再試行を提示し、新しいIDへ自動置換しない。受付ACKは一致するdraft revisionだけを消す
- 追加入力は受付を確認したdraft revisionだけを消す。失敗・結果不明時は対象会話のcomposerに理由を示し、draftを保持する。Auxiliaryの受付待ち中に編集した本文は成功・拒否後のdurable revisionへ保存し、通常の追編集にRetryを要求しない。Auxiliaryでは失敗後も現在のdurable draft revisionで明示再送できる。送信準備中のdraft編集・会話切替は古い送信を無効化し、受付待ち中の重複送信を通さない。Providerからの入力質問は会話内のQuestion Formsで回答し、secret textはpassword inputで扱う。nonblockingの質問も受付状態の見出しは置かず、必須待ちと区別して応答生成中のstatusを維持する
- Main／Auxiliaryとも取消click直後から同じ位置の`Cancel`をdisabledとbusy stateにし、共通ボタン規約に従ってspinnerだけを表示する。通知前の要求待ちは対象会話・Turnに限定し、liveの取消受付・終了待ちへつなぐ。失敗では理由を示して再操作できる状態へ戻し、旧取消要求の遅いACKで後続Turnを巻き戻さない。取消終了待ちでも予約受付は可能だが、現在Turnへの追加入力と新しい実行開始は許可しない。保存済みSessionがidleになってもlive取消状態を優先し、元処理と必要な終了処理の解放通知後に後続の実行を開始する
- 取消は送信の逆再生にしない。受信済み本文・応答枠・avatarを保持し、同じ枠内の待機状態を停止確定までつなぐ。本文未着では同じ待機枠を使い、停止を完了応答に見せない。取消を理由にdockを自動展開・折りたたみしたり、draft・閲覧位置を巻き戻したりしない
- assistant message ごとの `Turn Summary`
  - 展開導線は chat row の独立 1 行 button ではなく、assistant bubble 右上の小さい icon button とする
  - 詳細が欠落・取得失敗した場合はDetails内に状態と再openによる再試行を示し、会話本文と保存済みsummaryを維持する。同じ展開・表示期間では本文更新による自動再取得を行わず、閉じて再open・非表示からの復帰・履歴page復帰で取得し直す
  - `Changed files` は Details UIには表示しない。artifactの永続化、Diff model、Changes paneのデータはこの表示変更だけでは削除しない
  - `Run checks`
    - approvalはprovider別候補のdisplay labelで表示する
  - turn 内の operation timeline は arrival 順を保ち、全 operation を1つの `Operations` groupにまとめる。groupはdefault closedとし、summaryでは件数を示し、展開時は元のoperation単位・元順序で表示する
  - `Operations` groupの展開内容は高さを制約し、長い内容はgroup内部でscrollできるようにする。Details本体、Operations group、各operationはkeyboardで開閉でき、native detailsのaccessible name / focus / expanded stateを維持する
- composer 上の添付 toolbar
  - toolbarの操作はicon-onlyとし、操作名はtooltipとaccessible nameへ残す。単独操作は40pxの角丸button、Main / Auxiliary・Preview / Source・Prompt / Terminalは36pxのicon buttonを囲む選択groupとする。選択状態・focus・disabled・busyを維持する
  - `Attach` button から単一の attachment popover を開く
  - popover の `Attach` section は元 path を参照する `File / Folder / Image` を1行にまとめる
  - popover の `Session Files` section は session local files を扱う `Copy / File / Folder / Image` を1行にまとめる
  - `Skill` は別カテゴリの単独 button として区別する
- 添付 toolbar は Agent の作業 chat 用であり、メイトークでは表示しない
  - Add DirectoryとAdd Directory By Pathは隣接した1group内の直接操作とし、中間menuを挟まない。追加済み一覧は別のfolder iconと件数を持つDirs toggleへ分離する
- composer と textarea の間に独立した attachment tray / chip list は置かない。添付はpopover、paste、textareaへの `@path` 挿入から送信時の解決へ渡す既存経路を維持する
- textarea 内の `@path` 参照
- `@path` 入力中の workspace file path 候補表示は持たない
- 手入力または paste された `@path` は送信時に検証し、存在しない path は composer feedback として表示して送信しない
- ファイル／画像pasteは同名・同内容なら既存pathを挿入し、操作不要の通知で再利用を知らせる。同名・別内容なら`Replace Pasted File`で置換の影響を確認し、`Save a Copy`で元fileを残して両方を保存できる。`Cancel`を初期focusにし、`Replace File`だけが置換を確定する。通常Composerと質問自由回答で共通とし、比較範囲・保存・取消は[Session Local Files](session-local-files.md#composerと保存)に従う
- picker で選んだ file / folder / image も textarea に `@path` を挿入する
- 添付 picker は初回だけ workspace を開き、以後は最後に選んだディレクトリを開く
- composer toolbar の `Add Directory` はフォルダーピッカーを開き、隣の `Add Directory By Path` は絶対パス入力dialogを開く。dialogの通常表示は操作名の見出し、可視label・placeholderのない入力欄、`Cancel`／`Add`のみとし、compactな角丸と余白を使い、背景をblurしない。dialogと入力欄は左右の余白を残してAction Dockの利用可能な横幅に追従し、狭幅ではみ出さない。入力幅を超える長いpathも値を省略・変形せず、選択・横スクロールで全体へ到達できる。入力欄のaccessible nameは維持する。パス入力はHomeのWorkspaceと共通部品・検証controllerを使い、入力停止から300ms後に検証する。検証待ち・確認中は入力内のspinnerとaccessible statusで示し、空欄・検証中・無効pathでは`Add`を無効にする。入力変更・閉鎖・対象切替後に古い検証結果を反映しない。Main／Auxiliaryとも、実在するアクセス可能なdirectoryを検証して既存の許可リストへ追加する。Windowsのパス入力はdrive付きまたはUNCの完全修飾pathを必要とする。drive未指定rooted path、相対path、不存在、file、利用不可、保存失敗では入力を保持してalertを表示し、再入力できる。追加時もパスを再検証し、追加処理中は `Add` を無効にして、dialog内のfocus移動、Enterで追加、Escape／Cancelで閉じた後のfocus復帰を維持する。追加処理中はdialogを閉じず、重複送信を防ぐ。横の `Dirs` toggle から `Additional Directories` 一覧を既定 closed で開閉できるようにする
  - composer下のruntime settingsはshared chat composerを正本とし、providerの対応範囲で`Approval / Sandbox / Model / Depth`を表示する。CodexとClaudeでは`Approval`の直後にcompactな`Reviewer`（`User / Auto Review`）、同じ列に`Speed`（`Standard / Fast`）を表示し、Session単位で保持する。Approvalは承認方針、Reviewerは判断担当とするWithMate共通の定義とnative写像は[Provider Adapter](provider-adapter.md#approval-modes)を正本とする。`Reviewer`はread-only、blocked、入力凍結、またはApprovalが`never`の間は現在値を保持したまま変更できず、その他のruntime optionもproviderの対応範囲と編集制約に従う
  - CodexとCopilotのApproval候補は`Auto Run / Provider Controlled / Safety Focused`
  - ClaudeのApproval候補は`Auto Run / Provider Controlled / Accept Edits / Preapproved Only / Plan`。既定は`Provider Controlled + User`。Auto ReviewはReviewerで選び、Provider Controlledとの組合せで有効になる。Auto RunではReviewerを適用せず保存値を保持する。Auto Reviewの選択中にAccept Edits／Preapproved Only／Planを選ぶと、ReviewerをUserへ切り替える確認を表示する。承認時は両方を一括変更し、取消時は両方を保持する。ReviewerがUserしか選べない正常状態ではcontrol全体をdisabledにするが、不正な保存組合せではinvalidを示してUserへの変更を受け付ける。保存Approval自体が非対応の場合は`Unsupported (保存値)`を選択表示し、invalid stateを保持する。ユーザーの明示選択で修正でき、黙って権限設定を置き換えない
  - runtime設定は、Main／Auxiliaryの次送信用の現在選択を表示する。runningや取消終了待ちでも選べるが、実行中Turnと受付済み予約の捕捉値は変えない。対象切替では各会話の選択値・provider能力・read-only／blocked／freeze条件に対応する
  - OpenCodeのApprovalは`Provider Controlled`（既定）と`Auto Run`を選べる。`Safety Focused`、Sandbox／Reviewer／Speedは提供しない。OpenCodeのform質問は共通Question Formsで回答し、実行中の`Steer`とCopilot専用`Tasks`は表示しない
  - ModelはSessionの固定providerのSDK候補を検索するpopoverとする。通常は表示名の自然順昇順、同名は配信元・ID順とし、検索結果は名前／IDの完全一致、前方一致、部分一致、配信元だけの一致を優先する。選択中modelにcheckを付け、識別用の配信元とIDを併記する。大量候補はvirtualizeし、開いている候補はsnapshotとして保持する。矢印／Page移動、Enterで選択、Escapeで取消とfocus復帰、IME変換中のEnter抑止を提供する。providerやsortの追加UIは置かない
  - Modelはcacheを先に表示し、古い一覧はbackground更新する。取得中・取得失敗・正常empty・検索0件を区別し、候補の更新で現在選択、draft、threadを変更しない。候補から消えた現在modelも表示する。Depthは独立した選択とし、modelがadvertiseする任意の値を表示する。Depth候補が空なら隠す。取得・実行の境界は[Provider Model Discovery](model-catalog.md)を参照する
  - Model以外のruntime設定はnative single-select controlのkeyboard操作を維持し、menu内には正式な選択肢を表示する。Electronのcustomizable selectでmenuに6px、各選択肢に上下8px・左右12pxの余白を設け、viewport内へ収める。常設の項目名は省略し、Approval / Reviewer / Sandbox / Model / Depth / Speedの現在値を文字で表示する。項目名はtooltipとaccessible nameに残し、disabled・invalid・focusの状態を維持する。幅が不足するときは文字や余白を縮めず設定群を折り返す
- session title は mate `main`
- assistant本文はgradientを使わず、`main`の細い左線とavatarの縁、控えめな背景色で周囲から区別する。user本文は控えめなsurfaceで区別し、通常のassistantとuserの枠は同じ丸みを持つ。pendingとAuxiliary groupの状態表現は維持する
- composer settings は独立したaccent背景を持たず、周囲のsurfaceと同じ背景を使う
- `Send / Cancel` は mate `main`
- Main／Auxiliaryの送信時の自動折りたたみは共通の`Close Action Dock After Send`設定を使う。送信準備中に対象会話やpickerを切り替えた場合、または手動でdockを操作した場合は、その後に返った古い送信処理で新しい開閉意図を上書きしない
- sendability 判定は共通resolverへ寄せ、Composer内の購読と送信shortcutで最新draft・preview・強制feedback条件を使う。入力のたびにSession shellを更新せず、`sessionExecutionBlockedReason` / `composerPreview.errors` を Send 近傍の単一 feedback area で扱う
- Send disabled 条件は submit button / `Ctrl+Enter` / `Cmd+Enter` guard で一致させ、blank / whitespace-only draft の no-op 送信を通さない
- blank / whitespace-only draft は通常時は helper 文言を常時出さないが、blocked 送信ショートカットを押した時だけ inline reason を見せる
- send button の `title` には current blocked reason を載せ、hover でも送信不可理由を確認できるようにする
- disabledなSendの説明要素へTabで到達できるようにし、操作名と現在の理由への説明参照を保つ。理由・回復操作が既に表示されている場合はその案内を使い、それ以外はSend近傍のoverlayで理由を示す。overlayはEscapeまたはfocusを外すと閉じる。focus時の理由表示はComposerの高さやscroll位置を変えず、上段toolbarとSendを押し出さない
- Composerの下書き保存・送信失敗は短い状態文とerror icon付きの`Details`入口で示し、診断原文は非modal popoverで開く。受付不明は失敗と区別して案内と`Check Receipt` / `Retry Original Turn`を維持し、回復操作の失敗詳細も同じ入口から確認できる。入力修正・権限・安全に必要な説明は折りたたまない
- 診断popoverは回復操作列を覆わず、viewport内で長文をscroll・選択できる。詳細の開閉でComposerの高さを変えない。Escape／閉じるbuttonは入口へfocusを戻し、入口の再操作／外側clickでも閉じる。会話切替や対象エラーの更新で古い詳細を閉じる
- 受付不明の回復案内では`Details`入口の自然寸法を予約し、診断の有無や回復操作の待機・失敗で`Check Receipt` / `Retry Original Turn`の位置と寸法を変えない。診断がない予約領域は不可視とし、操作・読み上げの対象から外す。狭幅では同じ領域を保って折り返す
- `runState === "running"` では `Cancel` 主体の既存 UX を維持し、送信不可説明を主表示しない
- `Details` 展開後の artifact block 背景は `main / sub` の薄い accent を持つ
- `Ctrl+Enter` / `Cmd+Enter` 送信
- terminal state 後の再送導線
  - `runState === "running"` 中は recovery action surface を出さず、既存 pending / `Cancel` を維持する
  - 最新turn記録の取得だけでは再送用の警告枠を生成しない。通常の読込中は枠のないspinnerとaccessible busy status、実際の取得失敗はerrorと`Retry`で示す。既知のterminal stateがある場合は、その回復操作を再取得中・取得失敗時にも保持する
  - `runState === "interrupted"` または `runState === "error"` で、`lastUserMessage` がある場合に回復操作を出す。失敗の事実・理由は応答側の共通failure row、中断は既存のchat noticeで示し、操作列で重複させない
  - `runState === "idle"` でも最新turn記録 `phase === "canceled"` + `lastUserMessage` ありなら回復操作を出す。取消状態は既存のchat本文で示す
  - `lastUserMessage` がない session では retry 不能のため surface を出さない
  - 共通 `ChatWindow` が回復操作を所有し、Action Dockの既存上段操作列へ配置する。Prompt展開・compact・Terminal・中央file previewのいずれでも到達でき、activeな列だけに描画する。通常時は回復用の空領域を予約せず、既存Cancelの予約領域を維持する
  - Mainと選択中Auxiliaryは同じ操作を使う。対象会話、前回依頼、最新turn、編集先draftを同じownerへ束縛し、会話・incarnation・依頼の切替で古い置換確認を無効にする
  - 通常の回復表示は`Resend` / `Edit`の2つのicon-only操作に限定する。操作対象は既存のMain / Auxiliary切替、前回依頼・停止状態・失敗理由はtranscriptから確認する。tooltipとaccessible nameには対象会話と操作名を含める
  - 回復操作の出現と`Resend`はAction Dockのexpanded / compact、Prompt / Terminalの選択を変更しない。狭いWindowでは操作を折り返し、横overflowさせない
  - 回復操作の出現とdraft置換確認は単一のpolite statusで通知する。無関係な再描画やDockのmode切替では重複通知せず、出現時にfocusを奪わない
  - retry CTA は `Resend` と `Edit`
    - `Resend`: 選択会話の既存送信経路で前回本文を即時再送し、現在のdraftを送信・消去・書換えしない。受付不明時は再送を無効にし、既存の`Check Receipt` / `Retry Original Turn`を使う
    - `Edit`: 前回本文を対象会話のdraftへ戻し、Promptを開いてtextareaへfocusする。自動送信はしない
  - 異なる非空draftで`Edit`を押した場合は、`Your current draft is preserved.`を示す確認dialogを開く。`Keep Current Draft`または`Escape`で保持し、`Replace With Previous Request`を明示選択した場合だけ置換する。確認中も背面のDock選択は維持する
  - 最新turnの取得失敗からの`Retry`、実行受付不明の確認、後続turnの`Release Later Turns`はそれぞれ別の操作として維持する
- inline `Diff Viewer` overlay
- `Open In Window` による `Diff Window` popout
- inline `Diff Viewer` overlay は open 時に dialog 内へ focus を移し、`Escape` で閉じ、`Tab` / `Shift+Tab` を dialog 内で循環させる

## Diff Window

- side-by-side split diff
- 縦スクロール同期
- 横スクロール同期
- 長い行は横スクロールで読む
- 狭幅では `Before / After` を縦 stack に倒し、必要な横 scroll は各 pane 内で扱う
- current minimum は `900px` 台の split-screen を想定し、stack 後も読める下限に寄せる
- `Before / After` の各 pane head / body は keyboard focus を受けられ、矢印キー、`PageUp` / `PageDown`、`Home` / `End` で scroll できる
- Session から開いた Diff は mate theme snapshot を引き継ぎ、`titlebar / subbar / pane header` にだけ薄い accent を持つ
- `Before / After` 見出しは差分面から独立した label chip として表示し、背景色に埋もれないコントラストを維持する

## Interaction Notes

- Home から Session / Settings / Session Monitor を開く
- Session の作成・更新・削除は Main Process 経由で永続化する
- Session の実行中イベントは Main Process から live state として IPC 中継する
- Home の `Monitor` は Main Processの開いているWindowと保持済みSessionを、専用のbounded summary queryで参照する。実際のopen Window IDはRandom起動・Window復元等のために別の集合として維持する
- Home の `Monitor` と `Session Monitor Window` は同じ query / projection / component を使い、監視対象の親に紐づく保存済みAuxiliary summaryを同じ順序で集約する。状態更新は既存のlive event、Window開閉、Session invalidation、focusによる再読込で反映し、pollingやMonitor専用storageは持たない
- Auxiliary summary再読込は監視対象parentのpage単位で一括取得し、親数に比例した個別SQLite取得を行わない
- MonitorからAuxiliaryを選択して開いたときは、Mainがstable Auxiliary IDとparent IDを検証してnavigationし、既存Windowにはselection event、新規Windowにはentry queryで正確な会話を渡す
- 通常履歴の応答Detailsから操作結果を閲覧する。Latest Commandは実行中・取消待ちのliveを優先し、終了後はReasoning／background tasksのsnapshotを保持していても、対象会話の最新turnとその`assistantMessageSeq`に対応するartifactを遅延取得する。最新turnにcommandがなければ以前のturnへ遡らない。未記録・正常emptyと取得失敗を区別し、対象切替・次turn開始後に遅い結果を適用しない。Window再open・再起動、failed／canceled後も同じ対象境界を使う
- chat message は限定的な rich text renderer で整形表示する
- `Settings Window` は app 共通 system prompt や Character 本文を編集しない。Character 定義は `Character Editor Window` と session snapshot を正本にする
- `userData` は `<appData>/WithMate/` に固定する
- Session は mate の `main / sub` theme color snapshot を保持し、現在は header title、assistant / pending bubble、`Send / Cancel`、artifact block、Session から開く Diff の `titlebar / subbar / pane header` の限定的な accent に使う
- theme 由来の前景色決定は輝度閾値ではなく共通 contrast helper を正本にし、Home / Character Editor / Session / Diff で同じ WCAG AA 基準を使う
- 保存済み会話は SQLite を正本とし、表示中の実行設定は現在選択を使う。Send はその時点の選択値を捕捉し、checkpoint の完了を待たない
- model候補はprovider／workspace／設定・認証context別のSDK cacheを読み、一覧更新は実行設定や履歴のmigrationを行わない
- message list follow mode は assistantText streaming / pending bubble 更新に反応し、command 監視は right pane の `Latest Command` へ分離する
