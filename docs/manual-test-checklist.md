# 実機テスト項目表

## 目的

- Electron 実行時の現行機能を人手で確認するためのチェックリスト
- 現時点で実装済みの UI / 永続化 / ランタイム挙動のみを対象にする

## 更新方針

- ユーザーが触れる挙動を変更した場合は、この項目表を同じ論理変更単位で更新する
- 追加した項目は、実装済み機能の再現手順と期待結果が読める粒度で書く

## 前提

- `npm install` 済み
- 実機確認は Electron で行う
- 起動コマンド:

```bash
npm run electron:start
```

## V5 Character Core Release Gate

| ID | 領域 | 手順 | 期待結果 |
| --- | --- | --- | --- |
| V5C-001 | Character 0 件 fallback | Character catalog が 0 件の状態で Home を起動し、`New Session` と Companion 起動 dialog を開く | 起動導線は SingleMate / Mate 未作成 gate に戻らず、neutral fallback の Character 表示で session / companion を開始できる |
| V5C-002 | Character A / B 登録 | Home の `Characters` から `Create Character` を押し、Character Editor Window で Character A と Character B を作成して name / description / icon / theme / `character.md` を保存する | Home の Characters list に A / B が表示され、Editor Window を開き直しても metadata と `character.md` が保持される |
| V5C-003 | Default Character | Character Editor Window で Character B を default に設定し、Home の `New Session` を開く | Character selector の初期選択が B になり、Character name / icon / theme preview が selector と作成後の session summary に反映される |
| V5C-004 | New Session explicit selection | `New Session` で Character A を明示選択して session を作成する | 作成された Session Window と Home summary は Character A の name / icon / theme を表示し、B へ default を戻しても既存 session の表示は A のまま残る |
| V5C-005 | Companion explicit selection | Companion 起動で Character A / B をそれぞれ選んで companion session を作成する | Companion session summary と Companion Review UI に選択した Character の name / icon / theme が反映される |
| V5C-006 | Snapshot boundary | Character A で session を作成した後、Character Editor Window で Character A の `character.md` を別内容へ変更し、既存 session で 1 turn 実行する | provider prompt は session 作成時点の saved snapshot を使い、現在の catalog 内容へ置き換わらない |
| V5C-007 | Prompt boundary | `character.md` と `character-notes.md` の両方を持つ Character で 1 turn 実行し、Audit Log の `Logical Prompt` / `Transport Payload` を確認する | `character.md` snapshot は system 側に入る。`character-notes.md`、Memory / Growth history、provider instruction sync 由来の Character 書き込みは常設注入されない |
| V5C-008 | Markdown fence boundary | `character.md` に triple backtick と quadruple backtick の code fence を含め、session を作成して 1 turn 実行する | Character Definition Snapshot section の外側 fence が壊れず、definition 全体が 1 つの markdown block として扱われる |
| V5C-009 | Legacy read-only compatibility | V5 Core 前に作られた session、または `source_schema_version < 5` / `legacy_readonly` の session を Home から開く | Home 履歴に `閲覧専用` として残り、Session Window で messages / audit / diff など既存情報を確認できる。send、model 変更、approval 変更、その他永続更新は拒否され、新しい V5 session 作成へ誘導される |
| V5C-010 | Summary performance boundary | Character A / B の `character.md` を大きめにして複数 session / companion session を作り、Home session list と Companion summaries を表示する | summary 表示は `character.md` 本文を読み込む必要がなく、一覧表示で大きな定義本文が UI cache や summary payload に出ない |

## 項目

| ID | 領域 | 手順 | 期待結果 |
| --- | --- | --- | --- |
| MT-001 | Home 起動 | `npm run electron:start` でアプリを起動する | Home Window が表示される |
| MT-001A | Home narrow width guardrail | Home Window を最小幅近くまで縮める | single-column layout へ倒れても `Recent Sessions` と right pane toggle / `Settings` 導線が残り、操作不能にならない |
| MT-002 | Home 一覧 | session が 0 件の状態で起動する | 空状態メッセージが表示される |
| MT-003 | Home Characters panel | Home 右ペインの `Characters` を開く | Character list と `Create Character` が表示され、`Your Mate` tab / panel / `Mate を編集` は出ない |
| MT-003A | Character Editor Window create | Home の `Characters` で `Create Character` を押す | 独立した Character Editor Window が create mode で開き、Profile / `character.md` / `character-notes.md` / Preview を編集できる |
| MT-003B | Character Editor Window edit | Home の Character card または `Edit` を押す | 該当 Character の Editor Window が edit mode で開き、同じ Character を再度開いた場合は既存 window が前面に出る |
| MT-003C | Character editor validation / notes boundary | Character Editor Window で invalid `character.md` と `character-notes.md` を編集する | 保存前 validation issue が読め、`character-notes.md` は runtime prompt に常設注入しない補助メモであることが表示される |
| MT-003D | Character editor archive / dirty close | 既存 Character を編集し、未保存のまま close と archive をそれぞれ試す | close は未保存変更の破棄確認を出し、archive は destructive confirmation を挟む。archive 後は Home list と launch selector から消える |
| MT-004 | Settings Window | Home の `Settings` を押す | 独立した `Settings Window` が開き、保存済み設定の読込完了までは loading が出る。読み込み後は `App` / `Default Microcopy` / `Coding Agent Providers` / `Diagnostics` / `Model Catalog` / `Storage Maintenance` が既存値で表示され、Character editor は出ない |
| MT-004H | Settings window shell layout | `Settings Window` を wide 幅で開き、縦に長い内容まで scroll する | panel は window 幅に追従し、`Home / Close` の header は出ない。本文は inner scroll で最後まで到達でき、scrollbar が shell の角丸に隠れない |
| MT-004A | Settings provider row layout | `Settings Window` を開いて `Coding Agent Providers` を確認する | provider 名が左、checkbox が右の row で揃って見え、どの provider を on/off しているか即判別できる |
| MT-004S | Settings Storage Maintenance | `Settings Window` の `Storage Maintenance` で cutoff date を指定して古い Session 削除を実行する | date input と `Delete` button が既存 Settings の input/button と同じ見た目で表示され、確認後に指定日より前の Session が削除される。実行中 Session は削除されず、feedback に削除件数と skip 件数が表示される |
| MT-004G | Cursor-based window placement | cursor を画面端寄りへ移動してから `Settings Window`、`Session Window`、`Diff Window`、`Session Monitor Window` を新規に開く | `Home Window` 以外の新規 window は cursor がある display 付近に開き、workArea 外へはみ出さない。既に開いている window を再度開いた時は位置を変えず focus だけが前面へ来る |
| MT-004M | Memory V6 diagnostics summary | `Settings Window` の `Diagnostics` を開き、Memory V6 summary を確認する | runtime API status、base URL、DB path、discovery file path、managed `withmate-memory` Skill sync status、CLI Shim status、latest Memory V6 diagnostic errors が read-only で表示される。runtime API secret や discovery document の secret 値は表示されない |
| MT-004M2 | Memory V6 CLI shim management | macOS / Linux の `Settings Window` > `Diagnostics` で `Install CLI Shim` と `Uninstall CLI Shim` を実行する | `~/.local/bin/withmate-memory` と管理 metadata が作成・削除される。既存の非管理 `withmate-memory` は上書き・削除されず、`PATH` に `~/.local/bin` が無い場合は `installed-path-missing` として表示される |
| MT-004N | Memory V6 managed Skill collision | provider の Skill root に user-created の `withmate-memory` folder を置いた状態で Settings を保存し、Diagnostics を再表示する | managed Skill sync は該当 provider を `skipped-collision` として表示し、既存の user-created Skill は上書きされない |
| MT-004O | Memory V6 provider diagnostics | provider capability の診断 state を開発用 fixture または `memory-v6-runtime.test.ts` / `provider-support.test.ts` の targeted test で確認し、Settings Diagnostics の provider support 表示を見る | provider capability は診断 state に反映される。UI は unsupported capability を表示しても runtime API secret や discovery document の secret 値は表示しない |
| MT-004P | Login startup background launch | Settings の `PC 起動時に WithMate をバックグラウンドで起動する` を有効化して保存し、OS login item から `--background` 相当で起動する | Boot window / Home window は表示されず、Memory V6 runtime API と discovery file は publish される。Start Menu などから再度起動すると既存 process の Home window が表示・focus され、二重 process にならない |
| MT-007 | Settings save | Session 表示設定または coding provider 設定を変更して `Save Settings` を押す | 保存成功メッセージが表示され、再度開いても保持される |
| MT-008 | Model catalog export | Settings の `Model Catalog` から `Export Models` を押す | catalog JSON が保存される |
| MT-009 | Model catalog import | Settings の `Model Catalog` から `Import Models` を実行する | import 成功メッセージが表示され、active revision が更新される |
| MT-013 | New Session 起動 | Home の `New Session` を押す | launch dialog が開く |
| MT-013A | New Session dialog keyboard | `New Session` dialog を開き、初期 focus、`Tab` / `Shift+Tab`、`Escape`、provider chip の矢印キーを試す | open 時に title input へ focus が入り、focus は dialog 内で循環する。`Escape` で閉じ、provider chip は矢印キーで切り替えられる |
| MT-014 | New Session 作成 | title、workspace、provider、Character を選び `Start New Session` を押す | 選択した Character snapshot を使って Session Window が開き、Home の session 一覧に追加され、選んだ provider で session が作られ、approval 初期値は `安全寄り` になる。Character が 0 件の場合は neutral fallback を使う |
| MT-014A | New Session provider availability | `Coding Agent Providers` で一部 provider を無効化した後に `New Session` を開く | launch dialog の provider 候補には enabled provider だけが出る。0 件なら empty state が出て `Start New Session` は disabled のままになる |
| MT-015 | Session 実行 | Session Window の textarea に入力して送信する | user message が追加され、pending と live activity が表示される |
| MT-015A | Copilot basic turn | provider を `GitHub Copilot` にした session を作成し、text-only の prompt を 1 回送る | assistant response が返り、Session が `idle` へ戻る。添付なしなら Codex と同じ Session UI で 1 turn 完了できる |
| MT-015A1 | Copilot Character prompt separation | provider を `GitHub Copilot` にした Character snapshot 付き session で 1 turn 実行し、その後 `Audit Log` を開く | `Logical Prompt` には選択 Character の `character.md` snapshot が system 側に入り、`Transport Payload` では `session.systemMessage` と `session.send.prompt` が分離して見える |
| MT-015B | Copilot file / folder context | provider を `GitHub Copilot` にした session で workspace 内 file と folder を `@path` で参照して 1 turn 実行する | assistant response が返り、Copilot 側へ file / folder attachment が渡る。workspace 外 path でも session が失敗せず、少なくとも turn 自体は継続できる |
| MT-015C | Copilot image via Image button | provider を `GitHub Copilot` にした session で `Image` ボタンから画像を選んで 1 turn 実行する | `Image` ボタンが利用でき、選んだ画像は Copilot 側へ file attachment として渡される |
| MT-015D | Additional directory allowlist | Session Window の composer toolbar から `Add Directory` で workspace 外ディレクトリを追加し、その配下の file または folder を `@path` で添付して 1 turn 実行する | 追加前は composer preview で workspace 外 path が拒否される。追加後は添付でき、`changed files / diff` の監視対象にも入る |
| MT-015E | Copilot premium requests strip | provider を `GitHub Copilot` にした session を開く | 右 pane の `Latest Command` 下に `Premium Requests` strip が出て、残量が表示される。未取得時は `unavailable` 表示でもよい |
| MT-015F | Copilot context usage details | Copilot session で 1 turn 実行し、右 pane の `Context` を開く | `current / limit / messages / system / conversation / reset` が開いた時だけ表示される。閉じた状態では右 pane の面積をほぼ消費しない |
| MT-015H | Copilot background tasks snapshot | Copilot session で background agent または detached shell を起動する turn を実行する | turn 完了後も right pane に `Tasks` tab が現れ、`agent / shell` の running / completed / failed が見える。Codex session ではこの tab は出ない |
| MT-015I | Codex terminal convergence | Codex session で長めの turn を完了させ、assistant response が表示された直後の Session と Audit Log を確認する | provider の完了後に transport cleanup が遅れても Session は `idle` へ戻り、assistant response と terminal Audit Log が残る |
| MT-016 | Session 実行キャンセル | 実行中に `Cancel` を押す | 実行が止まり、session は `idle` に戻り、Audit Log に `CANCELED` が残る |
| MT-016A | Session cancel forced convergence | 送信直後または provider の応答停止中に `Cancel` を押す | setup / provider が cancel 応答を返さない場合も grace 後に呼び出しと Session 表示は収束する。元処理が生存中の再送は拒否され、実終了後に再送可能になる |
| MT-017 | Approval / Model / Depth | idle 状態の Session Window で approval / model / depth を変更する | approval は `自動実行 / 安全寄り / プロバイダー判断` で表示され、選択値が保存され、再度開いても保持される |
| MT-017A | Copilot approval prompt | provider を `GitHub Copilot`、approval を `プロバイダー判断` にした session で shell または write 承認が必要な turn を実行する | pending bubble 内に approval card が出て、`今回だけ許可 / 拒否` を押すと run が再開される。read-only request では card は出ない |
| MT-017B | Model / Depth change thread continuity | thread を持っている session で 1 turn 実行後、idle 状態で model または depth を変更してから次の turn を送る | 次 turn は既存 thread を新しい model / depth 設定で resume し、直前までの会話履歴を参照できる。provider が stale / incompatible thread を返した場合だけ renderer からの再送なしで同一 turn 内に回復し、user / assistant message と audit log record は 1 件ずつに留まる |
| MT-017C | Stale thread internal retry | provider 側で thread / session not found または expired 相当を再現できる session を用意して 1 turn 送る | renderer からの再送なしで同一 turn 内の internal retry だけが走り、user / assistant message と audit log record は 1 件ずつに留まる。meaningful partial が無い時だけ回復し、回復後は新 thread で継続できる |
| MT-017C1 | Memory V6 retry continuity | Memory V6 runtime が起動している状態で Codex または Copilot session の stale thread internal retry を再現し、retry 後のturn継続、Audit Log、Diagnostics を確認する。runtime API secret の非露出は `session-runtime-service.test.ts` と `copilot-adapter.test.ts` の targeted test でも確認する | renderer からの再送なしで通常turnが継続し、retry後も explicit target の Memory CLI 利用が壊れない。Memory V6 API secret は UI / log / diagnostics に露出しない |
| MT-017C2 | Memory V6 explicit target isolation | Codex または Copilot の session A / B を同時に開き、それぞれのturn中に explicit project path / Character ID / user-global target の search を実行する。target 不一致の entry 取得拒否は `memory-v6-runtime.test.ts` と `memory-v6-service.test.ts` の targeted test でも確認する | session A / B の通常turnとMemory CLI利用が混線しない。CLI は current session / current Character を暗黙解決せず、明示 target の owner / scope 外 entry は取得できない。UI / log / diagnostics に runtime API secret や discovery document の secret 値は露出しない |
| MT-017C3 | Memory V6 lifecycle continuity | Memory V6 runtime が起動している session でturnを完了し、session delete または app quit 後に新規turnやDiagnosticsを確認する。runtime lifecycle は `memory-v6-runtime.test.ts` と `session-runtime-service.test.ts` の targeted test でも確認する | turn終了、session delete、app quit 相当の後も新しい通常turnで explicit target の Memory CLI が使える。runtime API secret や discovery document の secret 値は UI / log / diagnostics に露出しない |
| MT-017D | Copilot elicitation prompt | provider を `GitHub Copilot` にした session で `elicitation.requested` を返す turn を実行する | pending bubble 内に form または URL card が出て、`送信 / 拒否 / 閉じる` が使える。form では required field 未入力時に alert が出て、`accept / decline / cancel` に応じて run が再開または終了する |
| MT-018 | Audit Log | expanded header の `Audit Log` を押す | 1 turn 1 record の監査ログが閲覧でき、approval 表示は provider-neutral wording になる。prompt 表示は `Logical Prompt` と `Transport Payload` に分かれる |
| MT-018C | Audit Log modal keyboard | `Audit Log` を開き、`Tab` / `Shift+Tab` と `Escape` を試す | focus は overlay 内で循環し、`Escape` で閉じる |
| MT-018A | Copilot audit log minimum | Copilot session で 1 turn 実行後に `Audit Log` を開く | `Logical Prompt` と `Transport Payload`、assistant text、provider metadata、bounded raw item summaries が保存される。大きな text payload は preview と truncation metadata になり、operations は command が無い turn では空でもよい |
| MT-018B | Copilot Details / Diff | Copilot session で file 変更を伴う turn を 1 回実行し、assistant bubble 右上の details icon を押す | `Changed Files` は 1 ブロックで default closed、`Run Checks` は即時表示、`operationTimeline` は item ごとに default closed で表示される。差分がある file では `Changed Files` を開いて `Open Diff` から split diff を開ける |
| MT-019 | Diff | artifact の `Open Diff` を押し、必要なら `Open In Window` も押す | inline diff と Diff Window の両方で split diff が開く |
| MT-019A | Diff keyboard scroll | inline diff または `Diff Window` を開き、`Before / After` pane head / body へ focus して矢印キー、`PageUp` / `PageDown`、`Home` / `End` を試す | focus ring が見え、keyboard だけで縦横 scroll できる。左右 pane の同期も崩れない |
| MT-019B | Diff narrow width guardrail | `Diff Window` を最小幅近くまで縮める | `Before / After` が縦 stack に切り替わり、各 pane の横 scroll は維持される。狭幅でも内容を読める |
| MT-020 | Character Profile persistence | Character Editor Window で name / description / icon / theme を編集して保存する | Home card、New Session selector、Editor Window の再読込後表示に同じ値が反映される |
| MT-020A | Character definition persistence | Character Editor Window の `character.md` を編集して保存し、editor を開き直す | `character.md` が保持され、次に作成する session / companion の snapshot に保存後内容が使われる |
| MT-020B | Character notes persistence | Character Editor Window の `character-notes.md` を編集して保存し、editor を開き直す | notes は保持されるが、runtime prompt preview と Audit Log の prompt には常設注入されない |
| MT-020C | Character import replace | Character Editor Window の `character.md` で import / replace を実行する | import 後は保存前 draft として表示され、validation が走り、保存するまで persisted detail は変わらない |
| MT-021 | Character Editor title theme | Home から Character Editor Window を開く | header / active tab / preview swatch に Character theme が限定的に反映され、文字が背景に埋もれない |
| MT-022 | Session theme accent | Session Window を開く | header title、assistant / pending bubble、composer settings、`Send / Cancel`、Details 展開後の artifact block に mate theme の accent が反映され、`user-bubble` は neutral tone を維持する |
| MT-023 | Diff theme accent | Session から Diff を開く | `titlebar / subbar / pane header` に mate theme の薄い accent が反映され、`Before / After` の文字が背景色に埋もれず読める |
| MT-023AA | Theme contrast guard | 極端に明るい / 暗い Character `main` 色をそれぞれ設定し、Home card、Character Editor title、Session title、Diff titlebar を確認する | 前景色は WCAG AA 基準の contrast ratio を満たす dark / light 側へ自動で切り替わり、背景に埋もれない |
| MT-023A | Session wide layout baseline | `1920x1080` 前後の幅で Session Window を開く | 通常 state では左が最上端から `message list + Action Dock`、右が `title handle + Latest Command` の 2 分割で表示され、right pane は下端まで伸びる |
| MT-023B | Session splitter resize | wide desktop 状態で左右境界をドラッグする | message list 面と `Latest Command` pane の幅が追従し、極端に寄せても chat の最小可読幅と右 pane の最小幅を下回らない |
| MT-023C | Session action dock baseline | Session Window を開き、textarea / attachment / skill / approval / model / depth / `Send` の位置関係を見る | これらは message list と同じ左列幅の `Action Dock` にまとまり、expanded 時だけ full editor と設定群が表示される。`File / Folder / Image` は attachment group、`Skill` は別ボタンとして区別される |
| MT-023C1 | Session narrow layout reachability | 幅 `1400px` 前後まで狭めた Session Window を開く | `message list + Action Dock` の塊の下に right pane が縦 stack で残り、`Latest Command` と provider に応じた `Tasks` / `Context` へ到達できる。狭幅でも right pane が失われない |
| MT-023C2 | Session minimum width guardrail | Session Window を最小幅近くまで縮める | `message list + Action Dock` と right pane の縦 stack が維持され、scroll すれば両方へ到達できる。最小幅でも window が不自然に固定されない |
| MT-023D | Session header collapsed state | Session Window を開いて right pane 上端を見る | 通常 state では right pane 上部に title だけの handle が表示され、左列の `message list + Action Dock` は window 最上端から始まる |
| MT-023D1 | Session header expanded state | collapsed handle を押して header を展開する | header が左端まで伸びた full-width strip として表示され、`Rename / Audit Log / Terminal / Delete` が常時見える。`Close` と `More` は出ない |
| MT-023D2 | Session terminal launch | expanded header の `Terminal` を押す | session の `workspacePath` を作業ディレクトリにした外部 terminal が開く |
| MT-023D3 | Session header recollapse | expanded header の title を押す | header が閉じて right pane 上部の title handle に戻る |
| MT-023D4 | Additional directory manage UI | Session Window の composer toolbar を確認し、`Add Directory` と `Dirs` を操作する | `Add Directory` が `Skill` と同じ列に並ぶ。`Dirs` は既定では閉じており、開いた後に現在の許可リストが表示され、provider が `Codex` の時だけ `×` で削除できる |
| MT-023E | Session action dock compact/expand | idle で draft 空の Session Window を開き、draft preview 押下 / `Hide` / textarea focus を試す | 初期状態は compact で、draft preview または textarea focus で expanded に戻り、`Hide` で再度 compact にできる |
| MT-023E1 | Session action dock auto close | Settings で `送信後に Action Dock を自動で閉じる` を ON にした状態で Session Window から通常送信する。続けて OFF にして同じ操作を行う | ON の時は送信直後に `Action Dock` が compact へ戻る。OFF の時は expanded のまま残る。retry banner や picker など force-expanded 条件がある時は ON でも閉じない |
| MT-023F | Session action dock forced expand | retry banner、skill picker、blocked feedback のいずれかが出る状態を作る | その間は `Action Dock` が compact に落ちず、必要な操作要素が隠れない |
| MT-024 | Latest command running state | `command_execution` を含む run を実行する | 右 pane に実行中または直前の command 1 件だけが表示され、raw command、status、source が読める |
| MT-024A | Right pane tab switch | Session Window の右 pane を確認し、`Latest Command` と provider に応じた `Tasks` / `Reasoning` / `Context` 表示を切り替える | Memory 生成や独り言の tab は出ず、current session の command / task / context 観測面だけが表示される |
| MT-025 | Latest command terminal state | completed / failed / canceled の run をそれぞれ確認する | run 完了後も right pane に直近 run の最後の command が残り、status が terminal state に応じて変わる |
| MT-026 | Latest command visibility with assistantText | assistantText streaming と `command_execution` が同時にある run を実行する | pending bubble は本文だけを表示し、right pane は command 1 件だけを表示する。command 一覧が会話本文を押し流さない |
| MT-027 | Latest command pre-command empty state | run 開始直後でまだ `command_execution` が来ていない状態を観察する | pending bubble に実行中 indicator が出て、right pane は `最初の command を待っています。` の empty state を表示する |
| MT-027A | Mate session copy | `Session Copy` を設定した mate で session を開き、pending indicator、retry banner、`Latest Command` empty、`Changed Files` empty、`Context` empty を確認する | 設定した slot だけが差し替わり、`{name}` は mate 名へ置換される。未設定 slot は bland default copy のまま残る |
| MT-027B | Mate session copy variation | 同じ slot に 2 つ以上の候補を入れた mate で SessionWindow を開き直す、または状態を作り直す | 候補から 1 つが選ばれる。表示中に再描画だけで文言が頻繁に入れ替わらない |
| MT-028 | Live progress pending indicator persistence | run 開始直後から assistantText streaming 開始後まで pending bubble を観察する。可能なら本文と right pane が同時に見える run も確認する | 本文が出始めても `runState === "running"` の間は先頭の実行中 indicator が残り、mate 名が取れる時は `<mate名>が…` の形、取れない時は主語なしの一般化表現で表示される。`runState !== "running"` になった時点で indicator が消える |
| MT-029 | Latest command details collapse | command output を伴う run を実行する | right pane では raw command が常時表示され、stdout / stderr 相当は `Details` を開いた時だけ見える |
| MT-030 | Latest command separation | assistant 本文と step 更新が両方ある run を実行する | `assistantText` が pending bubble 本文として表示され、right pane には command 以外の full timeline や `agent_message` 一覧を出さない |
| MT-031 | Latest command risk badge | 削除系 / 書き込み系 / network 系 command を含む run を観察する | right pane に `DELETE / WRITE / NETWORK` の rough risk badge が必要な時だけ出る |
| MT-032 | Latest command last-run fallback | run 完了後に Session を開き直す、または failed / canceled 後の session を再表示する | liveRun が空でも直近 terminal Audit Log から最後の command が復元され、right pane に表示される |
| MT-033 | Latest command error block | provider error または tool error を再現する | `liveRun.errorMessage` が right pane の command card 内 alert として表示され、command 本体と見た目が混線しない |
| MT-034 | Live progress no false step-running on completed-only steps | `assistantText` 未着のまま visible step が全件 `completed` になる run を観察する | pending bubble の実行中 indicator 自体は run 中なら残ってよいが、step 実行中ではない局面で `〜が作業を進めています` へ固定されたり、`コーディングエージェントがステップを実行中` と誤読させる copy にはならず、mate 名ベースまたは一般化 fallback で現在の局面に沿う文言になる |
| MT-035 | Latest command failed without assistantText | `assistantText` 未着のまま failed run を発生させる | pending bubble の実行中表示と right pane の command / error block が競合せず、何が最後の command だったかを読める |
| MT-036 | Message list follow mode | long session で 80px を超えて上へスクロールして読み返し中にする。そのまま新着 assistant message / pending bubble 更新を発生させる。続けて assistantText streaming 中の run も観察する。最後に session を切り替える | 上スクロール中は位置が維持され、追従停止中は `新着あり` または `読み返し中` の導線が出る。follow ON なら assistantText streaming が自然に追従し、session 切替で follow state と新着導線がリセットされる |
| MT-036A | Latest command pane stability | 実行中に複数の step 更新を発生させながら right pane を観察する | right pane は scroll / follow UI を持たず、最新 command 1 件だけに置き換わる。message list の follow 挙動には干渉しない |
| MT-036B | Long session virtualized history | Markdown、code block、artifact を含む 100 件以上の Session を開き、先頭付近まで上下にスクロールしてから末尾へ戻る | `以前のメッセージを読み込む` 操作なしで全履歴へ到達でき、可変高の本文が重なったり欠けたりせず、スクロール位置が大きく跳ねない |
| MT-036C | Long session composer responsiveness | 100 件以上の Session で composer に連続入力し、IME 変換、削除、貼り付けを行う | 入力中に表示済み履歴全体の Markdown が再描画されず、履歴件数に比例した入力遅延が発生しない。入力内容と caret 位置も欠落しない |
| MT-037 | Pending indicator accessibility | screen reader 相当の確認環境または accessibility tree を使い、streaming 中に pending bubble を観察する | pending bubble 全体が token ごとに過剰再通知されず、実行中 indicator の状態変化だけが最小限に扱われる。screen reader 向け文言も visible text と同じ方針で、mate 名ベースまたは一般化 fallback に同期している |
| MT-038 | Retry banner state split | `interrupted` / `error` / user cancel の各状態を作り、composer 上の retry banner を見比べる | interrupted / failed / canceled の識別が badge / title / CTA で維持され、状態別 body 段落なしでも copy が混線しない。collapsed 時でも CTA と draft conflict notice は操作可能で、`running` 中と通常 `idle` では banner が出ない |
| MT-039 | Retry banner canceled truth source | Cancel 完了後に session が `idle` へ戻った状態で composer を確認する | `runState === "idle"` でも最新 terminal Audit Log `phase === "canceled"` を真実源として canceled banner が表示され、通常 idle とは誤判定しない |
| MT-040 | Retry CTA behavior split | retry banner 表示中に `同じ依頼を再送` と `編集して再送` をそれぞれ試す | `同じ依頼を再送` は即時送信されて draft を変えず、`編集して再送` は `lastUserMessage.text` を draft に戻して textarea へ focus するが自動送信しない |
| MT-041 | Retry edit draft protection | retry banner 表示中に別の文面を draft へ入れたまま `編集して再送` を押す | 入力中 draft は silent overwrite されず、composer 内で `今の下書きは残しています。` の短い notice と「置き換える」導線が出る。置き換えを確定した時だけ前回の依頼へ差し替わる |
| MT-042 | Retry banner details toggle default | canceled / failed / interrupted の各 retry banner を初回表示し、`Details` / `Hide` を切り替える | `canceled` は初期 collapsed、failed / `interrupted` は初期 expanded で表示される。toggle で `停止地点` / `前回の依頼` が開閉し、badge / title / CTA は常時残る |
| MT-043 | Retry banner details reset / preserve | retry banner を開閉したまま draft を編集し、その後 session 切替と別 interruption 発生をそれぞれ試す | 同一 retry banner 上の draft 編集や軽微な再描画では open / closed state が維持される。session 切替または retry banner identity（kind / `lastUserMessage` / canceled 判定に使う terminal Audit Log entry）変化時は default 状態へ reset する |
| MT-044 | Retry banner non-regression | retry banner が出る session で message list follow banner、pending indicator persistence、composer layout を確認する | retry banner 追加で不要なスクロールジャンプや composer 崩れが起きず、`新着あり` / `読み返し中` banner と pending indicator の既存挙動も維持される |
| MT-045 | Retry banner no last user message | user message がまだ 0 件の session、または user message を持たない復旧ケースを開く | interrupted / failed / idle+canceled 判定相当でも `lastUserMessage` がなければ retry banner は出ない |
| MT-046 | Session boundary no-bleed after switch | session A で canceled banner または pending / live run を表示したまま、Home か session 一覧から session B へ切り替え、切替直後の composer / message list / Audit Log を確認する | session B では retry banner 判定、`停止地点` summary、pending / live run 表示、Audit Log が session A の値を一瞬も引きずらず、session B 自身の state だけを表示する |
| MT-047 | Composer sendability feedback 統合 | provider 無効化、壊れた `@path`、blank / whitespace draft をそれぞれ作り、composer を確認する | `sessionExecutionBlockedReason` / 添付 error が Send 近傍の単一 feedback area に集約される。blank / whitespace draft は helper 文言を出さず、`Send` disabled だけになる |
| MT-048 | Composer send guard 一致 | blank / whitespace draft のまま Send、`Ctrl+Enter`、`Cmd+Enter` をそれぞれ試し、続けて有効な draft で再試行する | blank / whitespace draft は button と shortcut の両方で送信されず、textarea 内で no-op turn も作られない。有効な draft では button と shortcut の両方で同じ条件で送信できる |
| MT-048A | Composer blocked feedback | blank / whitespace draft、browse-only session、壊れた `@path` など blocked 条件を作り、`Ctrl+Enter` または `Cmd+Enter` を押す | `Action Dock` は expanded を維持し、Send 近傍の inline feedback area に blocked reason が出る。Send button の hover title でも同じ理由を確認できる |
| MT-049 | Running composer priority | `runState === "running"` の間に composer を確認する | composer では `Cancel` が主表示のまま残り、sendability feedback が主表示に割り込まない。retry banner も出ない |
| MT-050 | Attachment chip readability | workspace 内 file / folder / image と workspace 外 path をそれぞれ `@path` で添付し、長い path も含めて composer を確認する | attachment chip が kind、basename、`ワークスペース内` / `ワークスペース外` を見分けやすく表示し、長い path でも basename が先に読める |
| MT-050A | Attachment overflow guardrail | file / folder / image を多数添付した状態で composer を確認する | attachment list は高さ上限つき scroll へ切り替わり、textarea と `Send` が画面外へ押し出されない |
| MT-051 | `@path` send-time validation | 存在する `@path` と存在しない `@path` をそれぞれ textarea に直接入力または paste して Send / `Ctrl+Enter` / `Cmd+Enter` を試す | 入力中に候補 dropdown は出ない。存在する path は送信時に添付として解決され、存在しない path は Send 近傍の feedback に集約されて送信されない。通常の textarea 操作と `Ctrl+Enter` / `Cmd+Enter` 送信は退行しない |
| MT-052 | Home session badge precedence / sort | Home に `status === "running"`、`runState === "running"`、`runState === "interrupted"`、`runState === "error"`、non-active session が混在する状態を作る | `running` が最優先、次に `interrupted`、次に `error`、それ以外は neutral badge で card に残る。card 並びは active state 優先へ再ソートされず、storage 既定の `last_active_at DESC` を保つ |
| MT-053 | Home monitor open session truth source / search sync | 複数 session を用意し、そのうち一部だけ `SessionWindow` を開く。Home 右ペインを `Session Monitor` にして、続けて session search で一部 session だけに絞り込む。open session の active Auxiliary だけを実行中にするケースも確認する | monitor panel は open な `SessionWindow` を持つ session だけを出し、`実行中` と `停止・完了` に分かれる。親 session が待機中でも active Auxiliary が実行中なら `実行中` 側へ入る。`interrupted` / `error` / neutral は `停止・完了` 側へ badge 付きで残る。検索結果から外れた session は `Recent Sessions` card と monitor row の両方から消える |
| MT-054 | Home monitor open / close follow | Home を開いたまま session card から `SessionWindow` を開き、続けて対象 window を閉じる。可能なら複数 session で繰り返す | `SessionWindow` を開いた session は monitor に追加され、閉じた session は monitor から消える。Home 再読み込みなしで右ペイン表示が追従する |
| MT-055 | Home right pane segmented toggle / initial state | Home を起動し、右ペイン上部の切替 UI を確認した後、`Session Monitor` / `Characters` を相互に切り替える | 起動時は `Session Monitor` が選択済みで、right pane には片方だけが表示される。segmented toggle だけで現在選択中が見分けられ、`Characters` 選択時に Character list / Create が出る |
| MT-056 | Home session empty / no-result と monitor empty state | session 0 件の状態で Home を開き、その後 session を作成して `SessionWindow` を開かないケース、さらに search で 0 件になる条件も試す | session 0 件では `Recent Sessions` に空状態メッセージと `New Session` 導線が見える。open な `SessionWindow` が 0 件なら monitor 側は説明文ではなく短い empty state を出す。search 0 件では `一致するセッションはないよ。` が出て、monitor 側も同じ検索条件に追従した no-result 表示になる |
| MT-057 | Home right pane heading dedupe | Home を開いて `Session Monitor` / `Characters` を切り替え、right pane の先頭付近を確認する | active pane は segmented toggle だけで判別でき、pane 内トップに `Session Monitor` / `Characters` の重複 heading は出ない。Characters 側に legacy MateTalk / Mate editor 導線は出ない |
| MT-058 | Home monitor scroll / CSS no-bleed | monitor 対象になる open session を増やして right pane を縦にあふれさせた後、Home でスクロール挙動を確認する。続けて Session Window を開いて pending / retry banner / composer 周辺の既存表示も見る | `SessionMonitor` は right pane 内で自然に縦スクロールし、wrapper 全体が伸び続けない。Home 専用の 2 カラム / right pane toggle / monitor 用 CSS が Session Window へ波及せず、Session 側の既存レイアウトと配色が退行しない |
| MT-058A | Monitor Window open | Home の `Monitor Window` を押す | 細く縦長の `Session Monitor Window` が開き、Home とは独立した window として表示される |
| MT-058B | Monitor Window always-on-top | `Session Monitor Window` を開いたまま別の通常 window を前面に出す | monitor window が最前面を維持し、`Home` button を押すと通常の `Home Window` を前面へ戻せる |
| MT-058C | Monitor Window content parity | open な Session Window を増減しながら `Session Monitor Window` を確認する | Home 右ペインの `Session Monitor` と同じ truth source で追従し、`実行中` / `停止・完了` の 2 section と row click の session open が維持される |
| MT-059 | New Session approval default | Home から `New Session` dialog を開き、新規 session を作成する | session 作成直後の approval 初期値が `safety` で保存され、UI 表示は `安全寄り` になる |
| MT-060 | provider-neutral approval UI | Session Window の composer approval chip、artifact `Run Checks`、`Audit Log` overlay を見比べる | approval がすべて `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording で揃う |
| MT-061 | legacy approval normalize | legacy DB または既存 row に `never / untrusted / on-request / on-failure` を含む session / audit log を読み込む | session approval chip、Audit Log、artifact `Run Checks` がそれぞれ `allow-all / safety / provider-controlled` 相当へ normalize され、表示は provider-neutral wording になる |
| MT-062 | Settings provider empty state | provider 0 件または model catalog 読み込み失敗の状態で `Settings Window` を開く | `Coding Agent Providers` section は消えず、catalog unavailable / no providers の empty state が表示される |
| MT-063 | Skill picker と挿入 | Session Window の composer 上部にある `Skill` を開き、候補を選ぶ | skill 候補が dropdown で表示され、選択すると Codex では `$skill-name`、Copilot では skill directive が composer 先頭へ挿入される |
| MT-064 | Skill picker empty state | skill が 0 件の session で `Skill` を開く | 空状態メッセージが出て、textarea の通常入力や送信導線は固まらない |
| MT-065 | Copilot custom agent picker | provider を `GitHub Copilot` にした session で `Agent` を開き、workspace `.github/agents` または `~/.copilot/agents` にある custom agent を選ぶ | `user-invocable: true` の custom agent だけが dropdown に出る。同名なら workspace が優先され、選択後の turn では Copilot session config に反映される |
| MT-066 | Copilot selected agent visibility | provider を `GitHub Copilot` にした session で custom agent を選択し、composer の `Agent` ボタンを見る | `Agent` ボタン自体が現在値を表示し、`Default Agent` と custom agent 名を見分けられる |
| MT-067 | Window error recovery | Home / Character Editor / Session / Diff のいずれかで renderer render error を再現する | window-level fallback が出て、`再試行` で再描画を試せる。復帰しない場合も `再読み込み` が使える |
| MT-067A | Right pane error recovery | `Session Window` の right pane だけで render error を再現する | pane 専用 fallback が出て、`右ペインを再描画` と `Window を再読み込み` の両方が表示される |
