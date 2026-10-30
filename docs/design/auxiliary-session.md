# Auxiliary Session


## Goal

AuxiliaryはMainと同じWindowで利用する独立した会話である。Main 1件とAuxiliary複数件を保持し、画面にはMainと選択中のAuxiliaryを表示する。Session Graphを開いている間は、送信対象の会話だけをGraphの隣に表示する（[Session Graph](session-graph.md#閲覧ui)）。非表示のAuxiliaryも会話、draft、Character、実行状態を保持し、後から同じ会話を継続できる。

Auxiliaryは監査専用ではなく、通常のprovider chat/coding sessionとして扱う。Main・兄弟Auxiliaryとのtranscript、provider context、Memoryを自動同期しない。

## Scope

- Auxiliary切り替えUIからの新規Auxiliary追加（既存会話を終了、置換、削除しない）。
- 最終使用順の一覧、stable Session IDによる選択、左右矢印による前後移動。
- Main左／選択Auxiliary右の共通chat shellと共有ActionDock。
- Auxiliaryごとの会話、draft、runtime option、Character ID／snapshot、provider threadの保存。
- 非AIの一覧preview。直近turnで確定した最終assistant応答ブロックの冒頭を機械的に平文化する。

## Out Of Scope

- Auxiliary専用Window、横並びの多数tab、常設AUX rail。
- 監査preset、固定reviewer role、handoff、自動結果転送、shared source競合管理。
- AI要約、自動命名、preview用provider実行、AI backfill。
- Auxiliary単独の削除／archive UI、手動Character picker、会話途中のCharacter owner変更。

## Runtime Model

```text
Main ────────────────┐
Auxiliary A/B/C ...  ├─ 同時実行可能。表示するAuxiliaryは1件
Shared ActionDock ──┘
```

「選択中」「継続利用可能」「実行中」は別状態である。新規追加、切り替え、turn完了で他会話をclosedにしない。Main送信中でもAuxiliaryを追加でき、非表示Auxiliaryのrunも継続する。

作成要求は `preparing`、`queued`、`committing`、`committed`、`cancelled`、`failed`、`unknown`、`expired`、`not-found` の状態を持つ。準備中・待機中の取消は保存を開始せず、commit 開始後に取消が先に確定した場合も commit を成功扱いにしない。commit 応答が結果不明になった場合は自動再送せず、保存行の再照会で確定できたときだけ `committed` として扱う。親の削除・再作成、storage generation の交換、window owner の解放は保留中の要求を失効させる。

保存 dispatch 前の最終検証失敗は `failed` として終端し、結果不明と混同しない。保存済みの要求への遅延取消は `committed` を返し、保存結果を取消済みで隠さない。保存結果の詳細取得・画面への適用が完了するまでは新しい開始操作を無効にする。

取消済みの作成レコードは、作成処理が終了した時点（未作成要求は取消確定時点）で回収する。回収前に当該親の受付世代を更新し、同じ旧世代でまだ受け付けていない遅延要求を `expired` として拒否する。回収後の取消要求の再照会も `expired` となる。登録済みの別要求は継続し、`unknown` の保存結果照会は維持する。新しい作成操作は新しい context を取得する。

既存の`closed`行は保存された会話として一覧・継続対象に含める。継続時は同じID、thread、messages、draft、Character identityを使い、勝手に新規turnを開始しない。親削除時は親配下の全Auxiliaryをruntime停止・保存削除の対象にする。

## Character identity

新規AuxiliaryはMain Processでactive Character候補からMainのstable Character IDを除外し、同じ親Sessionに保存されたAuxiliaryが未使用のCharacterを優先して既存のweighted random方式で選択する。使用状況は表示名ではなくstable Character IDで判定し、非表示・非実行中・`closed`の会話も含める。別の親Sessionでの使用状況は除外条件にしない。

未使用候補が0件の場合は、Main以外のactive候補全体からweighted randomで選択し、既存Auxiliaryとの重複を許可して作成を継続する。件数上限は設けない。Main除外後の候補自体が0件、snapshot生成失敗、catalog競合の場合は作成を失敗させ、Main／neutralへfallbackしない。

commitの排他境界内で同じ親の使用状況を再確認する。準備したCharacterが既存Auxiliaryで使用済みになり、未使用候補が残る場合は保存せず、coordinatorの外でCharacter選択とsnapshot準備をやり直す。再度commitするときも取消、storage、親identity、runtime selection、Characterのactive状態を検証する。既存Auxiliaryのidentity、snapshot、会話は変更しない。

作成時に`characterId`と初期`CharacterRuntimeSnapshot`を保存し、provider prompt、表示、一覧icon、Memory owner、binding解決で同じidentityを使う。送信開始時は[Character Storage](character-storage.md#runtime-snapshot)に従い、active Characterの変更された有効な定義部分だけを更新する。表示metadataとownerは維持し、archived Characterではcanonical fileを読まず保存済みsnapshotを使う。archivedでのsnapshot欠落、catalog欠落、active定義の読取り・validation失敗では明示的に送信を失敗させ、親や同名Characterへfallbackしない。既存snapshot、会話履歴、provider threadは保持する。汎用updateからownerやsnapshotを差し替えない。

## UI flow

通常Sessionの新規作成時は初期Auxiliaryを1件作成する。既存SessionにAuxiliaryがない場合も共通chat shellのAuxiliary領域だけを空で表示し、特別な状態文言は表示しない。追加のAuxiliaryはAuxiliary切り替えUIのタイトル枠内にある`＋`から行う。Auxiliaryが0件の場合もタイトル枠と追加ボタンを表示する。対象会話の`Collapse`はSession Header actionとしてメッセージがない場合もdisabledで表示する。ActionDockの対象切り替えは`Preview / Source`の直前に並べる。作成中でも既存Auxiliaryの会話、draft、実行状態を変更しない。同じclientRequestIdの再送は同じ保存行を返し、明示的に別IDを発行した追加は別会話になる。

Auxiliary起動dialogのprovider pickerはHome `New Session`とCharacter authoringと同じ表示枠・loading / error / readyの状態境界を使う。provider取得中はpicker内のspinnerとbusy / accessible statusを示し、取得済み候補があれば配置を保持する。取得完了まで選択・開始はdisabledにし、取得失敗はprovider errorをalertで示す。取得成功後にproviderが0件の場合だけ`No enabled coding providers.`を表示して開始不可にする。

作成開始後はprovider選択と重複開始を無効にし、開始button内のspinnerとbusyへ待機表示を集約する。結果不明では作成失敗と断定せず、同じ要求の結果確認中として通知する。取消可能な状態では`Cancel Creation`を提供し、取消応答待ちは取消button内のspinnerとbusyへ集約する。取消中に作成状態が進んでも取消応答待ちの表示を保ち、開始と再取消を無効にする。作成成功が先に確定した場合は既存の成功処理に従う。通常labelで確保したbutton寸法をbusy中も維持し、通知文と操作は別行に配置する。dialogを閉じる操作と作成の取消は区別する。

Auxiliary中央には、キャラiconと内容previewを持つ前後切替を置く。中央表示名のクリック、Enter、Spaceで一覧を開き、確定選択時だけ切り替える。一覧行はiconと会話内容previewだけを表示し、実行中はicon内にcompactなprocessing indicatorを重ねる。Character名、番号、provider、日時、status badgeを情報列として追加しない。preview検索は保存済みpreview文字列だけを対象にする。

MainとAuxiliaryの最小幅は各UI領域のCSSで360pxと定義する。レイアウトは領域の最小幅を読み、内部splitterを除いた実際の利用可能幅で比率を補正する。両方の最小幅とsplitterを確保できない場合は送信対象側だけを表示する。Auxiliaryの初期幅は0で、クリックで開閉する。幅0ではAuxiliaryのgrid track・表示領域・タイトル枠内のswitcherと追加buttonを表示せず、splitterだけを再展開導線として残す。閉じた状態からのdragや矢印キーによる展開は行わず、開いた領域だけを最小幅以上に調整する。幅と送信対象は独立し、対象はActionDockのMain／Auxiliaryスイッチとそのキーボードショートカットからだけ変更する。Auxiliaryの作成・選択では対象や幅を変更せず、開閉でも対象を変更しない。幅は既存の保存先へ保存し、復元時も0を有効な値として扱う。会話、draft、Character、runは保持する。表示する会話本文がある非対象チャットには可読性を保ちながら非選択だと分かる濃度のoverlayをかけ、本文選択、Copy、リンク、switcher操作を遮らない。空の会話にはoverlayをかけない。

Windowsの通常Session Windowがfocus中でない間にAuxiliaryのturnが完了または失敗した場合は、既存のSession turn通知経路で通知する。通知のclickは親Session Windowを前面化し、対象Auxiliaryを選択する。新規WindowではURLのAuxiliary ID、既存Windowではrenderer navigation eventを使う。いずれの場合もMain／Auxiliaryの送信対象、幅、draft、選択中Window以外の実行状態は変更しない。

### メッセージの投影とWindow内live受信

メッセージの投影、折りたたみ状態、一覧からの移動要求、スクロール位置は各会話Columnが所有する。通常Send・送信shortcut・実行中の予約送信の末尾追従は、送信直後の先行表示をDOMへ反映してから既存の設定に従って対象Columnへ一度だけ通知する。遅い受付ACK・再照会・元要求の再試行では通知せず、後続の読み返しや会話・送信対象切替を維持する。個別の折りたたみ状態はメッセージ一覧にも反映し、一覧選択は同じ会話の対象メッセージへ移動する。ContextPaneの一覧選択callbackも共通画面へ渡し、選択した内容を表示へ反映する。

Window内live受信はrendererの`session-window-live-ingress.ts`が公開APIのcallbackを1本に集約し、ownerごとの初回取得を共有する。表示Column、表示中Contextは同じfull snapshotを参照する。shellはMainと操作対象のcompact controlsだけを保持し、selector結果が変わらない本文deltaでは更新しない。非表示Contextの詳細購読を止め、最後の表示consumerが消えたownerのfull snapshotと、全consumerが消えたownerを解放する。再openは必要なdetailを再取得し、先行event・終端nullを遅い初回取得で巻き戻さない。取消・承認・入力制御は表示lifecycleから独立する。公開APIの認可とcontextIsolationは維持する。

非選択Auxiliaryのlive更新は軽量status取得へ集約し、同じrun状態の本文deltaごとには再取得しない。取得が一時失敗した場合は同じrunの次のlive通知から再取得できる。古い取得の失敗で新しいrunの取得keyを失効させず、一覧のprocessing表示と保持detailの実行状態を復旧する。

### 送信受付の共通反映

Main／Auxiliaryの`Send`は同じdurable queue受付を使う。workspace確認・preview・受付ACKを待たず、対象Columnへ捕捉本文と通常の応答待機枠を先行表示する。実行中の次Turnは現在応答より後の予約本文とする。表示用のWindow内状態は会話ID・incarnation・request IDで所有し、同じrequestのreceiptと保存user seqへ接続する。受付・終端先着でも本文と応答面を落とさず、同文の別要求を本文一致で結合しない。先行表示から保存済み本文や`running` Sessionを生成せず、保存結果とlive ingressから実行状態を反映する。

送信文は先行表示・receipt・保存履歴を同じrequest由来の描画keyで引き継ぐ。次turnのlive応答が先着しても、表示中の各送信に属する未確定応答は対応する保存履歴へ合流するまで順序を保って表示する。本文bridgeは非表示・owner変更で解放し、描画keyの対応は読込済みpageと未確定分だけ保持する。queueの初回取得と背景再取得を区別し、既存結果がある背景再取得では末尾へloading行を出し直さない。対応付け済みの保存user seqの到着はbridgeの回収だけに使う。未対応の先行送信より先に保存userが届いた場合はreceiptを再照会する。

Auxiliaryの状態更新はworkspaceのbinding setterを入口とし、ref、詳細cache、選択中のReact state、一覧summary、詳細取得の更新世代をまとめて更新する。古い詳細取得や状態取得で本文を巻き戻さず、会話切替後も予約と保存本文を保持する。canonical user seqの到着前にreceipt完了が通知された場合は小さい表示bridgeを保持し、確定結果を二重追加しない。

開始・追加入力・終端の本文保存後は、Mainと同じ保存通知経路へ親Session IDを通知する。通知の失敗を確定済み保存の失敗へ変換しない。rendererは保持中のAuxiliary本文を再取得し、live snapshotが非nullのままでも完了履歴を反映する。詳細取得中に次runの状態が確認された場合は、取得した本文と新しい実行状態を合流し、履歴を捨てたり古いidle状態へ戻したりしない。会話identity・取得世代・ローカル変更の照合は維持する。

MainのローカルdraftとAuxiliaryの永続draftはそれぞれのownerが保持する。Auxiliaryの通常送信は保存済みdraftのincarnation／durable revisionを指定し、queue受付とconsumeを同一transactionで保存する。受付ACKは捕捉した編集revisionだけを消し、待機中の後続編集を上書きしない。前回依頼の`Resend`は`submitSource: retry`で同じqueueへ渡し、現在のdraftは本文・durable revisionとも変更しない。受付結果不明時は同じrequest IDの確認・明示再試行を使う。

- 正常な準備・受付待ちはerrorにせず、明示的な拒否・処理エラー・timeoutを対象送信の先行表示へ反映し、draftを保持する。準備中の編集・対象変更・freezeでcaptureが失効した場合は未受付の先行表示だけを取り消す。保存済み会話は生成・巻き戻ししない。受付結果不明では同じrequest IDの照会／明示再試行だけを許可し、timeoutやreceiptの一時的不在から未受付と推定して異なるIDで自動再送しない。
- Providerの実行失敗が保存された場合は、送信済みuser message、途中応答、失敗表示を確定結果として保持する。受付前のdraftを復元しない。実行結果の保持は[Provider Adapter](provider-adapter.md#error-handling)に従う。

## Context boundary

workspace/cwdとsession filesは親Mainと共有する。Additional Directoryも親Mainと配下の全Auxiliaryで同じ一覧を使い、どちらのComposerから追加・削除しても共通一覧へ反映する。別のMain配下とは共有しない。実行中turnの捕捉済み認可は変更せず、次turnから最新一覧を適用する。

provider、model、reasoning、approval、sandbox、custom agentは作成時の初期値を受け継ぎ、作成後のMain／兄弟変更は追従しない。

MainとAuxiliaryはmessages、composer draft、live run、pending approval／elicitation、provider thread、実行結果を分離する。Mainのmessage listへAuxiliary全文を自動挿入せず、必要な引用は既存のCopy／Quote操作でユーザーが明示する。

## Persistence

Rendererは再取得可能な非表示Auxiliaryの詳細を直近使用の8件まで保持する。選択中、実行中、未保存の詳細変更、送信・保存・terminal取得の処理中は退避対象にしない。退避時はworkspaceとbindingの本文参照を解放するが、stable ID、独立draft owner、実行・保存queue、runtime選択は維持する。draft ownerのclosureは会話本文を捕捉しない。再選択時は最新の表示用pageを取得し、保持しているdraft／caretと閲覧位置を復元する。保護対象が増えた場合は8件を超え得る。

表示用の初回・terminal読込みは最新60件と全履歴件数を返し、過去は必要時だけ取得する。検索・Bookmark・artifactの対象はページ内indexではなく保存履歴上のindexを使う。取得・保存境界は[Electron Session Store](electron-session-store.md#読取と通知)を参照する。

再取得可能なartifact detailはDetailsのcollapse、会話列の非表示、表示pageからの離脱で解放する。遅い取得結果は閉じたdetailや後続の取得へ適用しない。再表示時は最新detailを取得し、会話のscroll・Bookmark・fold状態とComposerのdraft／caretは別ownerに保持する。

### Composer の更新・保存境界

Main / Auxiliary の入力は会話種別と stable ID をキーとする共通 Composer controller が所有する。draft、編集 revision、selection、IME、preview、保存状態は対象 Composer だけが購読し、Session shell / transcript / Auxiliary 一覧へ文字入力を通知しない。Paste、Quote、Skill、Template、添付、retry、送信後 clear も同じ操作へ接続する。Main draft は従来どおり Window 内のローカル状態であり、新しい永続化対象にしない。

Auxiliary の永続 draft は会話 metadata と独立した保存単位を唯一の正本とする。専用の小さい読込み・保存 command を既存 storage Worker で実行し、owner / incarnation / durable revision を照合する。保存では transcript や Character snapshot を取得・直列化せず、小さい ack だけを返す。renderer の編集 revision と DB の durable revision は別である。full Session の読込みでは draft を合成するが、通常更新・runtime / terminal 保存・Settings 変更から合成 draft を書き戻さない。

保存は owner ごとに進行中 1 件と未送信の最新値 1 件へ集約する。表示値と IME は即時更新し、永続化・preview のみ遅延可能とする。保存失敗・結果不明は local draft を保持し、Composer 内に英語の簡潔な失敗表示と明示的な再試行を用意する。異なる owner の ack や、古い load / preview は現在の編集を変更しない。

Send／終了時の明示flushは保留中のdebounceを解除し、保存を開始する。既に進行中の保存を並列化せず、その完了と後続の最新pending値まで待つ。

renderer の `src/chat/auxiliary/use-auxiliary-draft-persistence.ts` が Auxiliary draft owner のMap、送信待ち、quit flushと送信captureの保存・revision照合・clear／失敗復元を管理する。Main／Auxiliaryの通常Sendの予約受付は `src/chat/runtime/session-turn-acceptance.ts`、receipt再照会・予約操作は `src/chat/conversation/use-session-turn-queue.ts`、現在turnへの入力・preview・ACK適用・入力失敗表示は `src/chat/runtime/use-session-turn-input.ts` が所有する。Session Windowは対象会話と機能間の接続を渡す。

Auxiliaryの実行設定選択は `src/chat/auxiliary/auxiliary-runtime-option-operation.ts` のownerが、会話identityごとの要求revision、optimistic反映、失敗時の再取得・rollbackを管理する。遅い失敗や再取得で後続の選択・別identityの設定を巻き戻さず、checkpoint保存失敗は受理済みの選択と区別してdiagnosticへ通知する。

送信は controller の最新値と編集 revision を捕捉し、当該 owner の保存を確定してから durable revision を指定する。受付の明示 consume と通常 runtime 保存を区別し、古い save / terminal が入力を復活・消去させない。通常Sendは予約受付時にcaptured durable値のcacheを失効させ、後続編集ではconsume後のrevisionを取得する。turnの結果待ちを受付待ちと同一視せず、終端までdraft保存やSend Inputを待たせない。予約受付の拒否ではdraftを保持し、受付結果不明では正本を照会する。直接追加入力の失敗時の復元は捕捉した編集 revision と照合し、後続の新しい入力を上書きしない。通常Window closeは未保存ownerのflushを試みるが、失敗・timeout・Renderer終了では入力中promptの未保存範囲を破棄して閉じる。provider応答とMainの保存処理は破棄対象にしない。app quitは保存失敗時に終了を中止し、生存Windowの入力と再試行導線を保持する。強制終了では最後のack後の未保存範囲を失い得る。

Codexの実行中Turnが入力受付可能な間は、Main／Auxiliaryのチャット内の予約項目から`Steer`で追加入力できる。独立した追加入力shortcutは現在のComposer下書きを直接送る。捕捉したTurn IDをMainとadapterの両方で照合し、終了・取消・不一致を新規Turnへ振り替えず、実行設定と既存bindingを維持する。予約の追加入力が送信結果不明になった場合はreceiptを保留し、直接下書き入力の失敗ではdraftを保持する。受理済みuser本文は実行中の会話へ追加し、元Turnのterminal保存に含める。

Main／Auxiliaryの本文更新は共通の保存通知購読を使う。Auxiliaryの通知ownerは親Session IDであり、対象の保存通知を受けると表示中・保持中のAuxiliary detailを再取得する。`detailChanged: false`や対象外の通知は本文を再取得しない。同じ実行状態の追加入力もこの経路で反映し、live本文deltaを保存通知の代用にしない。保存通知とterminalの詳細取得は同じ適用経路を使い、後続read・親切替・局所変更で古くなった応答を捨て、読込中のBookmarkと現在の実行設定を保持する。

Auxiliaryの直接追加入力も同じdraft owner / incarnation / durable revisionの保存・consume・失敗復元を使う。draft ownerはconsumeから受付結果の確定まで後続編集の保存を待機させ、成功・拒否後に再取得したdurable revisionで最新本文をCAS保存する。再取得・保存の失敗はpending本文を保持して明示再試行へ渡す。draftの保存と失敗復元は入力受付可否から独立し、terminal / cancel後も親の生存、owner / incarnation / durable revisionの照合を保って保存する。直接追加入力の実行中consume許可は、Main serviceが現在のCodex turnと取消状態を確認してstorage内部inputへ付与する。rendererのpayloadを許可の根拠にせず、他providerには追加入力しない。次Turn予約はproviderの追加入力能力とは独立し、実guard解放まで開始しない。

送信失敗でlocal draftを復元した場合は、その場で保存ownerのpendingへ戻す。終了待ちの入力凍結中も、編集revisionが一致する内部復元は表示へ反映する。復元では凍結を解除せず、終了中止後に復元本文を編集できるようにする。Main側の復元にも失敗した値を終了flushから漏らさず、保存障害ではRetryを表示する。永続値を再取得し、同じownerの復元済本文なら追加書込みせず受理する。空のconsume直後のrevisionにだけ復元を書き込み、後続の永続編集や別incarnationは上書きしない。Retryでもこの条件を維持する。

通常closeの保存ACKとapp quitの終了ACKを区別する。通常closeは実行をMain Processで継続できる。承認されたapp quitは新規runの受付を止め、DBを開いたまま実行のキャンセルを要求してから、入力を凍結した各Windowの終了ACKを待つ。ACKは選択中でないownerも含めた送信結果と失敗時の復元pendingの保存までを含む。凍結中に送信前保存が完了しても新規runを開始しない。全Windowのquit ACK後も、既に閉じたWindowからの送信とMain側の復元保存を待ち、未確定・復元失敗・timeoutのままDBを閉じない。quitの待機期限にはproviderのキャンセル猶予と保存待機の時間を含める。待機timeoutではquitを中止して凍結を解除するが、開始済みのキャンセルは巻き戻さない。

Main側の復元失敗は送信Promiseの完了と別に、元の本文・consume後のincarnation・durable revisionを保持する。別WindowのACK待ち中に失敗しても忘却せず、quitの保存判定で永続値を確認して再保存する。再保存に失敗した場合は終了を中止し、次のquitで再試行する。renderer側の復元や後続編集が永続化された場合は古い復元を解消する。明示的な削除・別incarnationへの再作成も優先し、古い本文での上書き・再作成は行わない。

draft の使用時刻は本文と別に扱う。最初の編集で必要な順位変更を反映し、後続の同順位入力では一覧全体を再生成しない。永続的な最終使用時刻は集約保存と同時に確定し、再起動時は最後に保存された順序を復元する。preview は確定応答等からの派生情報のまま、未送信 draft を用いない。非terminalのlive eventは、runState・turn ID・取消・入力受付状態が変わった場合に軽量な保存済みrun statusを確認し、本文deltaだけでは再取得しない。Main runtimeは開始・終端のrunStateをliveへ投影するため、background／reasoning保持中も非nullだけでrunningと判断しない。terminal nullと実際の詳細表示では最新の本文を取得する。

既存タグの payload 内 draft は active / closed とも同じ ID の独立保存単位へ移す。空文字も有効であり、移行と旧正本の除去を atomic に確定する。中断時は再実行可能とし、会話・thread・Character・設定を保持する。親削除では独立 draft も除去し、旧 incarnation / storage generation の保存で会話を再作成しない。新規の二重正本、任意 SQL port、全体 mutex、分散編集基盤は追加しない。

作成入力の runtime selection mode と runtime option は、既存 `clientRequestId` の結果を返す場合も先に検証する。不正な入力を既存行への再送として成功扱いにしない。準備と commit の排他・再検証境界は ADR 007 に従う。

Auxiliary の作成準備は provider / ownership coordinator の外で行う。commit 時だけ親の incarnation、Character identity、provider runtime selection、current storage generation、request identity を再検証し、失敗時に親や既存会話を削除・snapshot 復元しない。Main Session の保存後に初期 Auxiliary の準備または commit が失敗した場合は、Main Session を削除せず、作成済み Main と Auxiliary 結果未確定または失敗を明示する。

既存 Auxiliary の更新・runtime 保存・終了・中断復旧は、非同期読込み時に捕捉した storage へ update-only で送る。通常更新と中断復旧は読込み済み会話と現行行をtransaction内で照合する。runtimeはmetadataとmessageCountだけを読み、開始・steer・terminalの専用commandで対象messageを追加する。ID・親ID・作成時刻によるincarnation・件数・親の生存を照合し、steerとterminalはrunning turn ownerも確認する。terminal message、thread／runState／previewと最小turn終端を同transactionで確定し、小さいmetadata ACKを返す。setup失敗やthread再試行のcheckpointは元runState／threadも照合する。既存本文・artifact・Bookmark・draftを再encodeせず、削除後の再挿入や並行変更の上書きを行わない。時刻ラベルは分精度のため、更新時刻だけを変更検知の根拠にしない。通常の作成・明示的な collection 置換と、この既存行更新を区別する。

terminal保存は通常本文・artifactと同ownerのrunning最小turnを同じtransactionで確定する。turn markerの更新が失敗した場合は本文もrollbackし、marker未確定の本文だけが保存済みとなった状態へ送信失敗のdraftを復元させない。結果不明の自動再保存・再送は行わない。

`auxiliary_sessions` は会話の metadata を列として保存する。provider / model / runtime option、thread、表示anchor、Character identity と snapshot、作成request identityを保持し、Character snapshotと作成requestの詳細だけを専用 JSON 列へ置く。`auxiliary_session_messages` は会話順序と軽量本文を行ごとに保存し、artifact 詳細は対象行の `artifact_body` に分離する。詳細は対象を開いたときに取得する。

`composerDraft` は `auxiliary_session_drafts` の単一正本から全会話読込み時に合成する。既存の payload 形式は起動時に transaction 内で metadata、message、artifact、draft へ変換し、旧 payload と派生 summary の列を同時に除去する。不正な行があれば変換全体を rollback し、部分移行や黙った破棄をしない。

Auxiliary一覧、active一覧、running一覧は metadata 列だけを読み、transcriptやCharacter定義本文を走査しない。title、Bookmark、実行設定のcheckpointは対象列・対象message行だけを更新する。

Auxiliaryは最終使用順（`updatedAt DESC, id DESC`）で並べる。実行、draft、preview更新で順序を更新する。選択状態はindexではなくstable IDで保持する。

## Recovery

アプリ強制終了などで `runState = running` の Auxiliary が残った場合、次回起動時に active 行を `runState = error` へ補正し、中断を示す assistant message を重複なく追加する。自動 resume は行わず、Session Window から直前 user message を明示的に再送する。補正後も Auxiliary の status と保存済み Character / provider identity は変更しない。

## Preview contract

previewはProvider呼び出しを行わず、確定した最終assistant応答ブロックの冒頭をMarkdown平文化し、空白を整理して長さを制限する。コード識別子、Unicode、表示本文を不必要に壊さない。streaming中、cancel、errorで新しい確定応答がない場合は前回値を保持する。

初回確定応答前は送信済みuser発言の冒頭を使う。新規作成直後の未送信Auxiliaryは`title`と`preview`を空文字列で保持する。Home Monitorの一覧と中央切替では空のまま表示し、表示用fallback本文を追加しない。旧形式行など`preview`を持たない場合も、preview自体は空文字列として扱う。draftはpreviewに使わない。一覧では最大2行、中央切替では同じ値を1行省略表示する。

## Validation boundary

実装で確認する対象は、複数Auxiliaryの保存・追加・切り替え、Main除外と同じ親内の未使用Character優先抽選、並行作成の再選択、未使用候補枯渇後の作成継続、stable owner／表示metadataの維持と送信時の定義更新、同時run、親削除時の全会話cleanup、metadata列の再読込、preview更新競合である。Electron GUI、Provider実機、cross-provider並行実行の未実施確認は、実施済みとして扱わない。
