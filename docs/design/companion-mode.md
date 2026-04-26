# Companion Mode

- 作成日: 2026-04-26
- 対象: WithMate における human-led / branch-based Companion Mode の正式設計
- supporting doc: `docs/CompanionModeQuestions.md`

## Goal

Companion Mode は、AI に user workspace を直接編集させるのではなく、Git repo root から分離した companion branch / shadow worktree 上で提案作業を進め、user が選択した file だけを target branch へ明示的に merge する作業モードである。

Agent Mode は実行中 session を中心にした direct session 体験として残し、Companion Mode は IDE 主体の作業を崩さずに、相談、提案、review、選択 file merge を行う体験として追加する。

## Position

- Companion Mode の正式な設計方針はこの文書を正本とする
- Companion Mode の検討過程と詳細論点は `docs/CompanionModeQuestions.md` を参照する
- coding agent 全体の方針は `docs/design/product-direction.md` を参照する
- window 責務分離は `docs/design/window-architecture.md` を参照する
- session lifecycle は `docs/design/session-run-lifecycle.md` を参照する
- provider 実行境界は `docs/design/provider-adapter.md` を参照する
- DB current schema は `docs/design/database-schema.md` を参照する

## Boundary

この文書が決めるもの:

- Companion Mode の作業単位
- 起動導線
- Git repo root 制約
- CompanionGroup / CompanionSession の lifecycle
- snapshot / branch / shadow worktree の扱い
- file 選択式 merge の方針
- Companion Review Window の責務
- DB 永続化方針
- provider approval / sandbox 境界
- close / quit / recovery 方針
- MVP の対象外

この文書がまだ決めないもの:

- 具体的な DB migration
- 具体的な Git command 列
- UI mock の最終 layout
- required checks / CI integration
- hunk 単位 merge

## Terms

| Term | Meaning |
| --- | --- |
| `CompanionGroup` | Git repo root 単位の親。複数の CompanionSession を持つ |
| `CompanionSession` | 1 chat / 1 companion branch / 1 shadow worktree の作業単位 |
| `Companion Window` | Companion chat と実行状態を見る window |
| `Companion Review Window` | changed files を review し、merge / discard 判断をする window |
| `companion branch` | CompanionSession の作業 branch |
| `shadow worktree` | AI と user 手修正が作業する隔離 worktree |
| `target branch` | selected files を squash merge / patch apply 相当で反映する先 |
| `focus path` | repo root 配下で user が主に作業している sub directory |
| `change set` | base snapshot と companion branch の現在差分 |
| `selected files` | merge 対象として checkbox 選択された file |

UI では `apply` と `proposal` を避け、`merge`、`discard`、`changed files`、`selected files` を使う。

## Core Decisions

- Companion は Git repo root を対象にする
- Agent Mode は任意 directory 起動のまま残す
- Companion 起動時に Git root を解決し、必要なら元 directory を `focus path` として保持する
- 1 repo root に 1 CompanionGroup を持つ
- 1 CompanionGroup に複数 CompanionSession を持てる
- 1 CompanionSession は 1 companion branch と 1 shadow worktree を持つ
- CompanionSession の寿命は `merge` または `discard` で終端する
- merge / discard 完了後、対象 companion branch と shadow worktree は削除する
- target branch には Companion 側の細かい Git 履歴を持ち込まない
- target branch へは checkbox で選択した file だけを squash merge / patch apply 相当で反映する
- hunk 単位 merge は MVP では扱わない
- Companion から Agent を開く導線は持たない
- MemoryGeneration は今回の Companion MVP 対象外とする

## Launch Model

Companion の起動導線は 3 種類とする。

1. 既存 Session 起動画面の `Agent / Companion` toggle
2. AgentMode の Session 画面 header の `Start Companion` / `Open in Companion` 相当ボタン
3. CompanionList からの `New Companion`

### Session 起動画面

既存 Session 起動画面に `Agent / Companion` toggle を追加する。

- `Agent` 選択時は既存 Agent session 起動を使う
- `Companion` 選択時は Git repo root eligibility を確認する
- Git repo root が解決できれば CompanionSession を作る

### AgentMode Header

AgentMode の Session 画面 header に Companion 起動ボタンを置く。

- Agent workspace から Git root を解決する
- Git root が解決できる場合、Companion は repo root を対象に起動する
- Agent workspace が repo root 配下の sub directory の場合、その path を `focus path` として渡す
- Agent conversation は必要に応じて summary / selected context として渡す
- Agent から Companion への起動は補助導線であり、主導線は Session 起動画面の toggle とする

### CompanionList

CompanionGroup list / CompanionSession list に `New Companion` を置く。

- 同一 repo root / target branch / group context を引き継ぐ
- provider / model / approval / sandbox / character は既定値または直近 session から引き継ぐ
- active CompanionSession がある場合、同一 group の存在を必ず認識できる list を表示する

## Eligibility

Companion は Git repo root を対象にする。

開始可能:

- Git root が解決できる
- HEAD が存在する
- target branch が決まっている
- dirty workspace
- untracked file あり

開始不可:

- Git root が解決できない
- HEAD が存在しない
- detached HEAD で target branch を決められない
- bare repo
- snapshot 作成に必要な Git command が失敗する

warning:

- submodule dirty
- LFS object missing
- symlink / file mode の OS 制約
- 既存 active CompanionSession がある

## Data Model Policy

Companion は既存 `sessions` table に相乗りしない。専用 table 群として分離し、UI / service 層で Agent session と統合表示する。

候補 table:

| Table | Purpose |
| --- | --- |
| `companion_groups` | repo root 単位の親 |
| `companion_sessions` | 1 CompanionSession の正本 |
| `companion_messages` | Companion conversation の message 履歴 |
| `companion_snapshots` | base snapshot / target snapshot の metadata |
| `companion_change_sets` | CompanionSession の現在差分 summary |
| `companion_changed_files` | changed file metadata と selected state |
| `companion_checks` | test / lint / build / command result |
| `companion_merge_runs` | merge / discard の履歴 |
| `companion_sibling_checks` | sibling CompanionSession への影響 check |
| `companion_events` | UI 復元や監査に必要な event |

DB 方針:

- render-critical な一覧、message、changed file、check、event は row として保存する
- JSON blob に conversation や stream を丸ごと持たない
- UI は最新から必要件数だけ cursor / limit で読み込めるようにする
- full diff 本文、raw command log、provider raw event は hot path に載せない
- 大きい payload は上限、圧縮、外部 file 化のいずれかを検討する

## Snapshot Policy

CompanionSession の初回に base snapshot を固定する。

- snapshot 固定は CompanionSession 作成時、または初回依頼送信直前に 1 回だけ行う
- 2 turn 目以降は user workspace を自動で再 snapshot しない
- 2 turn 目以降の AI 作業は、同じ shadow worktree / companion branch 上で継続する
- user workspace や target branch の更新を取り込みたい場合は、明示的な `Sync Target` / `Rebase From Target` 操作として扱う
- sync / rebase は conflict check を伴い、conflict した場合は CompanionSession 内で解消させる

dirty workspace の扱い:

- tracked staged change を含める
- tracked unstaged change を含める
- tracked delete を含める
- untracked file を含める
- ignored file は含めない
- ignored 以外の binary / large / secret っぽい file も含める

除外したい file は repo 側の ignore 設定で制御する。

## Snapshot Implementation Model

snapshot は Git object と app 専用 internal ref で表現する。

- user の通常 branch へ temp commit を積まない
- snapshot commit は `refs/withmate/companion/snapshots/<snapshotId>` に保持する
- snapshot commit の parent は snapshot 時点の HEAD とする
- snapshot commit の author / committer は app 内部 commit と分かる値にする
- CompanionSession 用 branch は snapshot commit から作る
- CompanionSession 用 branch は merge / discard 完了時に削除する

snapshot commit 作成時は user の index / staging state を変更しない。

- temporary index を使う
- HEAD の tree を temporary index に読み込む
- working tree の ignored 以外の状態を temporary index に反映する
- temporary index から tree を作る
- その tree を snapshot commit にする
- staged / unstaged の区別は snapshot commit には保持しない

## Branch / Ref / Worktree Naming

branch / ref / worktree 名は DB の ID から safe id で生成する。user 入力の title や自由文字列を直接入れない。

命名候補:

- companion branch: `withmate/companion/<sessionId>`
- snapshot ref: `refs/withmate/companion/snapshots/<snapshotId>`
- temporary integration ref: `refs/withmate/companion/tmp/integration/<operationId>`
- temporary sibling check ref: `refs/withmate/companion/tmp/sibling-check/<operationId>`
- worktree path: `<app-data>/companion-worktrees/<groupId>/<sessionId>`

管理ルール:

- Companion が作った branch / ref / worktree には DB record を必ず対応させる
- DB record がないものは orphan 候補として maintenance に出す
- 同名 branch / ref / worktree が既にある場合は作成を止める
- cleanup は命名規則に一致し、DB 上で削除対象と判断できるものだけを削除する

## Shadow Worktree Lifecycle

1 CompanionSession ごとに 1 shadow worktree を作る。

- CompanionGroup は shadow worktree の親 directory / registry を持つ
- turn ごとに shadow worktree を作り直さない
- 複数 turn の AI 作業は同じ shadow worktree / companion branch 上で継続する
- user は `Open Companion Worktree` から IDE で shadow worktree を開き、手修正できる
- merge / discard 完了後、shadow worktree と companion branch を削除する

## Special Git Objects

Git 特有の file type / mode は Git の表現を尊重する。

- submodule は親 repo では gitlink として扱い、内部へ再帰しない
- submodule 内部の変更は親 CompanionSession の snapshot 対象にしない
- submodule 自体を作業したい場合は、その submodule repo root で別 CompanionGroup として起動する
- Git LFS は Git の clean / smudge filter に任せる
- Companion は LFS object を独自に fetch / decode しない
- symlink と file mode change は Git diff として扱う
- OS / filesystem 制約で symlink や file mode を再現できない場合は warning を出す

## Provider / Approval Boundary

Companion UI に approval / sandbox の権限設定を置く。

- 権限設定は current session と同様に user が選ぶ
- WithMate は prompt で AI の操作を細かく縛るルールを追加しない
- provider 実行の許可範囲は user が選んだ approval / sandbox policy に従う
- provider 実行 cwd は CompanionSession の shadow worktree を基本にする

WithMate 管理操作は provider に自由実行させず、Main Process 側の Companion lifecycle service が実行する。

- snapshot ref 作成
- companion branch 作成 / 削除
- shadow worktree 作成 / 削除
- temporary integration / check ref 作成 / 削除
- target branch への selected files merge
- discard
- cleanup

## Companion Review Window

Companion 用の review 画面は current UI の拡張ではなく、新規 UI として設計する。

既存 `Diff Window` は pure diff viewer として残し、Companion の merge / discard 判断は `Companion Review Window` が担う。

MVP の表示要素:

- session header
- CompanionGroup / sibling CompanionSession list
- changed file list
- file ごとの merge 対象 checkbox
- split diff
- merge readiness
- target branch drift
- target worktree dirty
- merge simulation result
- sibling check result
- latest checks / tests
- conflict / binary / large / deleted / mode change の状態

actions:

- `Merge Selected Files`
- `Discard Companion`
- `Open Companion Worktree`
- `Sync Target`
- `Rebase From Target`
- `Run Checks`
- `Retry Merge`

MVP に入れないもの:

- hunk 単位 merge
- full merge conflict editor
- sibling CompanionSession の自動修正
- Companion から Agent を開く導線
- MemoryGeneration

## Merge Policy

target branch への反映は selected files のみとする。

- changed file list に checkbox を置く
- user が選んだ file だけを merge 対象にする
- default selected state は UI で検討する
- selected files のみ squash merge / patch apply 相当で target branch へ反映する
- Companion branch の commit history は target branch に持ち込まない
- unselected files は target branch に反映しない
- merge 完了時に CompanionSession を閉じる場合、unselected files は破棄対象として明示する

merge flow:

1. group-level lock を取得する
2. target branch / target worktree 状態を確認する
3. temporary integration ref を作る
4. selected files の差分だけを temporary integration 上へ適用する
5. conflict check を行う
6. conflict がなければ target branch へ同じ selected files 差分を反映する
7. sibling CompanionSession への影響を check する
8. selected CompanionSession を merged history にする
9. companion branch / shadow worktree / temporary refs を cleanup する

merge blocker:

- target branch との merge conflict
- target worktree dirty
- CompanionSession lifecycle error
- Git state の不整合が merge 結果に影響する場合

checks failed / stale / missing は warning とし、MVP ではそれだけで merge を完全ブロックしない。

## Sibling Check

同じ CompanionGroup の active CompanionSession は、選択 session の merge 後に影響 check を受ける。

- sibling check は selected CompanionSession の merge 完了を妨げない
- conflict した sibling CompanionSession に warning を紐づける
- user は該当 sibling CompanionSession 上で target 更新分との conflict を解消する

## Discard Policy

discard は CompanionSession の提案を採用しない終了操作である。

- user workspace と target branch へ変更を反映しない
- discard 前に確認を出す
- discard 完了後、shadow worktree と companion branch を削除する
- discard result は read-only history として残す

## Checks / Command Result

表示情報は current Session と概ね揃える。

- Latest Command を表示する
- Copilot Tasks は UI を検討した上で表示対象にする
- 独り言 UI は Companion では表示しない
- MemoryGeneration は Companion では対象外
- raw log は必要時のみ details で遅延ロードする

Companion Review Window では latest checks を merge readiness の一部として表示する。

- passed: positive 表示
- failed: warning
- stale: 再実行を促す
- missing: warning または neutral

checks は companion branch の commit / state に紐づけ、branch 更新後は stale として扱う。

## Persistence / History

merged / discarded CompanionSession は read-only history として残す。

残すもの:

- title
- status
- target branch
- changed file summary
- selected files summary
- checks summary
- merge / discard result
- 日時
- sibling warning
- optional external patch artifact ref

残さないもの:

- active worktree
- companion branch
- provider raw stream
- full diff 本文の hot path 保存
- raw command log の hot path 保存

同じ作業を再開したい場合は、新しい CompanionSession を作る。`New Companion From History` は future とする。

## Locking

lock は CompanionSession 単位と CompanionGroup 単位に分ける。

session-level lock:

- AI turn
- provider streaming
- provider approval 待ち
- session-local command execution

group-level lock:

- `Merge Selected Files`
- `Sync Target`
- `Rebase From Target`
- sibling conflict check
- temporary integration / check ref 作成
- group cleanup / maintenance

同じ CompanionGroup 内で group-level operation は同時に 1 つだけ実行する。group-level lock 中でも閲覧や chat 入力の下書きは許可する。

## Close / Quit / Recovery

Companion Window を閉じても CompanionSession は削除しない。

- idle: window だけ閉じ、CompanionSession は active のまま残す
- AI running: 確認 dialog を出し、window close 後も Main Process 側で継続可能にする
- conflict / error: status を DB に残し、再表示時に復元する

app quit:

- running operation が無ければ、active CompanionSession があっても quit 可能
- AI running なら確認 dialog を出す
- merge / sync / cleanup 中なら quit を止めるか、完了待ちを促す

startup reconciliation:

- DB の active CompanionSession を読む
- companion branch の存在を確認する
- shadow worktree の存在を確認する
- snapshot ref の存在を確認する
- temporary integration / check ref の残存を確認する
- DB にあるが実体がない場合は recovery required
- DB にないが実体がある場合は orphan として maintenance 対象

## Agent Mode Interop

Agent Mode から Companion Mode への起動は補助導線として持つ。

- Agent workspace から Git root を解決する
- Companion は repo root を対象に起動する
- Agent workspace は `focus path` として保持する
- provider / model / reasoning / approval / sandbox / allowed additional directories / character を引き継ぐ
- Agent conversation は全件コピーせず、summary / selected context として渡す
- CompanionSession の lifecycle は新規に開始する

Companion から Agent を開く導線は MVP では持たない。

## Out Of Scope

今回の Companion MVP では次を扱わない。

- hunk 単位 merge
- full merge conflict editor
- required checks / CI integration
- MemoryGeneration
- monologue / character reflection UI
- Companion から Agent を開く導線
- `New Companion From History`
- submodule 内部への再帰作業

## Future

- hunk 単位 merge
- project ごとの required checks
- check command preset
- CI integration
- merged CompanionSession から Project Memory candidate 生成
- external patch artifact の retention policy
- richer sibling conflict visualization
