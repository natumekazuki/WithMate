# Auxiliary Session

- 更新日: 2026-09-12
- 対象: Main Sessionに紐づく複数の補助会話、保存、runtime identity、一覧投影

## Goal

AuxiliaryはMainと同じWindowで利用する独立した会話である。Main 1件とAuxiliary複数件を保持し、画面にはMainと選択中のAuxiliaryを表示する。非表示のAuxiliaryも会話、draft、Character、実行状態を保持し、後から同じ会話を継続できる。

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
- Auxiliary単独の削除／archive UI、手動Character picker、会話途中のCharacter変更。

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

新規AuxiliaryはMain Processでactive Character候補からMainのstable Character IDを除外してweighted random選択する。他Auxiliaryと同じCharacterは許容する。候補が0件、snapshot生成失敗、catalog競合の場合は作成を失敗させ、Main／neutralへfallbackしない。

作成時に`characterId`と`CharacterRuntimeSnapshot`を保存し、provider prompt、表示、一覧icon、Memory owner、binding解決で同じidentityを使う。catalog編集・archive後も既存snapshotを再生成しない。snapshotがない旧形式行だけは親の保存済みidentityを互換fallbackに使い、不正な新形式snapshotは親へ差し替えず明示的に失敗させる。

## UI flow

通常Sessionの新規作成時は初期Auxiliaryを1件作成する。既存SessionにAuxiliaryがない場合も共通chat shellのAuxiliary領域だけを空で表示し、特別な状態文言は表示しない。追加のAuxiliaryはAuxiliary切り替えUIのタイトル枠内にある`＋`から行う。Auxiliaryが0件の場合もタイトル枠と追加ボタンを表示する。対象会話の`Collapse`はSession Header actionとしてメッセージがない場合もdisabledで表示する。ActionDockの対象切り替えは`Preview / Source`の直前に並べる。作成中でも既存Auxiliaryの会話、draft、実行状態を変更しない。同じclientRequestIdの再送は同じ保存行を返し、明示的に別IDを発行した追加は別会話になる。

Auxiliary起動dialogのprovider pickerはHome `NewSession`とCharacter authoringと同じ状態境界を使う。provider取得中はpicker内のspinnerとbusy / accessible statusだけを表示して`StartAuxiliary`をdisabledにし、取得失敗はprovider errorだけをalertで示す。取得成功後にproviderが0件の場合だけ`No enabled coding providers.`を表示して開始不可にする。開始処理中は確定button内のspinnerとbusyだけを示し、busyをalertへ変換しない。

Auxiliary中央には、キャラiconと内容previewを持つ前後切替を置く。中央表示名のクリック、Enter、Spaceで一覧を開き、確定選択時だけ切り替える。一覧行はiconと会話内容previewだけを表示し、実行中はicon内にcompactなprocessing indicatorを重ねる。Character名、番号、provider、日時、status badgeを情報列として追加しない。preview検索は保存済みpreview文字列だけを対象にする。

MainとAuxiliaryの最小幅は各UI領域のCSSで360pxと定義する。レイアウトは領域の最小幅を読み、内部splitterを除いた実際の利用可能幅で比率を補正する。両方の最小幅とsplitterを確保できない場合は送信対象側だけを表示する。Auxiliaryの初期幅は0で、クリックで開閉する。幅0ではAuxiliaryのgrid track・表示領域・タイトル枠内のswitcherと追加buttonを表示せず、splitterだけを再展開導線として残す。閉じた状態からのdragや矢印キーによる展開は行わず、開いた領域だけを最小幅以上に調整する。幅と送信対象は独立し、対象はActionDockのMain／Auxiliaryスイッチとそのキーボードショートカットからだけ変更する。Auxiliaryの作成・選択では対象や幅を変更せず、開閉でも対象を変更しない。幅は既存の保存先へ保存し、復元時も0を有効な値として扱う。会話、draft、Character、runは保持する。非対象チャットには本文の可読性を保ちながら非選択だと分かる濃度のoverlayをかけ、本文選択、Copy、リンク、switcher操作を遮らない。

Windowsの通常Session Windowがfocus中でない間にAuxiliaryのturnが完了または失敗した場合は、既存のSession turn通知経路で通知する。通知のclickは親Session Windowを前面化し、対象Auxiliaryを選択する。新規WindowではURLのAuxiliary ID、既存Windowではrenderer navigation eventを使う。いずれの場合もMain／Auxiliaryの送信対象、幅、draft、選択中Window以外の実行状態は変更しない。

メッセージの投影、折りたたみ状態、一覧からの移動要求、スクロール位置は各会話Columnが所有する。送信時の末尾追従は既存の設定に従って対象Columnへ一度だけ通知する。個別の折りたたみ状態はメッセージ一覧にも反映し、一覧選択は同じ会話の対象メッセージへ移動する。実行制御のため親が購読している会話はそのlive snapshotをColumnへ渡し、Columnでは二重購読しない。親が購読しない会話はColumnが購読し、非対象側のlive表示も更新する。ContextPaneの一覧選択callbackも共通画面へ渡し、選択した内容を表示へ反映する。

## Context boundary

初期値としてworkspace/cwd、parentのsession files、作成時点のAdditional Directory許可、provider、model、reasoning、approval、sandbox、custom agentを受け継ぐ。作成後のMain／兄弟変更は追従しない。Auxiliaryで追加した許可は他会話へ伝播しない。

MainとAuxiliaryはmessages、composer draft、live run、pending approval／elicitation、provider thread、実行結果を分離する。Mainのmessage listへAuxiliary全文を自動挿入せず、必要な引用は既存のCopy／Quote操作でユーザーが明示する。

## Persistence

### Composer の更新・保存境界

Main / Auxiliary の入力は会話種別と stable ID をキーとする共通 Composer controller が所有する。draft、編集 revision、selection、IME、preview、保存状態は対象 Composer だけが購読し、Session shell / transcript / Auxiliary 一覧へ文字入力を通知しない。Paste、Quote、Skill、Template、添付、retry、送信後 clear も同じ操作へ接続する。Main draft は従来どおり Window 内のローカル状態であり、新しい永続化対象にしない。

Auxiliary の永続 draft は会話 payload と独立した保存単位を唯一の正本とする。専用の小さい読込み・保存 command を既存 storage Worker で実行し、owner / incarnation / durable revision を照合する。保存では transcript や Character snapshot を取得・直列化せず、小さい ack だけを返す。renderer の編集 revision と DB の durable revision は別である。full Session の読込みでは draft を合成するが、通常更新・runtime / terminal 保存・Settings 変更から合成 draft を書き戻さない。

保存は owner ごとに進行中 1 件と未送信の最新値 1 件へ集約する。表示値と IME は即時更新し、永続化・preview のみ遅延可能とする。保存失敗・結果不明は local draft を保持し、Composer 内に英語の簡潔な失敗表示と明示的な再試行を用意する。異なる owner の ack や、古い load / preview は現在の編集を変更しない。

renderer の `src/chat/auxiliary/use-auxiliary-draft-persistence.ts` が Auxiliary draft owner のMap、送信待ち、quit flushを一つのlifecycle ownerとして管理し、Session windowはComposer表示とturn処理を委譲する。

送信は controller の最新値と編集 revision を捕捉し、当該 owner の保存を確定してから durable revision を指定する。送信時の明示 consume と通常 runtime 保存を区別し、古い save / terminal が入力を復活・消去させない。送信拒否・失敗時の復元は捕捉した編集 revision と照合し、後続の新しい入力を上書きしない。正常な Window close / app quit は未保存 owner の flush を待ち、失敗時は閉じずに入力と再試行導線を保持する。強制終了では最後の ack 後の未保存範囲を失い得る。

送信失敗でlocal draftを復元した場合は、その場で保存ownerのpendingへ戻す。終了待ちの入力凍結中も、編集revisionが一致する内部復元は表示へ反映する。復元では凍結を解除せず、終了中止後に復元本文を編集できるようにする。Main側の復元にも失敗した値を終了flushから漏らさず、保存障害ではRetryを表示する。永続値を再取得し、同じownerの復元済本文なら追加書込みせず受理する。空のconsume直後のrevisionにだけ復元を書き込み、後続の永続編集や別incarnationは上書きしない。Retryでもこの条件を維持する。

通常closeの保存ACKとapp quitの終了ACKを区別する。通常closeは実行をMain Processで継続できる。承認されたapp quitは新規runの受付を止め、DBを開いたまま実行のキャンセルを要求してから、入力を凍結した各Windowの終了ACKを待つ。ACKは選択中でないownerも含めた送信結果と失敗時の復元pendingの保存までを含む。凍結中に送信前保存が完了しても新規runを開始しない。全Windowのquit ACK後も、既に閉じたWindowからの送信とMain側の復元保存を待ち、未確定・復元失敗・timeoutのままDBを閉じない。quitの待機期限にはproviderのキャンセル猶予と保存待機の時間を含める。待機timeoutではquitを中止して凍結を解除するが、開始済みのキャンセルは巻き戻さない。

Main側の復元失敗は送信Promiseの完了と別に、元の本文・consume後のincarnation・durable revisionを保持する。別WindowのACK待ち中に失敗しても忘却せず、quitの保存判定で永続値を確認して再保存する。再保存に失敗した場合は終了を中止し、次のquitで再試行する。renderer側の復元や後続編集が永続化された場合は古い復元を解消する。明示的な削除・別incarnationへの再作成も優先し、古い本文での上書き・再作成は行わない。

draft の使用時刻は本文と別に扱う。最初の編集で必要な順位変更を反映し、後続の同順位入力では一覧全体を再生成しない。永続的な最終使用時刻は集約保存と同時に確定し、再起動時は最後に保存された順序を復元する。preview は確定応答等からの派生情報のまま、未送信 draft を用いない。非 terminal の live event は軽量な run status を反映し、表示状態のためだけに詳細を再取得しない。terminal と実際の詳細表示では最新の本文を取得する。

既存タグの payload 内 draft は active / closed とも同じ ID の独立保存単位へ移す。空文字も有効であり、移行と旧正本の除去を atomic に確定する。中断時は再実行可能とし、会話・thread・Character・設定を保持する。親削除では独立 draft も除去し、旧 incarnation / storage generation の保存で会話を再作成しない。新規の二重正本、任意 SQL port、全体 mutex、分散編集基盤は追加しない。

作成入力の runtime selection mode と runtime option は、既存 `clientRequestId` の結果を返す場合も先に検証する。不正な入力を既存行への再送として成功扱いにしない。準備と commit の排他・再検証境界は ADR 007 に従う。

Auxiliary の作成準備は provider / ownership coordinator の外で行う。commit 時だけ親の incarnation、Character identity、provider runtime selection、current storage generation、request identity を再検証し、失敗時に親や既存会話を削除・snapshot 復元しない。Main Session の保存後に初期 Auxiliary の準備または commit が失敗した場合は、Main Session を削除せず、作成済み Main と Auxiliary 結果未確定または失敗を明示する。

既存 Auxiliary の更新・runtime 保存・終了・中断復旧は、非同期読込み時に捕捉した storage へ update-only で送る。transaction 内で読込み済み payload と現行行、親の生存を照合し、削除後の再挿入や並行変更の上書きを行わない。時刻ラベルは分精度のため、更新時刻だけを変更検知の根拠にしない。通常の作成・明示的な collection 置換と、この既存行更新を区別する。

`auxiliary_sessions`は少なくとも次をpayloadへ保存する。

- `id`, `parentSessionId`, `status`, `createdAt`, `updatedAt`, `closedAt`
- provider / model / runtime option / allowed additional directories
- `threadId`, `messages`, `displayAfterMessageIndex`
- `characterId`, `characterRuntimeSnapshot`, `characterIconPath`
- `preview`, `clientRequestId`

`composerDraft` は `auxiliary_session_drafts` の単一正本から読込み時に合成する。payload 内の旧 draft を通常更新の入力として受け入れない。

一覧用の`summary_json`はpayloadの派生projectionであり、messages、draft、Character定義本文を含めない。upsert時にpayloadと同時更新し、既存行は初回migrationで一度だけ補完する。Auxiliary一覧、active一覧、running一覧はsummary列だけを読み、全transcriptや定義本文を毎回走査しない。会話本文の取得とruntime復元だけがpayloadを読む。

既存行の summary 補完は storage owner の明示的な bounded maintenance command で実行する。1 command は指定 batch 以下だけを処理し、進捗は `summary_json` と残件数で再開可能にする。payload の不正や projection 失敗を残件なしとして扱わず、エラーと残件を保持する。通常の一覧読み取りで全履歴を暗黙に backfill しない。

Auxiliaryは最終使用順（`updatedAt DESC, id DESC`）で並べる。実行、draft、preview更新で順序を更新する。選択状態はindexではなくstable IDで保持する。

## Recovery

アプリ強制終了などで `runState = running` の Auxiliary が残った場合、次回起動時に active 行を `runState = error` へ補正し、中断を示す assistant message を重複なく追加する。自動 resume は行わず、Session Window から直前 user message を明示的に再送する。補正後も Auxiliary の status と保存済み Character / provider identity は変更しない。

## Preview contract

previewはProvider呼び出しを行わず、確定した最終assistant応答ブロックの冒頭をMarkdown平文化し、空白を整理して長さを制限する。コード識別子、Unicode、表示本文を不必要に壊さない。streaming中、cancel、errorで新しい確定応答がない場合は前回値を保持する。

初回確定応答前は送信済みuser発言の冒頭を使う。新規作成直後の未送信Auxiliaryは`title`と`preview`を空文字列で保持する。Home Monitorの一覧と中央切替では空のまま表示し、表示用fallback本文を追加しない。旧形式行など`preview`を持たない場合も、preview自体は空文字列として扱う。draftはpreviewに使わない。一覧では最大2行、中央切替では同じ値を1行省略表示する。

## Validation boundary

実装で確認する対象は、複数Auxiliaryの保存・追加・切り替え、Main除外Character抽選、snapshot固定、同時run、親削除時の全会話cleanup、summary列の再読込、preview更新競合である。Electron GUI、Provider実機、cross-provider並行実行の未実施確認は、実施済みとして扱わない。
