# Desktop UI

## Auxiliary Session (Issue #710)
Session WindowはMain左と選択中Auxiliary右を同じchat shellで表示できる。Auxiliaryは複数保持し、中央のタイトル枠内にある`＋`から既存会話を閉じず最終使用順の一覧へ反映する。Auxiliary中央の左右矢印と表示名一覧はstable Session IDで選択し、一覧行はCharacter iconと非AIの会話previewだけを表示する。実行中のAuxiliaryはicon内にcompactなprocessing indicatorを重ね、行高とpreviewの幅を変えない。折りたたみ時はAuxiliary面・内部境界・タイトル枠内の操作を隠し、splitterだけを再展開導線として残す。折りたたみでActionDock対象や選択中Sessionを変更しない。

Auxiliary追加のprovider pickerはHome `New Session`、Character authoringと同じloading / error / ready 0件の状態境界を使い、開始処理中のbusyをalertへ変換しない。


## Goal

Electronデスクトップアプリとして、各Windowの現行UIと操作の入口を把握できるようにする。Window間の責務は[Window Architecture](window-architecture.md)を参照する。

## Manual Test Maintenance

- 現行 UI に対する実機確認項目の正本は `docs/manual-test-checklist.md` とする
- この文書に影響する UI 変更を入れた場合は、同じ論理変更単位で実機テスト項目表も更新する
- 運用方針の詳細は `docs/design/manual-test-checklist.md` を参照する

## Scope

- Home の session / Character catalog 管理 UI
- Character Editor Window
- Session Monitor Window
- Session の coding agent 作業 UI
- Diff Window の閲覧 UI
- Settings Window と model catalog 操作
- Session の監査ログ閲覧 UI

## UI Source Of Truth Boundary

- current UI の正本はこの文書とする

## 表示言語・操作・状態

- アプリ内UIのユーザー向け表示文字列は英語を標準とする。Character定義、ユーザー入力・生成コンテンツ、provider向け指示、ログ、テストデータ、開発者向け文書は対象外とする。
- アプリ所有の短い表示文、見出し、label、button、option、status名は単語間に空白を入れたTitle Caseを使う。長いerror・safety説明、screen reader向けの自然文、ユーザーが入力・生成する内容は読みやすい文章を維持する。検索inputのplaceholderは表示せず、accessible nameは残す。ブランドとAPI / CLI / JSON / MCP / URL / HEAD等の正式表記は維持する。
- theme tokenと既存CSS variableを優先する。新しいsurface・badge・button等の色を追加する時は、その上のtext・icon・borderのcontrastを同時に確認する。disabled、muted、placeholder、secondary textと、hover、selected、active、focus、error、warning、successの状態も背景へ埋もれないようにする。
- 現役6 HTML entryのshellは`lang="en"`とする。会話、ユーザーtitle、Character定義、テンプレート本文、ファイル内容・path、raw診断、Provider指示は原文と保存値を維持する。表示用の日時・件数には英語localeを明示し、ローカルtime zone、保存値、parse、sort、raw copyを変更しない。UI用の通常状態copyは各consumerが定義し、ユーザー設定として編集・保存しない。
- 対象が明確なtoolbar操作は既存iconを使い、英語の操作名・対象、focus、busy、toggle状態を残す。Save等の主CTA、Approve / Reject、Forget、GC、全削除、最終確認は必要な可視labelと影響説明を保つ。
- 同一対象・同一requestの待機表現を集約する。未取得、pending、利用不可、正常0件、失敗を区別し、Mainと複数Auxiliary、一覧取得とrun、Audit refreshとpaginationの状態を混ぜない。承認・入力待ちは次の操作と要求本文を示す。
- 正常0件、検索0件、情報のないpane/listの本文は空にする。既存shell、必要な見出し、create/restore等の操作、accessible nameは残し、未取得・読込中・取得失敗は正常0件と混同しない。読込中は対象領域のspinnerとaccessible status/busyへ集約し、取得失敗・validation・安全・回復に必要な説明と操作は残す。
- 局所的なmotionを使い、reduced motionでは止まった形状とaccessible statusでも状態を識別できるようにする。spinnerのために処理完了を遅らせず、実際に成功した後だけ完了を示す。通知は意味のある遷移へ絞り、会話本文や全カードを重複して読み上げない。
- 同じ事実を見出し、label、status、helper文で重ねない。正常状態や操作を言い換えただけの常設説明は省略する。未保存・保存中・失敗・回復は残し、新しい編集に古い保存成功を表示しない。`Stop`はrunの停止要求、`Cancel`は現在操作の取消、`Close`はWindow等を閉じる操作、`Quit`はアプリ終了と区別する。

## UI Implementation Boundary

- 画面の実装ファイルは、表示される入口ではなく役割ごとの domain に置く
- `Home` 配下に置くのは Home dashboard と Home から直接見える管理ハブだけとする
- `Settings Window` の画面実装は `settings` domain に置き、Home の実装ファイルへ混ぜない
- Character catalog は `character` / `character-editor` domain を正本にし、Home には一覧と editor window 起動だけを置く
- chat layout の実装は 1 系統だけとし、`chat` domain を正本にする
- Agent は chat layout に乗せ、機能側には state / service / adapter だけを置く
- `chat/conversation/session-message-column.tsx` は会話本文、artifact、検索、仮想スクロールと pending row の配置を担当する。pending row 内の承認・入力要求は `chat/runtime/live-request-surface.tsx` が所有し、フォーム状態、validation、応答 payload、送信中の操作制御を conversation 列へ戻さない
- artifact の展開状態と開閉操作は `chat/conversation/session-chat-conversation-feature.ts` が Window 内の message key ごとに所有する。会話の切り替えで展開状態を失わず、App は状態・setter・開閉 callback を構築しない
- File Explorer と中央 file / Git preview の接続は `file-explorer/use-session-files-feature.tsx` が所有する。タブ、再読込、preview の選択と表示分岐を機能内へ閉じ、Session Window には表示面、開閉状態、composer への挿入接続だけを公開する
- Glossary の検索・選択状態と pane props は `glossary/use-session-glossary.ts`、Audit Log の取得状態と modal props は `chat/runtime/session-audit-log-state.ts` がそれぞれ組み立てる。Window 側で個別フィールドへ展開して再構築しない
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
- 2 カラム構成
  - 左: `RecentSessions`
  - 右: `Memory / Settings` rail + `Monitor` または `Characters`
- 2 カラムの外側とMonitorのRunning／Stopped sectionを装飾cardで囲まず、余白と区切り線で構成する
- `RecentSessions` / `Characters` 見出しは dark background 上で十分読める色を明示する
- `Monitor & Resume` / `Manage Cast` の補助ラベルは置かない
- `Monitor`
  - right pane 上部の segmented toggle で `Characters` と排他的に切り替える
  - 初期表示は `Monitor`
  - 意味のある親Session cardを2行まとまりで表示する。1行目はdisclosure、avatar、親title、2行目は`Main`と、Auxiliaryが存在する場合だけ`Aux`の状態アイコンを表示し、装飾目的の入れ子cardは作らない
  - source は `src-electron/windows/session-window-bridge.ts` が所有する Window map 由来の open session ids と、`RecentSessions` と同じ filtered session list の交差集合を使う
  - section
    - `Running`: `running`
    - `Stopped`: `interrupted` / `error` / `neutral` を含む non-running
  - `Running` と `Stopped` の一覧はそれぞれ独立してスクロールする。両方に項目がある場合は表示領域を等分し、一方が空ならその見出しだけを残してもう一方へ領域を渡す
  - 常設の workspace / provider / command / transcript は表示せず、親titleとAuxiliary previewは既存の省略表示規則を使う
  - 親titleのクリックで親Windowを開き、disclosureでAuxiliary一覧を展開する。展開行のクリックはstable Auxiliary IDを指定して同じ親Window内の対象を選択する
  - running / interrupted / error は形状を含む状態アイコンで判別でき、待機と終了は中空円形で揃えつつ状態ラベルと集約単位を分ける
  - Auxiliary一覧の取得状態はMonitor領域のstatus feedbackで示す。未取得の親cardに架空のAuxiliary集約を作らず、既に取得したsummaryがある場合は既知のrun状態を保持して取得errorと区別する
  - open な SessionWindow がないときは、正常なempty本文を出さず、Monitorのshellと必要なstatus/accessibilityだけを保つ
  - `MonitorWindow` button から独立した monitor window を開ける
- `RecentSessions`
  - section action として＋iconの`New Session`を置く。保存済みWindowの復元操作は`Restore Sessions`とする
  - resume picker
  - session search input（placeholderは表示しない。accessible nameは残す）
    - `taskTitle / workspace / kind label`
    - 部分一致
  - 検索欄と`New Session`は固定し、上下に余白を持たせたsession listだけをスクロールする
  - session list は全 session を正本として表示し、storage 既定の `last_active_at DESC` を崩さない。検索0件でも本文を埋める説明文は出さない
  - `sessionKind === "character-authoring"` の Character authoring session は通常 session と同じ削除・再開導線へ到達できるよう表示する
  - session card の常時表示情報
    - `avatar / taskTitle / runState badge / workspacePath / updatedAt`
    - `taskSummary` は 1 行補助情報として、空なら省略可
  - Home の state precedence
    - `status === "running"` または `runState === "running"` を最優先
    - 次に `runState === "interrupted"`
    - 次に `runState === "error"`
    - それ以外は neutral な non-active
    - 未知 state でも card は欠落させない
  - card theme
    - background = mate `main`
    - left accent bar = mate `sub`
    - text color = themeのcontrast helperで決めたdark / light palette
- `Characters`
  - right pane 上部の segmented toggle で `Monitor` と排他的に切り替える
  - Character catalog の active Character は意味のある card item として表示する。必要な識別情報と操作をまとめるが、入れ子の装飾cardは作らない
  - 検索欄とheaderの＋icon `Create Character`は固定し、Character listだけをスクロールする
  - card には avatar / name / description（空なら Character ID）を表示する
  - card click で `Character Editor Window` を開く
  - Character 0 件または検索0件時は本文を空にし、headerの`Create Character`と検索inputのaccessible nameを残す
  - Home には archive / delete を置かない
  - card theme
    - background = Character `main`
    - left accent bar = Character `sub`
    - text color = WCAG AA の contrast ratio を満たす dark / light 候補から自動決定
- `New Session` dialog
  - session title 入力
  - Agent Mode の workspace は既存 directory を選ぶ `Browse` と、WithMate 管理下の directory を開始時に作る `Session Folder` から選ぶ
  - enabled provider の選択
  - Home の `New Session`、Character authoring、Auxiliary の provider picker は同じ状態境界を使う。取得中は picker 内の spinner と busy / accessible statusだけを表示して開始buttonをdisabledにし、取得失敗はprovider errorだけをalertで示して開始不可にする。取得成功後の0件だけ作成不可の説明を表示し、loading / error / ready 0 件を混同しない。開始処理中は各確定button内のspinnerとbusyだけを示し、busyをalertへ変換しない
  - Home `New Session`、Character authoring、Auxiliary の launch-section は意味上のgroupとして維持するが、装飾用のnested cardを描画しない
  - Character selector は開くたびにランダムを初期選択する。明示選択したactive Characterはそのまま使い、Characterが0件の場合はneutral fallbackを使う。詳細はADR 004を参照する
  - HomeのCharacter一覧は初回とWindow再フォーカス時に再取得する。再取得に失敗した場合は保持済みの一覧を起動候補として使わず、Character selectorに取得失敗を示してSession作成を無効にする。取得成功後の0件だけneutral fallbackを使う
  - model / depth / approval / sandbox / Reviewer / Speed / custom agent は dialog には出さず、Main Process が作成直前に選択中 provider の直近 Session 一件から解決する。詳細は ADR 007 を参照する
  - open 時は dialog 内の最初の主要入力へ focus する。Home の `New Session` は入力途中の意図しないdismissを避けるため、footerの`Cancel`で閉じ、backdrop clickや`Escape`では閉じない
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
  - `Model Catalog` import / export
  - `Repository Glossary` の自動追加上限
  - `Storage Maintenance` の古いSession削除
  - 縦が小さいときも overlay 内スクロールで末尾まで操作できる

## Character Editor Window

- Home の `Characters` panel から create / edit mode で開く
- 1 Character に集中して編集する独立 window とする
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
- Character 定義自動生成、LLM 添削、section editor、revision / rollback、Character Update Workspace は current UI に含めない

## Session Monitor Window

- `Home` とは別の独立 window として開く
- 既定サイズは細く縦長の compact window とする
- `always on top` を初期 slice から有効にする
- renderer は `HomeApp` の compact monitor mode を再利用する
  - 表示内容は Home 右ペインの `Monitor` と同じ truth source を使う
  - open な `Session Window` のみ表示する
  - `Running` / `Stopped` の 2 section を持つ
  - 表示単位は意味のある親Session cardの2行まとまりとし、親cardを2行で固定する。1行目はdisclosure、avatar、親title、2行目は`Main`と`Aux`の状態アイコンを表示する。装飾目的の入れ子cardは作らない
  - workspace、provider、command、transcriptなどの常設情報は表示しない。titleとAuxiliary previewは既存の省略表示規則を使う
  - `running` はaccent色のspinner、待機と終了はsubduedな中空円、errorはwarning triangleで表し、cardの点滅や状態別の面色変更は行わない。reduced motionではspinnerを停止する
  - Auxiliaryが存在する親だけdisclosureと`Aux`集約を表示し、Auxiliaryがない場合もMainだけの2行を維持する。展開時は親card内へ、実行中を先頭グループとし各グループを`updatedAt DESC, id DESC`で並べたAuxiliary rowを追加し、各rowのicon、preview、省略状態を表示する。Auxiliary rowの表示領域は約5行分に制限するが、6件目以降も一覧領域内をスクロールして全件へ到達できる
  - Auxiliaryの状態集約では`Running`、`Error`、`Idle`、`Closed`を別々に数え、closed Auxiliaryをidleへ変換しない。idleとclosedは同じ円形だが、状態ラベルと集約を分ける。interruptedとerrorも別の形状で表示する
  - section countは親card group数とし、Auxiliaryをtop-level rowとして重複表示しない。親の状態はMainとAuxiliaryを分離して保持し、Auxiliaryのいずれかが実行中なら親card groupを`Running`へ分類する
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
- `Audit log` overlay
  - approval 表示は `Auto Run / Provider Controlled / Safety Focused` の provider-neutral wording を使う
- `Work Chat`
- 空 session では初期 assistant メッセージを置かない
- assistant / user message の markdown-like rich text 表示
- wide desktop (`1920x1080` baseline) では Session 本体を、中央の `message list または preview` と上下左右の dock に分ける
  - HeaderとActionDockは常に全幅を使い、外側をカードの枠・背景で囲まない。左右paneはその間で中央surfaceと並び、splitter操作やdockの開閉で配置を変更しない
  - HeaderとActionDockはclickで開閉する。左右paneは排他表示とし、clickで開閉する。閉じた領域からのdrag展開は行わない。開いた領域のdragと矢印キーによる調整は、領域側が定義する最小サイズと中央領域に必要なサイズを守る。ActionDockはHeaderとsplitter以外の残余高を使い、中央領域が160px未満になる場合は中央を高さ0で非表示にし、160px以上に戻ると会話stateとスクロール位置を保って再表示する
  - ActionDock の高さと左右 pane の幅は Window local state とし、別 Window や再起動へ引き継がない
  - Header、ActionDock、side pane の表示 preference は app 共通設定へ保存し、新しく開く Window の初期値にだけ使う。既存 Window は別 Window の変更へ追従しない
  - title 編集などの強制表示は保存済み preference を変更しない
  - wide layout では中央 surface の最小高さを160pxとし、中央が160px未満になるサイズでは中央を高さ0で非表示にする。ActionDockの高さはHeaderとsplitter以外の残余高まで使用できる。narrow layoutではactive side paneとwork surfaceの縦stackを維持する
  - work surface: `message list または file / live Git Diff preview`
  - context pane: `Latest Command`
  - 左右splitterはclickで開閉し、開いた領域をdragと矢印キーでサイズ調整する。幅0でもclick用の操作領域を残す
  - 中央が高さ0の間はHeaderとActionDockのsplitterだけを表示し、それ以外のsplitterは操作不可とする
  - ActionDockの展開時最小高さは296pxとし、実行設定は常時表示する。展開時もtextarea自体は最低100pxを保ち、feedbackの高さは別に確保する。候補一覧は既存の高さ上限内で表示し、縮めて消さない。高さが不足する場合は内部スクロールで設定と送信操作へ到達できるようにする
  - 最小サイズは各領域のCSS custom propertyで所有し、レイアウト側が読み取る。File Explorerの最小幅は260px、Context paneは360px、縦stack時は各200px、中央の最小高さは160pxとする。Main／Auxiliaryは各360pxで、両側表示中に中央の実幅が両者とsplitterの合計未満なら送信対象側だけを表示する。中央splitterは1本とし、端へ寄せて片側の要求幅が最小幅の半分未満になるとその側を閉じ、反対側を全幅表示する。閉じた側はclickで両側表示へ戻す。表示比率と送信対象は独立して保持する
  - pane を隠した時も splitter は再表示 affordance として残す
  - side pane の表示状態は `files | context | none` の値として app 共通設定へ保存し、初期値は `none` とする。新しく開く Window は利用可能な永続値を初期値として使う
  - 開いている Window の表示状態は renderer local state とし、別 Window での切り替えには追従させない
  - viewport が `1400px` 未満では表示中の左右paneとwork surfaceを縦stackにし、左右splitterは縦方向のdragと上下矢印キーで高さを調整する。`1400px` 以上では横方向のdragと左右矢印キーで幅を調整する。サイズはWindow内で保持し、領域の最小サイズと利用可能領域に合わせて補正する
  - Session Windowの最小サイズは1100x720 DIPとし、current minimumはsplit-screenを考慮して到達性を維持する
  - Full HD では文字サイズそのものより density を先に調整し、Session 専用の gap / padding / chip / button 高さをやや詰める
  - user bubble は assistant avatar 分の左 gutter を持たず、row 幅いっぱいを使えるようにする
- `Top Bar`
  - default は hidden とする
  - 上 splitter を押すと Header の表示と `Rename / Audit Log / Terminal / Delete` を切り替える
  - Header は1行分の固定高とし、splitter の drag による高さ変更は行わない
  - `More` と `Close` は使わない
  - title 編集中は effective state として表示を維持する
- `Action Dock`
  - compact / expanded の 2 状態を持つ
  - 常に全幅の下dockとして置く
  - compact では末尾移動とmessage表示切替を必要に応じて操作列に残す。draft入力と`Send`はexpandedで表示し、実行中indicatorはmessage listに置く
  - compact / expanded の上段操作列には `Main / Auxiliary` の直前に `Cancel` 用の固定幅領域を常時予約し、非実行中は不可視にする。通常幅では86pxを使い、viewportが760px以下では操作列幅へ追従する。expanded の下段には disabled の `Send` を残し、開閉や Main / Auxiliary 切替で `Cancel` の位置を変えない
  - 開閉は下 splitter を主導線とし、compact の非実行中のmeta領域からも展開できる。dock 内に `Hide` は置かない
  - expanded 時は上部操作列と下部設定・送信列の高さを固定し、drag では中央の textarea 領域だけを伸縮させる
  - default では通常送信の直後に compact へ戻す
  - この auto close は Settings の checkbox で ON / OFF を切り替えられ、初期値は ON とする
  - skill picker、`@path` 候補、blocked feedback がある時は expanded を維持する。skill pickerの候補panelは中央work surfaceのほぼ全体へ一時表示し、composerはtriggerとprompt挿入先を担う。recovery action surface は dock の状態へ影響しない
- Agent の `File Explorer`
  - `Workspace`、`Session Folder`、`Add Directory` で許可した directory を root として表示する
  - dotfile や ignore 対象を除外せず、展開した directory の直下だけを Main process から取得する
  - 未作成の `Session Folder` は root の初回展開時に空ディレクトリとして作成する
  - tree row は仮想化し、file 本文は選択時に 1 件だけ chunk read する
  - `Files | Changes | History` を切り替え、Changes は各 Git root の Working Tree / Staged を 1 file 単位で中央 live Git Diff へ開く。History は同じ File Explorer shellでcommit履歴とcommit時点のfileをread-only表示し、History内のCompareでlocal branch / remote-tracking branch / tag / HEAD / commitをDirect comparisonまたはBranch changesとして比較する。非 Git root は表示しない。包含関係にある root は独立した scope とし、同じ file も各 root からの相対 path で表示する
  - Historyのbranch selectorは現在選択中のbranchを`Current`で示し、branch名自体はraw valueのまま表示する
  - History Compareは4つ目のtabや独自のdiff surfaceを増やさず、Historyのfile tree、filter、Open All Changesを再利用する。比較時に解決したcommit object IDを保持し、branchの移動でpatchを暗黙に差し替えない。patchはcentral surfaceまたはdetached File Preview Windowで開け、before / after previewはcentral diffのactionからcommit-scoped File Preview Windowで開ける
  - Changes は user configuration から外部 command を実行しない。root の認可と表示 scope は ADR 015、Git executable、directory identity、config / index の隔離境界は ADR 014 を正本とする。有効な clean / process filter が必要な repository では、他の操作 feedback がある場合も理由を表示して利用不可にする
  - Git rootがない、または変更が0件という正常状態はblankで表現する。Git repositoryのdiscovery・availability・rejectと、Changes / Historyの取得・diff操作の失敗は理由を持つ実エラーとして扱い、正常blankへ潰さない。File Explorerのroot読込失敗は`role="alert"`で示し、読込中はspinner/statusと区別する
- 中央 file preview
  - message list だけを置き換え、Action Dock は表示したまま入力、添付、送信を受け付ける
  - Text、Markdown、raster image、SVG、unsupported binary metadata を表示する。Text と source は行番号、soft wrap、文字コード切替を持つ
  - Markdown は shared rich text renderer の Preview を既定とし、Source へ切り替えられる
  - image は 100% を既定とし、Zoom と Fit を受け付ける。単体Image / SVG previewはtoolbarと画像上のcontext menuから、表示中の画像をbitmapとしてclipboardへcopyできる。Markdown内画像とchat画像は対象外とする
  - File Explorerのroot、directory、regular file rowはnative context menuに`Copy path`と`Insert path`を表示する。pathはMain processが現在のSession rootから再解決し、copyはlexical absolute pathをclipboardへ書く。insertはworkspace内をworkspace相対、workspace外をslash正規化したabsolute pathとして、既存の`@path`挿入処理へ渡す。menu表示後にactive ownerまたはcomposerの書き込み可否が変わった場合は挿入しない。symbolic linkとother rowは対象外とする
  - Windowsでは、File Explorerのregular file rowでpath操作の後ろをseparatorで区切り、file preview header、root-scopedなMarkdown local-file linkと同じく、既存regular file一件をExplorer互換のfile objectとしてclipboardへcopyできる。directoryとroot外Markdown linkは対象外とし、Copy Imageやpath文字列のcopyとは別操作にする
  - File PreviewのCopy File / Copy Image結果は、共有`AppNotification` primitiveを使ったheader内のoverlayとして表示する。通知は操作列のflex配置に参加せず、操作列の直下・右寄せに重なるため、既存の操作ボタンを移動・折り返しさせない
  - Copy成功はsuccess toneと`role="status"` / `aria-live="polite"`、Copy失敗はerror toneと`role="alert"` / `aria-live="assertive"`で表示する。下端の`session-file-preview-feedback`はpreview自体のエラー専用で、Copy成功通知には使わない。`AppNotification`の現在のconsumerはFile Previewだけとし、他画面への適用は各UIの意味と配置を確認してから行う
  - Ctrl+F は active な chat / Text / Markdown / live Git Diff を検索する。Preview 中の chat component は状態保持のため mount したまま非表示にするが、shortcut と検索対象からは外す。Text、Markdown、live Git Diff の選択範囲には chat と同じ floating Copy / Quote を表示し、Quote は現在の writable composer へ挿入する。Preview 表示中の Ctrl+A は、Find input または Action Dock の入力中を除き、Window 全体ではなく表示中の document または diff の文字列だけを選択する
  - file、live Git Diff、Template workspace から chat へ戻る操作は、左向き icon-only control と具体的な accessible name を持つ同じ navigation primitive を使う。run、approval、elicitation の状態は preview 中も確認できる
  - Template workspaceのSave / Deleteは可視labelと局所spinner、busy stateを使う。処理中は入力を固定し、成功・失敗後に操作を戻す。本文・template IDを表示文言の変更で書き換えない
  - Skill 候補のような一時 surface は右上の × と具体的な accessible name を使い、`Escape` でも dismiss できる。view 間 navigation の Back とは表現を分ける
- detached file preview
  - File Explorer は通常 click で中央 preview、Ctrl+click / Cmd+click で detached preview を開く。Changes は通常 click で中央 live Git Diff（untracked は中央 file preview）、Ctrl+click / Cmd+click で detached live Git Diff（untracked は detached file preview）を開く。Session message の local-file link は detached preview を開く
  - 中央 preview と同じ `SessionFilePreview` / `SessionDiffPreview` を使用し、Quote と Action Dock は表示しない
  - live Git Diff の `Open preview` は対象 file を通常 preview として開く。detached file preview から開いた live Git Diff と Changes から直接開いた detached live Git Diff は、左向き icon または `Open preview` で同じ Window の preview へ戻る。独立 File Preview、snapshot Diff、Character Editor の Window 自体は native window chrome で閉じ、重複する app 内 Close 操作を置かない
  - Character Editor が dirty な状態で native window chrome から閉じようとした場合は、編集内容を保持したまま in-app の破棄確認を表示する。キャンセルでは編集へ戻り、明示的に破棄した場合だけ Window を閉じる
  - `New Session` dialog はfooter左端の`Cancel`で作成せず閉じ、右端の`Start`で開始する。`Start`がdisabledでも`Cancel`は使用でき、重複する常設 Close control は置かない
  - Auxiliary 起動 dialog と Audit Log overlay も backdrop click と `Escape` で dismiss できるため、重複する常設 Close control を置かない
  - 破棄確認は単一の dialog surface に確認対象と操作を直接配置し、見出しと重複する補足文や装飾目的の card を置かない。破壊的操作は neutral なキャンセルと色・文言の両方で区別する
  - 同じ root-scoped resource は既存 Window を前面化し、異なる resource は複数 Window を開ける。navigation、認可、lifecycle の決定は ADR 020 を正本とする
- live Git Diff と chat artifact Diff は別機能とする。artifact の永続化・Diff modelは維持するが、Details UIには `Changed files` と `Open diff` を表示しない。File Explorer の Changes や中央 live Git Diff へ接続する判断は別consumerの契約で扱う
- 中央 live Git Diff は Split を既定表示とし、Inline へ切り替えられる。両表示は同じ unified patch と検索modelを投影し、Split でも表示rowをvirtualizeする
- work surface は外側 card を持たず、padding / gap を抑えて message viewport を優先する
- message list は条件付き follow mode で動かす
  - user の scroll intent と末尾移動は一つの follow owner が決定し、virtual row の再計測は visible anchor の補正だけを担当する
  - 上方向への wheel intent を scroll event より先に追従停止へ反映し、遅延描画や行高再計測による `scrollTop` 変化を追従再開として扱わない
  - 追従停止後は、user が末尾方向へ戻すか実際の末尾へ到達するまで位置を維持する
  - `selectedSession.id` 切替時は follow / unread state をリセットする
  - `Jump to latest` で末尾へ移動して追従へ復帰できる
- pending 中の live activity / streaming response
- streamingの`assistantText`は会話本文として表示する。run開始直後からmessage list末尾にCharacter avatarとdot bubbleを置き、本文の到着後もrun中は維持する。同じrunの既定待機文を会話本文へ重ねない
- pending bubble には provider-native pending item を差し込める
  - `approvalRequest`: `Allow Once / Reject`
  - `elicitationRequest`: form の `Submit` または URL completion の `Complete` と、`Reject / Close`
  - Approval / Elicitation の解決中は既存 pending item 内の spinner と `aria-busy` で待機を示し、同じ対象の状態文を重複表示しない
- `live run step` は pending bubble に混在させず、right pane の `Latest Command` へ要約して分離する
- right pane は `Latest Command` を基本 tab とし、provider が `Copilot` の時だけ `Tasks` tab を追加する
- right pane 上部には collapsed state の `title handle` を置く
- right pane shell は Agent で共有する。表示する内容がない mode では pane 構造だけを残し、説明文や空メッセージを常設しない
- right pane の本文scrollbarはtab直下からpane下端まで共通の高さにし、`Messages`のfilterと`Glossary`の検索欄は本文の上端へ固定して一覧だけを流す
- `Generate Memory` は current UI では表示しない
- command 実行中は `Latest Command` を最優先で自動表示する
- MemoryGeneration / 独り言の right pane 自動切り替えは行わない
- right pane の正常empty / idle bodyはblankにし、pane shell・tab・必要な操作・accessible statusだけを残す。実エラー、validation、安全・復旧説明は維持する
- `Latest Command` には raw command、status、source、rough risk badge、必要時だけ開く `details` を出す
- 実行中に確定した live step があれば、`Latest Command` の下に `Confirmed Details` として直近数件だけ補助表示してよい
  - 直近の in-progress command とは分ける
  - full timeline には戻さず、summary + optional `details` に留める
- provider が `Copilot` で background task snapshot が来た時は、right pane の `Tasks` tab で `agent / shell` の running / completed / failed を確認できるようにする
- `Tasks` tab は `/tasks` 全機能の再現ではなく、current session に紐づく background task の coarse な観測面に留める
- `Memory生成` tab は current UI では表示しない
- provider が `Copilot` の時だけ、`Latest Command` の下に `Copilot Usage` の薄い strip を常設し、残量だけを即読できるようにする
- `Context` は同じ領域の collapsed details として置き、ユーザーが開くまでは右 pane の面積をほとんど使わない
- `assistantText` は会話本文としてのみ扱い、`agent_message` を activity row へ戻さない
- message list末尾のdot bubbleは `runState === "running"` を示すフラグとして扱い、`assistantText` の出力開始後もrun中は維持する
- 未選択のMain / Auxiliaryが実行中の場合は、そのtarget切替buttonに局所spinnerと対象付きaccessible nameを示す。選択中targetではmessage listの末尾行へ集約し、他のAuxiliaryは一覧の既存processing indicatorで識別する
- 実行中bubbleは `runState !== "running"` になった時点で消し、success固定の完了表現にはしない
- `assistantText`未着でもright paneの `Latest Command` があればraw commandを表示し、command未到着の正常局面では本文copyを表示せず、末尾のdot bubbleとaccessible statusで待機を示す
- screen readerには会話本文全体でなく末尾行の状態変化を通知する。Action Dockから重複して通知しない
- retry draft conflictとcomposer feedbackはvisible textを正本にして常時live通知しない
- `command_execution` は通常 paragraph ではなく shell command と即判別できる専用の monospace block で表示する
- `details` は stdout / stderr など二次情報だけを折りたたみ表示する
- `liveRun.errorMessage` は `Latest Command` のalert blockとして扱い、`Run Error` 見出しを `var(--ink)` の前景色で表示する
- right pane 自体の描画失敗は pane 専用 fallback に切り替え、`Retry Right Pane` と `Reload Window` を出す
- right pane は run 中の command 安全確認面として扱い、full timeline や `Turn Inspector` は常設しない
- 実行中は上段に `Cancel` を表示し、下段には disabled の `Send` を残す
- assistant message ごとの `Turn Summary`
  - 展開導線は chat row の独立 1 行 button ではなく、assistant bubble 右上の小さい icon button とする
  - `Changed files` は Details UIには表示しない。artifactの永続化、audit、Diff model、Changes paneのデータはこの表示変更だけでは削除しない
  - `Run checks`
    - approval は `Auto Run / Provider Controlled / Safety Focused` の provider-neutral wording で表示する
  - turn 内の operation timeline は arrival 順を保ち、全 operation を1つの `Operations` groupにまとめる。groupはdefault closedとし、summaryでは件数を示し、展開時は元のoperation単位・元順序で表示する
  - `Operations` groupの展開内容は高さを制約し、長い内容はgroup内部でscrollできるようにする。Details本体、Operations group、各operationはkeyboardで開閉でき、native detailsのaccessible name / focus / expanded stateを維持する
- composer 上の添付 toolbar
  - `Attach` button から単一の attachment popover を開く
  - popover の `Attach` section は元 path を参照する `File / Folder / Image` を1行にまとめる
  - popover の `Session Files` section は session local files を扱う `Copy / File / Folder / Image` を1行にまとめる
  - `Skill` は別カテゴリの単独 button として区別する
- 添付 toolbar は Agent の作業 chat 用であり、メイトークでは表示しない
- composer と textarea の間に独立した attachment tray / chip list は置かない。添付はpopover、paste、textareaへの `@path` 挿入から送信時の解決へ渡す既存経路を維持する
- textarea 内の `@path` 参照
- `@path` 入力中の workspace file path 候補表示は持たない
- 手入力または paste された `@path` は送信時に検証し、存在しない path は composer feedback として表示して送信しない
- picker で選んだ file / folder / image も textarea に `@path` を挿入する
- 添付 picker は初回だけ workspace を開き、以後は最後に選んだディレクトリを開く
- composer toolbar に `Add Directory` を置き、その横の toggle から `Additional Directories` 一覧を既定 closed で開閉できるようにする
  - composer 下の runtime settings は shared chat composer を正本とし、`Approval / Sandbox / Model / Depth`を表示する。Codex providerでは`Approval`の直後にcompactな`Reviewer`選択、そのほかのruntime optionと同じ列に`Speed`選択を追加する。`Reviewer`は`User` / `Auto Review`、`Speed`は`Standard` / `Fast`をSession単位で保持する。Codex以外では両方を表示しない。`Reviewer`はrunning、read-only、またはApprovalが`never`の間は現在値を保持したまま変更できず、その他のruntime optionは既存の制約に従う
  - approval chip は `Auto Run / Provider Controlled / Safety Focused`
  - approval chip は single-select control として矢印キーで切り替えられる
- session title は mate `main`
- assistant本文は装飾cardやgradientで囲まず、`main`の細い左線とavatarの縁でCharacterを示す。user本文は控えめなsurfaceで区別し、pendingとAuxiliary groupの状態表現は維持する
- composer settings は独立したaccent背景を持たず、周囲のsurfaceと同じ背景を使う
- `Send / Cancel` は mate `main`
- sendability 判定は共通resolverへ寄せ、Composer内の購読と送信shortcutで最新draft・preview・強制feedback条件を使う。入力のたびにSession shellを更新せず、`sessionExecutionBlockedReason` / `composerPreview.errors` を Send 近傍の単一 feedback area で扱う
- Send disabled 条件は submit button / `Ctrl+Enter` / `Cmd+Enter` guard で一致させ、blank / whitespace-only draft の no-op 送信を通さない
- blank / whitespace-only draft は通常時は helper 文言を常時出さないが、blocked 送信ショートカットを押した時だけ inline reason を見せる
- send button の `title` には current blocked reason を載せ、hover でも送信不可理由を確認できるようにする
- `runState === "running"` では `Cancel` 主体の既存 UX を維持し、送信不可説明を主表示しない
- `Details` 展開後の artifact block 背景は `main / sub` の薄い accent を持つ
- `Ctrl+Enter` / `Cmd+Enter` 送信
- terminal state 後の再送導線
  - `runState === "running"` 中は recovery action surface を出さず、既存 pending / `Cancel` を維持する
  - `runState === "interrupted"` + `lastUserMessage` ありで interruption copy、`runState === "error"` + `lastUserMessage` ありで failed copy を出す
  - `runState === "idle"` でも最新 terminal Audit Log `phase === "canceled"` + `lastUserMessage` ありなら canceled copy を出す
  - `lastUserMessage` がない session では retry 不能のため surface を出さない
  - canonical owner は共通 chat layout の message stack とし、中央 chat / file preview の直下、Action Dock の直上へ置く。詳細は [ADR 019](../adr/019-chat-recovery-action-surface.md) を参照する
  - 状態 badge、title、CTA、必要時の draft conflict notice だけを表示し、`停止地点`、`前回の依頼`、`Details`、`Hide` は置かない
  - Action Dock の expanded / compact state は変更せず、file preview 中も同じ位置へ表示する
  - 狭い Window では title と CTA を縦に折り返し、中央 preview や dock を横へ押し出さない
  - retry CTA は `Resend` と `Edit`
    - `Resend`: 既存 resend 経路で即時再送し、draft は書き換えない
    - `Edit`: `lastUserMessage.text` を draft へ戻して textarea へ focus し、自動送信しない
  - draft が非空のまま `Edit` を押したときは silent overwrite をせず、composer 内で `Your current draft is preserved.` と短く示したうえで明示的な置換導線を出す
- inline `Diff Viewer` overlay
- `Open In Window` による `Diff Window` popout
- `Audit log` overlay と inline `Diff Viewer` overlay は open 時に dialog 内へ focus を移し、`Escape` で閉じ、`Tab` / `Shift+Tab` を dialog 内で循環させる

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
- Home の `Monitor` は Main Process の `sessionWindows` を thin IPC bridge で参照し、開いている `Session Window` の session だけを表示する
- Home の `Monitor` と `Session Monitor Window` は同じ projection / component を使い、open parentに紐づく保存済みAuxiliary summaryを同じ順序で集約する。状態更新は既存のlive eventと軽量summary再読込で反映し、pollingやMonitor専用storageは持たない
- Auxiliary summary再読込はopen parent集合を一括取得し、親数に比例した個別SQLite取得を行わない
- MonitorからAuxiliaryを選択して開いたときは、Mainがstable Auxiliary IDとparent IDを検証してnavigationし、既存Windowにはselection event、新規Windowにはentry queryで正確な会話を渡す
- Session 実行の監査ログは SQLite に保存し、Session Window から閲覧する
- chat message は限定的な rich text renderer で整形表示する
- `Settings Window` は app 共通 system prompt や Character 本文を編集しない。Character 定義は `Character Editor Window` と session snapshot を正本にする
- `userData` は `<appData>/WithMate/` に固定する
- Session は mate の `main / sub` theme color snapshot を保持し、現在は header title、assistant / pending bubble、`Send / Cancel`、artifact block、Session から開く Diff の `titlebar / subbar / pane header` の限定的な accent に使う
- theme 由来の前景色決定は輝度閾値ではなく共通 contrast helper を正本にし、Home / Character Editor / Session / Diff で同じ WCAG AA 基準を使う
- session は SQLite を正本とする
- model catalog は DB の active revision を読む
- message list follow mode は assistantText streaming / pending bubble 更新に反応し、command 監視は right pane の `Latest Command` へ分離する
