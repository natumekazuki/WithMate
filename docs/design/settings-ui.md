# Settings UI

画面横断の原則と操作部品の表現は[UI Design Guidelines](ui-design-guidelines.md)に従う。この文書はSettings Window固有の構成と操作条件を扱う。

## Goal

設定系の要素を `Home Window` から分離し、独立した `Settings Window` に集約する。
`Home Window` は session / character 管理ハブへ寄せ、設定編集は別 window で落ち着いて扱えるようにする。

## Decision

- 設定は `Home Window` から開く独立 `Settings Window` とする
- Character定義は`Characters` editorで管理し、Session開始時の`CharacterRuntimeSnapshot`をruntime promptへ渡す
- current 実装では `App`、`Prompt Context`、`Coding Agent Providers`、`Diagnostics`、`Repository Glossary`、`Storage Maintenance` を置く。microcopy catalogの編集面や保存設定は提供せず、残存するmicrocopy設定キーは起動時に削除してcurrent `AppSettings`へ読み戻さない
- Settings のsectionとprovider rowは意味上のgroupを保つが、入れ子の装飾card、重複するsection見出し、説明だけの空行は置かない
- Memoryの通常操作はprovider共通MCPの`tools/list`を正本とし、Settingsにはprovider instruction sampleやcopy導線を置かない
- `Settings Window` はfieldsetの内外でsection間の余白を24pxに揃え、直前の入力欄やfocus枠と区切り線を離す。内容が増えた場合は window 内スクロールで末尾まで操作できるようにする
- `Session Turn Notification`はturn完了・失敗とCodexの構造化質問通知に共通で適用する。`Notification Response Preview`は成功したturnの完了通知だけを対象とし、質問文や入力値は表示しない。通知の条件と復帰先は[Desktop UI](desktop-ui.md#windows-session-notifications)を参照する
- `Session Approval Notification`はMain／AuxiliaryのCodex・Copilot・Claude・OpenCodeの承認待ち通知を独立して切り替える。既定値は有効で、通知内容はSession名と承認待ちだけとし、承認内容やwarning、pathは表示しない
- file picker / save dialog は Main Process 側で開く
- Main Process側のsettings更新は`src-electron/settings/settings-catalog-service.ts`、SDK model取得は`src-electron/settings/provider-model-discovery-service.ts`が担当する。renderer側のprovider row組み立ては`src/settings/settings-view-model.ts`に寄せる

## Interaction

1. ユーザーが Home toolbar の `Settings` を押す
2. 独立した `Settings Window` が開く
3. App 表示設定、PromptContext の4項目、coding provider の enable / disable と provider file settings を編集して保存する。window が小さいときは内部スクロールで下端まで移動する
4. 結果は window 内の短いフィードバックで返す

設定編集で保存中に新しい変更が入った場合、保存済みの値だけを同期し、新しいdraftはdirtyのまま保持する。

操作結果は操作ごとに扱い、並行した別操作の成功で未解消の失敗理由を消さない。再操作の結果はその操作の失敗理由だけを更新・解消する。失敗は元の操作buttonの横のiconで示し、そのbuttonから再操作できる。診断原文はiconから非modal popoverで開き、元の操作を覆わずに画面内へ配置する。長文は内部scroll・選択でき、Escape・閉じるbuttonでは入口へfocusを戻し、入口の再操作・外側clickでも閉じる。入力修正が必要な案内はフィードバック領域へ直接表示する。未解消の失敗がある間は通常の結果通知を出さない。ユーザーによるdraft編集では結果通知をクリアする。

Memory Review は検索・pagination・detail取得の応答順を識別し、古い応答で現在の一覧やdetailを上書きしない。detail切替中は旧detailのForget / Export操作を表示せず、Forget / GCの対象と削除影響を確認できる表示を維持する。

## Layout

- Home toolbar
  - `Settings`
  - `Add Character`
  - `New Session`
- Settings Window
  - `App`
    - `Launch At Login`
    - `Session Turn Notification`
    - `Notification Response Preview`
    - `Session Approval Notification`
    - `Close Action Dock After Send`
    - `Scroll To Latest On Send`
    - `Preview Wheel Zoom Step`
  - `Prompt Context`
    - `Character Definition Snapshot`
    - `Character Affect Context`
    - `Conversation Timing`
    - `Tool Call Presence`
  - `Coding Agent Providers`
    - provider 名を左、enable checkbox を右に置く
    - OpenCodeの認証はOpenCode側で設定する
    - provider ごとの `Provider File Settings`
      - `Root Directory`
      - `Skill Relative Path`
      - `Instruction Relative Path`
  - `Diagnostics`
    - `Open Logs` / `Open Crash Dumps`
    - Memory V6 read-only diagnostics
      - runtime API status / application instance / runtime generation / build channel / discovery publish status
      - CLI shim status
      - latest Memory V6 diagnostic errors
- `Repository Glossary`
  - `Glossary Proactive Create Limit`
- `Storage Maintenance`
  - `Delete Old Sessions`
  - 指定日より前に最後に使われた Session の削除
  - 実行中の Session は削除せず、結果フィードバックで skip 件数を返す
  - `Clean Session Files`: Sessionと会話を残したファイル整理。操作条件は[Session Folder Cleanup](#session-folder-cleanup)を参照
- `Save Settings`
- 結果フィードバック

## Current Scope

- `App` の `Close Action Dock After Send` を含む表示設定の保存
- `Preview Wheel Zoom Step`は画像／SVG／Mermaidの共通previewと画像lightboxのCtrl＋wheelの加算刻みを設定する。labelと3桁用の短い入力欄を横並びにし、通常時の説明文・単位表示は置かない。単位はpercentage points、既定値5、範囲は整数1〜100とする。空入力・小数・範囲外は入力欄にエラーを示して保存を止め、保存境界でも不正値を拒否する。設定項目がない既存データは5で初期化し、明示された不正な保存値を既定値へ置き換えない
- 刻みはapp共通の`AppSettings.previewWheelZoomStep`として永続化し、保存後は開いているSession／独立File Previewへ通知する。次のCtrl＋wheelから新しい刻みを使い、現在倍率・Fit状態・pan位置、Zoom In／Outの10ポイント刻みは変えない。独立File Previewは初期取得と変更通知を購読し、設定取得中・失敗時はCtrl＋wheelの倍率変更だけを止める。preview本体と他の倍率操作は維持し、読込中表示と失敗時のRetryを提供する
- `Prompt Context` の4項目を個別に保存し、既定値はすべて有効とする。表示labelは `Character Definition Snapshot` / `Character Affect Context` / `Conversation Timing` / `Tool Call Presence` とし、補足説明やHelp iconは表示しない。`Output Boundary`、`Workspace`、`User Input`、添付 reference などの作業境界は切り替えない
  - `Character Definition Snapshot` は Character の名前・説明・`character.md` 本文を切り替える。OFFでも通常 session の Character snapshot に対する `Output Boundary` は残す
  - `Character Affect Context` は system 側の該当 section と通常 session の context 取得を切り替える。通常turn内のMemory／Affect MCPの利用可否は切り替えない
  - `Conversation Timing` は input 側の該当 section と通常 session の timing 取得を切り替える
  - `Tool Call Presence` は既存の通常 session の character snapshot 境界内で該当 section を切り替える。`character-authoring` には注入しない
- `Conversation Timing` は Copilot の system session cache を変えず、system 側の3項目は合成された system message の変更として扱う
- `Launch At Login` の保存。保存後は Electron login item 設定へ反映し、起動時は `--background` で Boot / Home window を表示しない
- coding provider ごとの enable / disable
- Claude AgentとOpenCodeは初期状態で無効とし、有効化した場合だけ新規Sessionのprovider候補に出す。Codexは既定のproviderとして維持する
- OpenCodeの認証設定はOpenCode側で行い、WithMateではkeyを編集・保持しない。保存済みのOpenCode用keyはstorage ownerの起動時に対象fieldだけを除去し、他providerのkey、provider設定、会話、threadを保持する。このcleanupでは通常の設定更新によるthread invalidationを行わない。読込・保存境界でもOpenCode用keyは空へ正規化し、OpenCodeへ自動コピーしない
- Model候補はSDKから自動取得し、Settingsに手管理のimport／exportやrefresh操作は置かない。provider設定変更時は有効なproviderをbackground取得し、context別cacheを使う。現在選択やdraftは書き換えない。詳細は[Provider Model Discovery](model-catalog.md)を参照する
- coding provider ごとの `Provider File Settings`
  - `Root Directory` は provider ごとの file 設定の基準 directory として保持される
  - `Skill Relative Path` がある場合は root 配下の相対 path として解決される
  - `Instruction Relative Path` は root 配下の instruction file 設定として保持される
  - runtimeのskill探索にはskill folderを使い、instruction fileは設定値として保持する
  - Claude Agentで設定したskill folderも既存のWithMate探索へ使うが、SDKのnative Skill探索元として自動登録しない。選択したskillだけをpathのdirectiveでturnへ渡す。Claude CLIの本人ログイン・native設定・repositoryの`CLAUDE.md`と`.claude/skills`はSDKが読み込み、Settingsはcredentialや独自OAuthを提供しない
  - OpenCodeではnative config rootの`AGENTS.md`と`skills/<name>/SKILL.md`を読込先として案内する。任意の同期先をOpenCode設定へ自動登録せず、foregroundのnative設定読込を維持する。Memory用Skill／固定指示は同期しない
- Diagnostics の folder open
- Diagnostics の Memory V6 read-only summary
  - runtime API は `running` / `stopped` / `failed` と、application instance、runtime generation、build channel、discovery publish状態を表示する
  - CLI shimはplatform、support、install状態、PATH状態を表示する
  - credential、binding reference、Memory本文、個人path、provider別状態、managed Skill同期状態はdiagnostics stateへ含めない
- Memory Review は active Memory entries の検索、raw body の read-only 表示、entry files の export、forget、protected object GC を提供する。`Kind` filter と `Forget Reason` selectorは`All Kinds` / `Decision` / `User Request`などのローカルTitle Case labelを使い、検索・forget payloadのkind / reason raw valueは変更しない。Forget と GC の確認では対象と削除影響を明示し、diagnostics の raw status / code と Memory の internal enum は翻訳しない
- `Storage Maintenance` の古い Session 削除
  - cutoff date は Settings Window 内の一時入力として扱い、app settings には保存しない
  - cutoff date のローカル日付 00:00 より前に最後に使われた Session を対象にする
  - 実行中の Session は削除しない

## Runtime Policy

### Session Folder Cleanup

`Storage Maintenance`の`Clean Session Files`は、Sessionを削除せずmanaged folderのファイルを完全削除する独立操作である。期間・サイズはWindow内の一時入力とし、app settingsへ保存しない。

- `Last Active`の`From`／`Through`はSessionの最終利用日時をローカル日付で絞り、両日を含む。片端を省略するとその側の制限を設けず、全期間は`All Dates`で明示する。
- `Min File Size (MiB)`以上を対象とし、同値を含む。`0`は期間内の全ファイルを対象とする。
- `Calculate`は対象Session Folder数、合計容量、削除対象ファイルの件数・容量だけを表示する。全ファイル一覧やリンク切れの説明、内部ID、保護規則の常設解説は表示しない。
- `Delete Files…`は条件と削除概要だけの確認を開く。`Cancel`またはEscapeでは何も削除せず、`Permanently Delete`で実行する。正常0件と計算失敗を区別し、未計算・0件・処理中は削除へ進めない。
- 実行結果は削除件数・容量を表示する。除外・失敗は発生時だけ件数を表示し、失敗原因は操作横の詳細入口から確認する。計算中・削除中は操作button内のspinnerとaccessible busy stateを使う。
- 条件編集と実行後は計算結果を失効させ、再計算を必要とする。Settingsの古いSession削除とは同時実行しない。実際の対象保護と削除境界は[Session Local Files](session-local-files.md#sessionを残すファイル掃除)に従う。
- 削除失敗・部分失敗後は同じ`Delete Files…`から再操作できる。再計算した対象の概要を確認し、再び`Permanently Delete`を選ぶまで削除しない。再計算失敗も同じbutton横の詳細入口に表示し、対象が0件なら確認を開かない。

### Settings Runtime

- Main Process側の`app settings`更新、rollback、関連session／telemetry invalidationは`SettingsCatalogService`が担当する
- renderer 側では `HomeApp.tsx` が storage 正規化を直接持たず、`home-settings-view-model` の derived data を使って provider row を描画する
- renderer 側の provider settings draft 更新は `home-settings-draft` の pure function を経由する
- provider file settings の directory / file picker は、`Root Directory` 配下で選ばれた path だけを相対 path として draft へ反映する
- `HomeApp.tsx` は provider settings を別 state で持たず、単一の `AppSettings draft` を編集する
- save時のpayloadは`settings-view-model`が設定draftから組み立てる。SDK model一覧の取得を待たず、設定保存でSessionのmodel／Depthを変更しない
- Settings Windowはapp settingsとMemory diagnosticsを独立して取得する。設定draftが取得できればdiagnosticsを待たず編集でき、失敗は対象領域で再試行する。無関係な取得の完了や再試行で編集中draftを初期化しない。表示は共通spinnerとaccessible status/busyへ集約し、正常な読込中にLoading文字列を重ねない
- Settings Windowのsaveの文言組み立てと戻り値解釈は`settings-actions`が担当する
- Settings Window の古い Session 削除の確認文言と戻り値解釈は `home-settings-actions` が担当し、削除 orchestration は Main Process 側の session command API に委譲する
- Settings 保存成功時は renderer 側で戻り値の `appSettings` を draft に同期し、dirty 状態を解消する。完了後に常設の成功説明を残さない
- Settings の save が成功しても、その待機中に加えられた変更は上書きせず、`Unsaved Changes` として draft に残す
- Session Windowから変更するHeader・Action Dock・Side Paneの復元設定は即時適用する。Mainは変更項目の現在値を保持して設定再取得へ反映し、DBへの任意checkpointは別ラインで行う。保存失敗は診断ログへ残し、表示や操作は巻き戻さない。Settings Windowの明示的なSaveとは保存保証を分ける
- Memory V6 diagnostics は Main Process 側の `getMemoryV6Diagnostics()` が集約し、renderer 側の `HomeApp.tsx` が初回表示時と Settings 保存成功後に再取得する
- Memory V6 diagnostics は`generatedAt`、`runtime`、`cliShim`、`lastErrors`の4 fieldだけを持つread-only projectionとして扱う
- Settings Window の Diagnostics 表示は`SettingsContent.tsx`が担当し、操作導線はfolder open、Memory Review、CLI shim操作、Settings saveに限定する
- Character editor は Settings Window から分離し、Home の `Characters` panel から開く独立 `Character Editor Window` で扱う。
- `character.md` の validation error は `Character Editor Window` の raw editor 操作結果として表示する。

## Non Goals

- Home に設定項目を常設すること
- Memory managed Skillの同期状態やprovider instruction sampleを表示すること
