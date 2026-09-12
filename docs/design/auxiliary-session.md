# Auxiliary Session

- 更新日: 2026-09-12
- 対象: Main Sessionに紐づく複数の補助会話、保存、runtime identity、一覧投影

## Goal

AuxiliaryはMainと同じWindowで利用する独立した会話である。Main 1件とAuxiliary複数件を保持し、画面にはMainと選択中のAuxiliaryを表示する。非表示のAuxiliaryも会話、draft、Character、実行状態を保持し、後から同じ会話を継続できる。

Auxiliaryは監査専用ではなく、通常のprovider chat/coding sessionとして扱う。Main・兄弟Auxiliaryとのtranscript、provider context、Memoryを自動同期しない。

## Scope

- Headerからの新規Auxiliary追加（既存会話を終了、置換、削除しない）。
- 作成順の一覧、stable Session IDによる選択、左右矢印による前後移動。
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

既存の`closed`行は保存された会話として一覧・継続対象に含める。継続時は同じID、thread、messages、draft、Character identityを使い、勝手に新規turnを開始しない。親削除時は親配下の全Auxiliaryをruntime停止・保存削除の対象にする。

## Character identity

新規AuxiliaryはMain Processでactive Character候補からMainのstable Character IDを除外してweighted random選択する。他Auxiliaryと同じCharacterは許容する。候補が0件、snapshot生成失敗、catalog競合の場合は作成を失敗させ、Main／neutralへfallbackしない。

作成時に`characterId`と`CharacterRuntimeSnapshot`を保存し、provider prompt、表示、一覧icon、Memory owner、binding解決で同じidentityを使う。catalog編集・archive後も既存snapshotを再生成しない。snapshotがない旧形式行だけは親の保存済みidentityを互換fallbackに使い、不正な新形式snapshotは親へ差し替えず明示的に失敗させる。

## UI flow

通常Sessionの新規作成時は初期Auxiliaryを1件作成する。既存SessionにAuxiliaryがない場合も共通chat shellのAuxiliary領域だけを空で表示し、特別な状態文言は表示しない。追加のAuxiliaryはHeaderの`New Auxiliary`から行う。対象会話の`Collapse`をその前に置き、メッセージがない場合もdisabledで表示する。ActionDockの対象切り替えは`Preview / Source`の直前に並べる。作成中でも既存Auxiliaryの会話、draft、実行状態を変更しない。同じclientRequestIdの再送は同じ保存行を返し、明示的に別IDを発行した追加は別会話になる。

Companion modeは新規Auxiliary作成とprovider実行を退役させている。既存の保存済みAuxiliaryがある場合に限り、一覧の閲覧と切り替えを許可する。

Auxiliary中央には、キャラiconと内容previewを持つ前後切替を置く。中央表示名のクリック、Enter、Spaceで一覧を開き、確定選択時だけ切り替える。一覧行はiconと会話内容previewだけを表示し、Character名、番号、provider、日時、status badgeを情報列として追加しない。preview検索は保存済みpreview文字列だけを対象にする。

折りたたみ時もAuxiliary領域と内部スプリッターは最小幅（標準5%）で残し、ActionDock対象をMainへ戻す。スプリッターのクリックは最小化だけを行い、最小化中のドラッグはその位置からAuxiliaryを再展開して幅を調整する。会話、draft、Character、runは保持する。非対象チャットには本文の可読性を保ちながら非選択だと分かる濃度のoverlayをかけ、本文選択、Copy、リンク、switcher操作を遮らない。

メッセージの投影、折りたたみ状態、一覧からの移動要求、スクロール位置は各会話Columnが所有する。送信時の末尾追従は既存の設定に従って対象Columnへ一度だけ通知する。個別の折りたたみ状態はメッセージ一覧にも反映し、一覧選択は同じ会話の対象メッセージへ移動する。実行制御のため親が購読している会話はそのlive snapshotをColumnへ渡し、Columnでは二重購読しない。親が購読しない会話はColumnが購読し、非対象側のlive表示も更新する。ContextPaneの一覧選択callbackも共通画面へ渡し、選択した内容を表示へ反映する。

## Context boundary

初期値としてworkspace/cwd、parentのsession files、作成時点のAdditional Directory許可、provider、model、reasoning、approval、sandbox、custom agentを受け継ぐ。作成後のMain／兄弟変更は追従しない。Auxiliaryで追加した許可は他会話へ伝播しない。

MainとAuxiliaryはmessages、composer draft、live run、pending approval／elicitation、provider thread、実行結果を分離する。Mainのmessage listへAuxiliary全文を自動挿入せず、必要な引用は既存のCopy／Quote操作でユーザーが明示する。

## Persistence

`auxiliary_sessions`は少なくとも次をpayloadへ保存する。

- `id`, `parentSessionId`, `status`, `createdAt`, `updatedAt`, `closedAt`
- provider / model / runtime option / allowed additional directories
- `threadId`, `messages`, `composerDraft`, `displayAfterMessageIndex`
- `characterId`, `characterRuntimeSnapshot`, `characterIconPath`
- `preview`, `clientRequestId`

一覧用の`summary_json`はpayloadの派生projectionであり、messages、draft、Character定義本文を含めない。upsert時にpayloadと同時更新し、既存行は初回migrationで一度だけ補完する。Auxiliary一覧、active一覧、running一覧はsummary列だけを読み、全transcriptや定義本文を毎回走査しない。会話本文の取得とruntime復元だけがpayloadを読む。

Auxiliaryは作成順（`createdAt ASC, id ASC`）で並べる。実行、draft、preview更新で順序を変えない。選択状態はindexではなくstable IDで保持する。

## Preview contract

previewはProvider呼び出しを行わず、確定した最終assistant応答ブロックの冒頭をMarkdown平文化し、空白を整理して長さを制限する。コード識別子、Unicode、表示本文を不必要に壊さない。streaming中、cancel、errorで新しい確定応答がない場合は前回値を保持する。

初回確定応答前は送信済みuser発言の冒頭を使う。新規作成直後の未送信Auxiliaryは`title`と`preview`を空文字列で保持し、一覧・中央切替でも空のまま表示する。旧形式行など空のpreviewを持たない場合だけ、表示側の互換fallbackとして`新しい会話`を使う。draftはpreviewに使わない。一覧では最大2行、中央切替では同じ値を1行省略表示する。

## Validation boundary

実装で確認する対象は、複数Auxiliaryの保存・追加・切り替え、Main除外Character抽選、snapshot固定、同時run、親削除時の全会話cleanup、summary列の再読込、preview更新競合である。Electron GUI、Provider実機、cross-provider並行実行の未実施確認は、実施済みとして扱わない。
