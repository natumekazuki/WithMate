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
- `data`: 調査用の構造化メタデータ。payload 本文は入れない。
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

## Provider Diagnostic Log Policy

通常のProvider診断と背景の失敗専用ファイルは別の記録先とする。

provider 実行ログは、通常運用では turn 単位の summary を残し、stream event 単位の詳細ログは出さない。

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

Codex stream の event-level 診断ログは通常運用では出さない。

- `codex.run.stream.opened`
- `codex.run.stream.event`
- `codex.run.stream.finished`

上記 3 種は、provider stream の lifecycle や SDK event payload を調べる必要がある場合だけ、`WITHMATE_CODEX_STREAM_DEBUG=1` で再有効化する。

## Background Failure Log Policy

背景三用途の実行自体の失敗と、操作エラーを含む実行の診断だけを`userData/logs/background-failures.jsonl`へ1行1呼出のJSONLで同期追記する。既存`AppLogService`の書式・directory作成を使い、このinstanceだけ`rotation: false`にする。容量・日数による回転・削除・起動時切詰めをせず、再生成したloggerも既存ファイルへ追記する。既存行は変更しない。通常`withmate.jsonl`の5MiB・5ファイルは変更せず、通常世代の整理は専用ファイルに触れない。

開始前の失敗は`background.execution.failed`のerrorとして、用途、実sourceのkind／ID、失敗段階と分類code／reason、取得済みProvider／Model／Depthと解決できた権限を記録する。開始済みの終端診断は`background.execution.diagnostic`とし、既存binding IDを実行識別子に、固定scope、開始／終了時刻、`execution.outcome`（completed／failed／canceled）、実行自体のfailureと操作列を含める。実行自体の失敗はerror、操作エラーを含む正常終了・取消はwarnにする。準備・材料取得段階の未発行IDや未取得値は推測しない。

操作列は要求／応答の順序、対応する要求ID、operation／tool名、transport、境界、時刻と成否を持つ。MCP protocol境界と、HTTP内の履歴read／Memory read／登録の境界を分け、それぞれの要求IDで応答を対応付ける。実行IDとcanonical operationは共通とする。失敗診断には最初の原因だけでなく後続操作も含め、登録応答から保存ID・owner／scope・effect・replay等を選別する。部分失敗の応答に含まれる保存済みprefixも識別情報だけを残す。登録成功の応答は保存効果を示すが、実行全体の成功や取りこぼしのない処理を証明しない。

`diagnostic`は実エラーのcode／message、field、検証path・期待条件、原因のcause／stack等を選別して保持する。Character／Affect保存で公開エラーへ変換される前の例外も既存admission経由でHTTPへ伝え、公開応答に含めず診断へ残す。既知のbinding／transport secretには既存redactorを使い、認証header、credential項目、secret付きURL等も秘匿化する。ProviderのpartialResult、会話本文・prompt・tool引数・履歴やMemoryの本文・環境変数全文は投影しない。文字列切詰めを秘匿化とは扱わない。専用loggerは`backgroundFailureDiagnostics: true`で選別済みの`background.execution.failed`と`background.execution.diagnostic`の`data`だけに通常の4000字／12000字上限を適用せず、原因情報を保持する。他kindと通常loggerの上限は維持する。

prepare、戻り値の`failed`、捕捉した例外、bound MCP／CLIで確定した操作エラーを対象とする。呼出しの終端を共通境界で一度記録し、用途controllerから同じ結果を再記録しない。操作エラーのない正常終了・登録不要終了・通常取消、未設定での正常な非実行は記録せず、一時操作列も終了時に解放する。途中の確定済みMemory／Affectを後続失敗で巻き戻さず、操作エラーを保存対象なしへ置換しない。後続で登録できても拒否の履歴を消さず、全拒否でAgentが正常終了しても保存成功とは扱わない。終了状態はAgent呼出・開始処理・取消の結果であり、操作結果や保存効果は操作列から別に確認する。

専用writeが失敗しても、元の失敗理由・保存効果・前景会話の成否を変更せず、既存の診断出力へ渡す。再送queue、無制限buffer、永続実行履歴DB、重複排除台帳は持たない。ログviewer・通知・保持設定を追加せず、利用者は既存のログフォルダを開く入口からファイルを確認する。

## Privacy And Redaction

- IPC payload、API request / response body、API key、添付ファイル内容は記録しない。
- `data` は JSON 化できるメタデータに限定する。
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

