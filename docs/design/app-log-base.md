# App Log Base


## Goal

WithMate のクラッシュやフリーズを調査するため、アプリ起動から終了までの重要イベントを追跡できるようにする。Main/Renderer の未捕捉例外、Renderer / child process の異常終了、IPC 失敗、ロード失敗も対象とし、JSONL とクラッシュダンプ保存先で確認する。

## Position

- この文書はアプリ診断ログの current design とする。
- Window / IPC の構成は `docs/design/electron-window-runtime.md` を参照する。
- セッションの会話本文と操作結果は通常履歴・artifactの責務であり、このログ基盤とは分離する。

## Scope

- Main Process 集約の JSONL ロガー。
- Electron runtime 情報を持つ共通ログ項目。
- Preload 経由の Renderer error / unhandled rejection 転送。
- `ipcMain.handle` の失敗記録。
- BrowserWindow / WebContents の crash / freeze / load failure 監視。
- crashReporter の起動とクラッシュダンプ保存先の導線。
- Settings からログフォルダとクラッシュダンプフォルダを開く API。

## Out Of Scope

- 外部サーバーへの crash dump upload。
- IPC request / response の通常成功ログ。
- provider API body、IPC payload、添付ファイル内容、標準出力・標準エラーの全文保存。
- dump file の起動時 scan と一覧表示。
- ドメイン service ごとの詳細な file / config / network ログ。

## Runtime Structure

```mermaid
flowchart LR
    Renderer[Renderer] -->|error / unhandledrejection| Preload[Preload]
    Preload -->|withmate:renderer-log| MainIpc[Main IPC]
    MainIpc --> Logger[AppLogService]
    Electron[Electron app / BrowserWindow / WebContents] --> Logger
    Logger --> Jsonl[logs/withmate.jsonl]
    CrashReporter[crashReporter] --> Dumps[crashDumps path]
    Settings[Settings Window] -->|open folder| MainIpc
```

## Log Format

ログは 1 行 1 イベントの JSONL とする。型定義は `src-shared/window/app-log-types.ts` に置く。

共通項目:

- `timestamp`: ISO 8601 文字列。
- `level`: `trace` / `debug` / `info` / `warn` / `error` / `fatal`。
- `kind`: イベント種別。
- `process`: `main` / `renderer` / `preload` / `worker`。
- `message`: 人間が短く読める要約。
- `appVersion` / `electronVersion` / `chromeVersion` / `nodeVersion` / `platform` / `arch` / `isPackaged`: Main Process で付与する runtime 情報。
- `windowId`: Window に紐づく場合だけ付与する。
- `data`: 調査用の構造化メタデータ。Codexの未対応notification診断に限り、下記の制限付きpayloadを含む。
- `error`: `name` / `message` / `stack`。

## Storage

- 保存先は `userData` 配下の `logs/withmate.jsonl`。
- Main Process から同期 append する。
- `AppLogService` はログディレクトリを自動作成する。
- 1 ファイルの既定上限は 5 MiB。
- ローテーション時は衝突しないtimestamp suffix付きのファイルへ退避する。同一millisecondでは採番を増やし、mtimeが同じ場合もsuffixで新旧を判定する。active fileを含め既定で5ファイルまで保持する。

## Event Policy

記録する主要な `kind` は次の通り。

- `app.started`
- `app.ready`
- `app.before-quit`
- `app.will-quit`
- `app.window.created`
- `app.window.closed`
- `crash-reporter.started`
- `crash-reporter.start-failed`
- `main.uncaught-exception`
- `main.unhandled-rejection`
- `renderer.process-gone`
- `child-process.gone`
- `webcontents.unresponsive`
- `webcontents.responsive`
- `renderer.error`
- `renderer.unhandled-rejection`
- `renderer.did-fail-load`
- `ipc.error`

通常の `ipc.request` / `ipc.response`、画面ロード成功、API request / response は記録しない。量と機密情報漏えいリスクが高く、クラッシュ調査の価値に対してノイズが多いため。

## Storage Diagnostic Log Policy

storage Workerと排他coordinatorの診断は、Mainの`StorageOperationLogService`で集計する。通常履歴・最小turnの保存と失敗通知とは独立している。

- 通常のqueued／started／completed成功は個別appendせず、イベントがある60秒区間ごとに`storage.operation.summary`を1行だけ同期appendする。空区間では出力しない。
- 操作名ごとのqueued／started／成功／失敗／遅延完了件数と最大wait／hold時間を記録する。waitまたはholdが100ms以上の区間はwarnとし、最長waitとholdの相関ID・request ID・storage generationを各1件のsampleで保持する。
- 集計は操作名16種とoverflow bucketに制限する。超過する操作の件数と時間はoverflowへ加算し、容量超過を理由に追加appendしない。操作名・sampleの文字列は160文字までで、イベント本文や未完了operationの一覧、無制限queueは保持しない。
- outcomeがfailureの診断は容量に関係なく`storage.operation`をerrorとして即時同期appendする。相関ID・request ID・generation・stage・outcome・時間を保持する。原因の例外は既存のIPC／runtime失敗ログが記録する。error／fatalなどその他のapp logも従来どおり同期appendする。
- 正常終了の`will-quit`でtimerを停止し、残る集計を同期flushする。終了後の失敗診断も即時記録する。異常終了時は最後の集計区間を失う可能性があるが、記録済みの失敗／fatalを通常集計のために待たせない。
- 集計／即時診断のwrite失敗はMainの`console.warn`へ出し、storageの結果を変えない。失敗した集計は再queueせず、無制限retryやbuffer増加を行わない。

集計と即時診断は同じ`AppLogService`の5MiBローテーションを使う。非同期append bufferは設けず、重要イベントの書込み時点と正常終了の同期flushを保つ。

## Session Folder Cleanup Diagnostic Log Policy

`Clean Session Files`の容量計算は、通常運用でも計算ごとに`session-folder-cleanup.scan-completed`（完了）または`session-folder-cleanup.scan-failed`（中断）を1行記録する。追加のdebug設定は不要。保存先は同じ`logs/withmate.jsonl`で、Settingsの`Open Logs`から取得できる。削除せず容量計算だけでも採取できる。

条件（From／Through、MiBと換算byte）、Mainの`updatedAt`をlocal日付で比較する日付基準、採取時のtimezone offset、全Session数、無効日時・期間前・期間後・期間一致の件数を記録する。その後の実行中・Workspace重複による除外、走査を試みたfolder・走査したfolder・通常fileを観測しなかったfolder・消失folder、link除外、通常fileと候補fileの件数・容量、最小サイズ未満のfile件数、entry失敗・消失entry件数、処理段階と経過時間を集計する。後段の件数は前段を通過した対象だけであり、`managedRoot=missing`ならfolder走査前に正常終了する。消失entry件数はentry失敗件数の内数で、通常fileを観測しなかったfolderにはlinkのみ・読取失敗も含みうる。

entry失敗は`entryFailureCategories`、計算自体の中断は`scanFailureCategory`で、`permission`（EACCES／EPERM）、`io`（EIO）、`missing`（ENOENT／ENOTDIR）、`other`へ固定分類する。正常完了の`scanFailureCategory`は`null`。例外のcode原文は記録しない。

この診断イベントにはSession ID、scan ID、path、filename、個別Sessionの日時、会話本文、例外のmessage／stackを渡さない。中断は到達した`stage`と固定分類で区別し、元の失敗を呼出元へ返す。ログ出力の失敗は容量計算の成否を変えない。

## Provider Diagnostic Log Policy

通常のProvider診断と背景の失敗専用ファイルは別の記録先とする。

provider 実行ログは、通常運用では turn 単位の summary を残す。例外として、Codexのscope内で専用分岐のない正常なnotificationは、UI投影要否の調査用に受信ごとに記録する。

`codex.run.unhandled-notification`はinfoでsession/thread/turn ID、method、paramsを記録する。Workerの既存redactorでAPI key・既知binding情報を除去し、既存raw item上限（128 Ki文字、個々の文字列は64 Ki文字）で制限する。app logではさらに文字列4,000文字、serialized data 12,000文字へ切り詰め、既存rotationで保持する。methodとparamsが大きい場合は部分情報となる。任意の秘密・会話・tool結果・path等を含みうるため、共有前に内容を確認する。対象と除外は[Codex projection owner](provider-adapter.md#codex-projection-owner)を参照する。

Codex の通常ログに残す summary:

- `codex.run.started`
- `codex.run.completed`
- `codex.run.failed`
- `codex.run.provider-error`
- `codex.run.stream-error`
- `codex.run.parse-noise.ignored`
- `codex.run.stream-close-failed`
- `codex.run.stream-close-timeout`
- `codex.run.snapshot-timeout`

`codex.run.completed` / `codex.run.failed` / `codex.run.provider-error` / `codex.run.stream-error` には、原因分析に必要な `providerErrorReason`、`turnCompleted`、`hasUsage`、`itemCount`、`liveStepCount`、`streamErrorMessage` などの構造化 summary を残す。

上記の未対応notificationを除き、Codex stream の event-level 診断ログは通常運用では出さない。

- `codex.run.stream.opened`
- `codex.run.stream.event`
- `codex.run.stream.finished`

上記 3 種は、provider stream の lifecycle や SDK event payload を調べる必要がある場合だけ、`WITHMATE_CODEX_STREAM_DEBUG=1` で再有効化する。

CopilotのDepth候補調査には`copilot.model-depth.discovery`、`copilot.model-depth.cache`、`copilot.model-depth.selection`を使う。探索結果とcache保存結果は探索ごとの相関IDで結び、保存結果の取得時刻と選択側の取得時刻を照合する。探索結果は対応フラグ・候補・policyの分類、選択側はcache取得状態・候補・表示条件を記録する。model IDは制限した公開モデル形式だけを記録し、その他は省略する。候補文字列も既知のeffort値だけとし、認証情報・Workspace path・provider応答本文は含めない。selectionの表示条件は実描画の成功を保証しない。同時刻の取得が重なる場合は取得時刻だけでは区別できない。

## Privacy And Redaction

- IPC payload、API request / response body、API key、添付ファイル内容は通常記録しない。Codexの未対応notificationは上記の限定診断としてparamsを含みうる。既知redactor対象以外の機密の除去は保証しない。
- `data` は JSON 化できるメタデータと上記の限定診断にする。
- 文字列と serialized data は上限を持ち、巨大データは preview に切り詰める。
- 循環参照など JSON 化できない値は `"[unserializable]"` として記録する。

## User Access

Settings Window は次の操作を提供する。

- `openAppLogFolder`: ログフォルダを開く。
- `openCrashDumpFolder`: Electron crash dumps フォルダを開く。

Renderer からは `window.withmate` の navigation API として呼び出す。実際のパス解決と folder open は Main Process が担当する。

## Failure Handling

- ログ書き込み失敗はアプリ動作を止めず、Main Process の `console.warn` に落とす。
- `ipc.error` は元の IPC 例外を握りつぶさず、記録後に再 throw する。
- crashReporter 起動失敗は `crash-reporter.start-failed` として記録する。

