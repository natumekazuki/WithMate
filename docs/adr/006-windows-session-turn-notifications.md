# 006 Windows Session Turn Notifications

- 状態: Accepted
- 日付: 2026-07-29

## Context

Session のターン完了まで時間がかかる場合、ユーザーは WithMate 以外のアプリで作業を続ける。対象の Session Window が前面にないと、完了に気づくために WithMate を定期的に確認する必要がある。

通知には Windows のネイティブ通知、アプリ内表示、独自の Windows toast XML が候補になる。通知はターン本体の成功を損なわない補助的な外部副作用として扱う必要がある。また、Session には Character icon があるが、画像形式やファイル状態によって Windows 通知へ利用できない場合がある。返答本文を通知へ含める場合は、ロック画面や Action Center に作業内容が表示され得るため、完了通知とは別に利用者が明示的に有効化できる必要がある。preview 生成は Electron main process の完了処理中に同期実行されるため、入力サイズを制限しない全量解析は Window 応答と turn cleanup を停止させる可能性がある。

## Decision

- 対応対象は Windows の通常 Session と Character 作成 Session とし、Companion と Auxiliary Session、macOS、Linux は対象外とする。
- Electron の `Notification` API を使い、Windows の既定の通知音と表示時間に従う。独自 toast XML は生成しない。
- packaged app だけが `com.natumekazuki.withmate` を AppUserModelID として使う。dev / visual-check の unpackaged app は `process.execPath` を使い、Start Menu に置かれた引数なしの `electron.exe` がインストール版の通知activation先になる衝突を避ける。
- 通知設定は既定で有効とし、App Settings から無効化できる。
- 返答冒頭の表示設定は完了通知とは別に設け、既定で無効とする。完了通知が無効な間は Settings 上で操作できないが、保存済みの選択値は維持する。
- provider の成功結果を含む Session が永続化された直後を通知契機とする。失敗、キャンセル、setup failure では通知しない。
- 対象 Session Window 自体が focus 中の場合だけ通知を抑止する。対象 Window が表示中でも、別アプリまたは別の WithMate Window が focus 中なら通知する。
- 返答冒頭の表示が無効、provider turn で確定した top-level assistant response message に空白以外の本文がない、または設定確認・preview 生成に失敗した場合、通知の title は `WithMate`、body は `「Session名」のターンが完了しました` とする。
- 返答冒頭の表示が有効な場合、通知の title は Session 名、body は provider turn で確定した top-level assistant response message のうち、最後の空白以外を含む message から生成した preview とする。末尾に空または空白だけの message が続いても、その直前の最後の非空 message を使う。Session timeline と Audit Log に保存する複数 response message の連結本文は preview source に使わない。preview は Renderer と同じ GFM と数式構文を認識し、リンク先、参照定義、HTML、数式、Mermaid、画像など画面上の平文ではない内容を除外して、表示対象の text だけを使う。除外後に表示対象の text がなければ完了通知へ戻す。改行と連続空白は一つの空白へまとめる。40 grapheme を超える場合は、その範囲内にある最後の `。`、`！`、`？`、`!`、`?` で切り、文末がなければ40 graphemeで切る。後続がある場合だけ `…` を付ける。
- 最後の非空 top-level assistant response message が 65,536 UTF-16 code units を超える場合は Markdown を解析せず、完了通知へ戻す。Markdown の解析負荷は構文によって増えるため、通常の provider 応答を十分に含めつつ、main process の同期処理を有限に保てる固定上限とする。65,536 以下は preview 生成の対象とする。
- Character icon は `nativeImage` で読み込める場合だけ通知へ渡す。未設定、相対 path、欠損、不正、非対応形式の場合は icon を省略し、Windows が選ぶアプリアイコンへフォールバックする。
- Session ID から安定した Windows notification ID を生成する。同一 Session の未処理通知がある場合は閉じ、プロセス再起動をまたぐ場合も Windows の Tag と Group によって新しい完了通知へ置き換える。
- Windows の system timeout 後も元の notification instance を Session 単位で保持する。同じ Session の新しい通知へ置き換える場合、または Session の単体削除、cutoff 一括削除、Sessions を含む DB 初期化が成功した場合は、その instance の `close()` を呼び、Action Center からの撤去を試みる。削除されなかった Session と、実行中のため一括削除から除外された Session の通知は閉じない。
- 通知の撤去失敗は記録するが、完了済みの Session 削除を失敗へ変更しない。削除結果を巻き戻せず、通知の再試行にも利用できる追加 API がないため、一括削除では削除済みの全 Session について通知撤去を先に試み、その後に workspace の cleanup へ進む。
- Electron の通知 instance が click を受け取れる間は、Session ごとに現在追跡中の最新 instance の最初の click だけを受け付ける。同じ click の多重発火、置き換え・撤去済み instance の遅延 click は無視する。`timedOut` で閉じた instance だけは Action Center からの click に備えて保持し、その他の close reason と reason が通知されない close では追跡を終了する。受け付けたクリック時点で対象 Session が存在すれば Session Window を開き、削除済みまたは読み込み・表示に失敗した場合は Home Window を開く。
- WithMate のプロセス終了後、または通知 instance が破棄された後に Action Center から通知をクリックした場合、Windows によるアプリ起動は許容するが、対象 Session への復帰は保証しない。
- 通知可否の判定、icon 読み込み、通知生成、表示、click 処理の失敗は記録するが、ターン結果を失敗へ変更せず、通知の再試行もしない。

実装の正本は `src-electron/session-turn-notification-service.ts` と `src-electron/session-runtime-service.ts`、設定の正本は `src/provider-settings-state.ts` と `src-electron/app-settings-storage.ts` に置く。観測可能な契約は `scripts/tests/session-turn-notification-service.test.ts`、`scripts/tests/session-runtime-service.test.ts`、設定関連 test に置く。

## Alternatives

### アプリ内通知だけを使う

別アプリを使用中の完了通知という目的を満たさないため採用しない。

### Windows toast XML を直接生成する

通知の識別子や表示、プロセス再起動後の activation target を制御できるが、Windows 固有の XML、activation、画像形式への追加対応が必要になる。プロセス終了後に Action Center の過去通知から対象 Session へ戻る利用場面は限定的であり、今回の範囲では Electron 標準 API の保守性を優先する。

### Character icon を通知前に対応形式へ変換する

より多くの画像を表示できるが、変換処理、cache、cleanup、失敗経路が増える。icon は補助情報であり、通知本体を優先するため採用しない。

### WithMate のいずれかの Window が focus 中なら通知しない

別の Session や Settings を操作中に、対象 Session の完了を見落とす可能性があるため採用しない。

### Audit Log の詳細更新後に通知する

補助的な enrichment の遅延や timeout が通知を妨げるため採用しない。Session の成功状態が永続化された時点で通知する。

## Consequences

### Positive

- 別アプリで作業している間も Session の完了へ気づける。
- 対象 Session を見ている時の重複通知を避けつつ、別の WithMate Window を操作中の完了は通知できる。
- 利用者が明示的に有効化した場合だけ、Session を開かずに返答の冒頭を確認できる。
- 通知または icon の失敗が provider の成功結果や Session 永続化へ影響しない。
- Electron 標準 API の範囲に限定し、Windows 固有実装を小さく保てる。

### Negative

- Windows の通知設定、集中モード、Electron の対応状況によって通知が表示されない場合がある。
- 返答冒頭の表示を有効にすると、Windows の通知表示設定に応じて作業内容の一部がロック画面や Action Center に残る可能性がある。
- Markdown の完全な描画は行わないため、preview には一部の記号が残る場合がある。
- 数式、Mermaid、画像だけの返答と、65,536 UTF-16 code units を超える返答では、preview を有効にしていても完了通知だけを表示する。
- icon を読み込めない場合は Character icon ではなくアプリアイコンになる。
- プロセス終了後、または通知 instance の破棄後に過去通知をクリックしても、元の Session へ直接復帰できない場合がある。
- Electron 43 の notification ID を使った static removal は macOS 専用である。プロセス終了によって Windows の notification instance を失った後は、その後の Session 削除から Action Center の過去通知を撤去できない。
- macOS、Linux、Companion、Auxiliary Session には同じ通知機能がない。
