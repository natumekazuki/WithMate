# Settings UI

画面横断の原則と操作部品の表現は[UI Design Guidelines](ui-design-guidelines.md)に従う。この文書はSettings Window固有の構成と操作条件を扱う。

## Goal

設定系の要素を `Home Window` から分離し、独立した `Settings Window` に集約する。
`Home Window` は session / character 管理ハブへ寄せ、設定編集は別 window で落ち着いて扱えるようにする。

## Decision

- 設定は `Home Window` から開く独立 `Settings Window` とする
- Character定義は`Characters` editorで管理し、Session開始時の`CharacterRuntimeSnapshot`をruntime promptへ渡す
- current 実装では `App`、`Prompt Context`、`Coding Agent Providers`、`Background Execution`、`Diagnostics`、`Repository Glossary`、`Storage Maintenance` を置く。microcopy catalogの編集面や保存設定は提供せず、残存するmicrocopy設定キーは起動時に削除してcurrent `AppSettings`へ読み戻さない
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
3. App 表示設定、PromptContext の4項目、coding provider の enable / disable と provider file settings、背景用途のmodel・本文・Memory頻度を編集して保存する。window が小さいときは内部スクロールで下端まで移動する
4. 結果は window 内の短いフィードバックで返す

設定編集で保存中に新しい変更が入った場合、保存済みの値だけを同期し、新しいdraftはdirtyのまま保持する。

操作結果は操作ごとに扱い、並行した別操作の成功で未解消の失敗理由を消さない。再操作の結果はその操作の失敗理由だけを更新・解消する。失敗は元の操作buttonの横のiconで示し、そのbuttonから再操作できる。診断原文はiconから非modal popoverで開き、元の操作を覆わずに画面内へ配置する。長文は内部scroll・選択でき、Escape・閉じるbuttonでは入口へfocusを戻し、入口の再操作・外側clickでも閉じる。入力修正が必要な案内はフィードバック領域へ直接表示する。未解消の失敗がある間は通常の結果通知を出さない。ユーザーによるdraft編集では結果通知をクリアする。

Memory Review は検索・pagination・detail取得の応答順を識別し、古い応答で現在の一覧やdetailを上書きしない。detail切替中は旧detailのForget / Export操作を表示せず、Forget / GCの対象と削除影響を確認できる表示を維持する。

Memory Review の一覧・detail・Forget確認は、保存済みowner / scopeからユーザー共通、プロジェクト、Character、Character＋プロジェクトを表示する。Characterは登録名とicon、プロジェクトは登録表示名を使い、同名はIDやworkspace pathの補足で区別する。登録情報や名前・画像が失われても別のCharacterへ置き換えず、対象の識別情報を保持する。補足は名称より弱く表示する。

一覧はtitle・対象・previewを表示し、Kindとtagsは詳細へ集約する。詳細はtitle・対象、補足のKindとローカル時刻の更新日時、保存本文、tag値、添付fileの順とする。本文は原文のread-only表示を維持する。添付は名前・summary・sizeとExportを表示し、出典の会話名やProvider、fileの内部role等を常設しない。保存された出典・tag・file metadataは変更しない。

`Forget Entry`は現在の対象から確認dialogを開く。理由はdialog内で選び、新たに開くときは`User Request`を選択する。確認ではtitle・対象・理由とprivacy時の保存本文等への影響を示し、Cancelとfocus管理を維持する。

下部の`File Storage`は使用量 / 上限を要約し、native disclosureを開くと全Memoryを対象に削除待ち・Largest Attachments・`Preview Cleanup` / `Clean Up Files`を表示する。後者の永久削除確認は維持し、操作後は対象数または削除数を表示する。取得・操作の失敗、部分失敗、参照中fileの欠落は、disclosureを閉じても確認できる。

`Search`は本文・title・preview・tag・対象名を検索し、`Kind`、`Character`、`Project`を組み合わせて絞り込める。CharacterとProjectは名前で選択し、両方指定した場合は同じentryが両条件を満たすものに限定する。検索条件の変更ではcursor・選択detail・Forget確認を解除する。対象候補の取得は検索と独立したloading / error / Retryを持ち、取得失敗を正常0件に置き換えない。

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
    - providerごとの`Models`からModel管理を開く
    - OpenCodeの認証はOpenCode側で設定する
    - provider ごとの `Provider File Settings`
      - `Root Directory`
      - `Skill Relative Path`
      - `Instruction Relative Path`
  - `Background Execution`
    - `Character Memory` / `Target Memory` / `Character Affect`ごとの`Provider`→`Model`→`Depth`、対応する`Approval`／`Reviewer`／`Sandbox`と`Registration Instructions`
    - Memory二用途の`Every Turns`と`Idle Minutes`
    - 本文は直接編集でき、`Use Preset`ボタンの押下で現在の用途preset本文へ置換する
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

## Model Management

`Coding Agent Providers`の各providerに`Models`入口を置き、同じSettings Windowの本文を共通の管理画面へ切り替える。検索とModel単位のcheckboxは4 provider共通とし、OpenCodeだけnativeサービスごとのcheckboxと配下のModel一覧を持つ。サービスOFFは個別設定を上書きせず、サービスONで元の個別設定へ戻る。

OpenCodeの接続先は、名前とModel件数を示す開閉buttonで配下一覧を折りたたむ。初期状態は閉とし、有効化checkboxは別の操作として配置する。開閉だけでは有効設定、draftのdirty状態、保存値を変更しない。検索中は一致する接続先を展開し、手動で閉じることもできる。検索語を変えると一致結果を再展開し、検索を解除すると通常時の開閉状態へ戻す。開閉状態は画面内だけで保持し、永続化しない。

Model一覧の先頭に`Enable All`／`Disable All`を置く。OpenCodeでは展開した接続先ごと、非階層Providerでは検索欄の下に配置し、画面内の表示範囲だけでなく対象一覧の全Modelを一括変更する。検索中は`Enable Matches`／`Disable Matches`とし、その接続先またはProvider内の検索一致Modelだけを対象とする。接続先の有効設定は変更せず、Providerまたは接続先がOFFの間は個別checkboxと同様に一括操作も無効にする。全対象が変更済みの場合も対応するbuttonを無効にし、不要なdraft更新を行わない。

一括変更の直後は管理画面headerに`Undo`を示し、直前の一括変更前の混在した個別設定へ戻せる。検索・折りたたみや対象一覧の消失では取り消せる状態を維持し、次の一括変更は取り消し対象を置き換える。個別Model／接続先の編集、保存などによる管理画面外からの無効化設定の置換、管理画面を離れる操作で取り消し対象を破棄する。一括変更も既存draftへ反映し、既存の`Save Settings`で確定する。

現在のSDK cacheから一覧を作り、cacheから消えた保存済みの無効IDも再有効化できる形で表示する。検索・自然順は通常のModel pickerと共有し、管理画面のcheckbox操作とは分離する。cache更新で編集中draftや検索文字列、操作中の行のfocusを失わない。取得中・失敗は対象領域で表示する。

`Back`はproviderの`Models`入口へfocusを戻し、編集内容を単一の`AppSettings draft`へ保持する。既存の`Save Settings` footerとdirty判定を共用し、独立した保存、Window、設定storeは追加しない。候補の除外と実行時の検査は[Model Availability](model-catalog.md#model-availability)に従う。

## Current Scope

- 背景三用途は`AppSettings.backgroundExecutionSettings`に用途別の選択と本文を保存する。Provider／modelは初期未設定で、通常Sessionの選択や別用途のMemory生成設定を流用しない。catalogの実IDで選択し、未設定、利用不可、一覧取得失敗を区別する。利用不可でも保存値を保持し、対応する選択への修正先を示す。背景対応Providerの判定は共有`background-provider-support.ts`を使い、無効なProviderは`Coding Agent Providers`での有効化を案内する。
- 背景Model候補はapp共通のModel／サービス無効設定を反映する。無効な現在値は`Disabled`として選択不能な表示だけを残し、Model／Depthの保存値を変えず`Models`での再有効化または別Modelの選択を案内する。有効ModelがないProviderは新規選択できない。
- 背景実行はCodex／Copilot／Claude／OpenCodeの既存adapterを利用する。各用途は同じgroup内で`Provider`→`Model`→`Depth`の順に編集する。新たに選べるProviderは有効なものだけとし、model候補が未取得なら選択できない。Provider変更時はcatalogの既定model（候補にない場合は先頭model）と既定Depthを既存model選択helperで解決し、一括設定する。Model候補は選択Providerのものだけを表示する。
- 各用途のselectionは`reasoningEffort`を任意で保持し、未指定はProviderの既定を意味する。`Depth`候補は選択modelの`reasoningEfforts`を使い、候補なしなら非表示とする。明示的なmodel変更時だけ既存model選択helperでDepthを調整する。catalog更新・Provider無効化だけでは保存値やdraftを変更しない。現在の無効／利用不可Providerや一覧から消えたmodelも選択表示を保持し、有効なProviderへ明示変更できる。Provider未設定・無効・一覧未取得ではModelとDepthを編集できない。
- 権限は同じ用途group内でProvider共通の候補・組合せ規則を使い、`Approval`は全対応Provider、`Reviewer`はCodex／Claude、`Sandbox`はCodexで編集する。欠落項目は選択Providerの既定値（ApprovalはCodex／CopilotがSafety Focused、Claude／OpenCodeがProvider Controlled、ReviewerはUser、SandboxはWorkspace Write）を使う。Provider変更時は対応する権限項目をそのProviderの既定値へ一括設定し、Model変更では権限を保持する。ClaudeのAuto Reviewで非対応のApprovalへ変えるときは、先にReviewerをUserへ明示変更する。Auto Run中のReviewerは編集しない。
- 明示された非対応権限や組合せは保持して警告し、実行時も拒否する。非対応fieldは保存値と`Not Applicable`の修正先を表示し、対応値への変更またはProvider変更で回復できる。背景実行開始時に用途別選択を捕捉し、通常Main／Auxiliaryや別用途の権限は継承・変更しない。SpeedはStandard、custom agentは未指定で明示構築する。保存した変更は次の背景実行から適用する。
- 登録本文は未設定なら用途presetを表示し、そのまま編集できる。`Use Preset`ボタンは現在の用途presetを編集本文へコピーして置換し、以後も編集できる。置換はdraftへ反映し、通常の`Save Settings`で保存する。設定後は空文字列も含めその本文だけを使う。preset本文の正本は`memory-registration-input.ts`と`affect-composition.ts`とし、Settings側に複製しない。
- `memoryRecordingFrequencies`はMemory二用途のTurn数・idle分を保持し、既定はそれぞれ5。Turn数は1以上の整数、idle分は0より大きい有限数とする。入力不正は入力欄に示して保存を止める。保存・読込境界も明示された不正値を拒否し、欠落だけを既定化する。既存`app_settings`のJSON値へ保存し、専用tableは持たない。

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
