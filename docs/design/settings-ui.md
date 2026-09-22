# Settings UI
- 作成日: 2026-03-14
- 更新日: 2026-09-23
- 対象: 独立した `Settings Window`
## Goal

設定系の要素を `Home Window` から分離し、独立した `Settings Window` に集約する。
`Home Window` は session / character 管理ハブへ寄せ、設定編集は別 window で落ち着いて扱えるようにする。

## Decision

- 設定は `Home Window` から開く独立 `Settings Window` とする
- app 共通 system prompt を編集する旧設定項目は廃止する
- V5 current では Character 定義は `Characters` editor で管理し、session 開始時の `CharacterRuntimeSnapshot` を runtime prompt の主経路にする
- provider instruction sync は V5 Character 注入の主経路ではなく、Settings current UI には置かない
- current 実装では `App`、`PromptContext`、`CodingAgentProviders`、`Diagnostics`、`ModelCatalog`、`RepositoryGlossary`、`StorageMaintenance` を置く。microcopy catalogの編集面や保存設定は提供せず、既存のmicrocopy保存キーもcurrent `AppSettings`へ読み戻さない
- Settings のsectionとprovider rowは意味上のgroupを保つが、入れ子の装飾card、重複するsection見出し、説明だけの空行は置かない
- Memoryの通常操作はprovider共通MCPの`tools/list`を正本とし、Settingsにはprovider instruction sampleやcopy導線を置かない
- `Settings Window` は縦方向の余白を少し増やしつつ、内容が増えた場合は window 内スクロールで末尾まで操作できるようにする
- file picker / save dialog は Main Process 側で開く
- current 実装では Main Process 側の settings / catalog 更新は `src-electron/settings/settings-catalog-service.ts` に寄せ、renderer 側の provider row 組み立ては `src/home-settings-view-model.ts` に寄せる

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. 独立した `Settings Window` が開く
3. App 表示設定、PromptContext の4項目、coding provider の enable / disable と provider file settings を編集して保存する。window が小さいときは内部スクロールで下端まで移動し、`ImportModels` / `ExportModels` も実行できる
4. 結果は window 内の短いフィードバックで返す

操作中の同一 action は重複実行せず、対象controlをdisabledにし、局所spinnerとbusy/accessibility statusで状態を示す。正常なbutton labelをloading文字列へ置き換えない。設定編集で保存中に新しい変更が入った場合、保存済みの値だけを同期し、新しいdraftはdirtyのまま保持する。失敗時はエラーをフィードバック領域に残す。

Memory Review は検索・pagination・detail取得の応答順を識別し、古い応答で現在の一覧やdetailを上書きしない。detail切替中は旧detailのForget / Export操作を表示せず、Forget / GCの対象と削除影響を確認できる表示を維持する。

## Layout

- Home toolbar
  - `Settings`
  - `AddCharacter`
  - `NewSession`
- Settings Window
  - `App`
    - `LaunchAtLogin`
    - `SessionTurnNotification`
    - `NotificationResponsePreview`
    - `CloseActionDockAfterSend`
    - `ScrollToLatestOnSend`
  - `PromptContext`
    - `CharacterDefinitionSnapshot`
    - `CharacterAffectContext`
    - `ConversationTiming`
    - `ToolCallPresence`
  - `CodingAgentProviders`
    - provider 名を左、enable checkbox を右に置く
    - provider ごとの `ProviderFileSettings`
      - `RootDirectory`
      - `SkillRelativePath`
      - `InstructionRelativePath`
  - `Diagnostics`
    - `OpenLogs` / `OpenCrashDumps`
    - Memory V6 read-only diagnostics
      - runtime API status / application instance / runtime generation / build channel / discovery publish status
      - CLI shim status
      - latest Memory V6 diagnostic errors
- `ModelCatalog`
  - `ImportModels` / `ExportModels`
- `RepositoryGlossary`
  - `GlossaryProactiveCreateLimit`
- `StorageMaintenance`
  - `DeleteOldSessions`
  - 指定日より前に最後に使われた Session の削除
  - 実行中の Session は削除せず、結果フィードバックで skip 件数を返す
- `SaveSettings`
- 結果フィードバック

## Current Scope

- `App` の `CloseActionDockAfterSend` を含む表示設定の保存
- `PromptContext` の4項目を個別に保存し、既定値はすべて有効とする。表示labelは `CharacterDefinitionSnapshot` / `CharacterAffectContext` / `ConversationTiming` / `ToolCallPresence` とし、補足説明やHelp iconは表示しない。`Output Boundary`、`Workspace`、`User Input`、添付 reference などの作業境界は切り替えない
  - `Character Definition Snapshot` は Character の名前・説明・`character.md` 本文を切り替える。OFFでも通常 session の Character snapshot に対する `Output Boundary` は残す
  - `Character Affect Context` は system 側の該当 section と通常 session の context 取得を切り替える。turn後のBackground Affect評価・保存には影響しない
  - `Conversation Timing` は input 側の該当 section と通常 session の timing 取得を切り替える
  - `Tool Call Presence` は既存の通常 session の character snapshot 境界内で該当 section を切り替える。`character-authoring` には注入しない
- `Conversation Timing` は Copilot の system session cache を変えず、system 側の3項目は合成された system message の変更として扱う
- `LaunchAtLogin` の保存。保存後は Electron login item 設定へ反映し、起動時は `--background` で Boot / Home window を表示しない
- coding provider ごとの enable / disable
- coding provider ごとの `ProviderFileSettings`
  - `RootDirectory` は provider ごとの file 設定の基準 directory として保持される
  - `SkillRelativePath` がある場合は root 配下の相対 path として解決される
  - `InstructionRelativePath` は root 配下の instruction file 設定として保持される
  - V5 current では skill folder だけが runtime の skill 探索元になり、instruction file は Provider Instruction Sync を再起動せず設定値として保持する
- Diagnostics の folder open
- Diagnostics の Memory V6 read-only summary
  - runtime API は `running` / `stopped` / `failed` と、application instance、runtime generation、build channel、discovery publish状態を表示する
  - CLI shimはplatform、support、install状態、PATH状態を表示する
  - credential、binding reference、Memory本文、個人path、provider別状態、managed Skill同期状態はdiagnostics stateへ含めない
- Memory Review は active Memory entries の検索、raw body の read-only 表示、entry files の export、forget、protected object GC を提供する。`Kind` filter と `ForgetReason` selectorは`AllKinds` / `Decision` / `UserRequest`などのローカルPascalCase labelを使い、検索・forget payloadのkind / reason raw valueは変更しない。Forget と GC の確認では対象と削除影響を明示し、diagnostics の raw status / code と Memory の internal enum は翻訳しない
- `ModelCatalog` の import
- `ModelCatalog` の export
- `StorageMaintenance` の古い Session 削除
  - cutoff date は Settings Window 内の一時入力として扱い、app settings には保存しない
  - cutoff date のローカル日付 00:00 より前に最後に使われた Session を対象にする
  - 実行中の Session は削除しない

## Runtime Policy

- MemoryGeneration / Character Reflection / Monologue の background 実行は current runtime では行わない
- Memory extraction / Character reflection の既存 settings key は互換用に残る場合があるが、current UI では編集面を出さない
- Provider Instruction Sync の既存設定や table は legacy 互換として残る場合があるが、V5 Character runtime prompt の主経路ではない
- Main Process 側の `app settings` 更新、`model catalog` import、rollback、関連 session / telemetry invalidation は `SettingsCatalogService` が担当する
- `model catalog export` の document 取得も `SettingsCatalogService` が担当する
- renderer 側では `HomeApp.tsx` が storage 正規化を直接持たず、`home-settings-view-model` の derived data を使って provider row を描画する
- renderer 側の provider settings draft 更新は `home-settings-draft` の pure function を経由する
- provider file settings の directory / file picker は、`RootDirectory` 配下で選ばれた path だけを相対 path として draft へ反映する
- `HomeApp.tsx` は provider settings を別 state で持たず、単一の `AppSettings draft` を編集する
- save 時の payload は `home-settings-view-model` が resolved model / reasoning を反映した `persisted settings` として組み立てる
- Settings Window の `loading` 派生状態は `HomeApp.tsx` が組み立て、表示は対象領域のspinnerとaccessible status/busyへ集約する。正常な読込中にLoading文字列を重ねない
- Settings Window の `import / export / save` の文言組み立てと戻り値解釈は `home-settings-actions` が担当する
- Settings Window の古い Session 削除の確認文言と戻り値解釈は `home-settings-actions` が担当し、削除 orchestration は Main Process 側の session command API に委譲する
- Settings 保存成功時は renderer 側で戻り値の `appSettings` を draft に同期し、dirty 状態を解消する。完了後に常設の成功説明を残さない
- Settings の save が成功しても、その待機中に加えられた変更は上書きせず、`UnsavedChanges` として draft に残す
- Memory V6 diagnostics は Main Process 側の `getMemoryV6Diagnostics()` が集約し、renderer 側の `HomeApp.tsx` が初回表示時と Settings 保存成功後に再取得する
- Memory V6 diagnostics は`generatedAt`、`runtime`、`cliShim`、`lastErrors`の4 fieldだけを持つread-only projectionとして扱う
- Settings Window の Diagnostics 表示は`SettingsContent.tsx`が担当し、操作導線はfolder open、Memory Review、CLI shim操作、Settings saveに限定する
- Character editor は Settings Window から分離し、Home の `Characters` panel から開く独立 `Character Editor Window` で扱う。
- `character.md` の validation error は `Character Editor Window` の raw editor 操作結果として表示する。

## Future Scope

- 独立 monologue plane 用 API 設定
- 新規 workspace の root directory 設定
- provider ごとの既定値
- MemoryGeneration を再設計する場合の専用設定
- DB reset をSettingsへ戻す場合の専用導線

## Non Goals

- Home に設定項目を常設すること
- 独立 monologue plane 用設定欄を current milestone で追加すること
- MemoryGeneration / Character Reflection の旧設定 UI を current milestone で維持すること
- Memory managed Skillの同期状態やprovider instruction sampleを表示すること
