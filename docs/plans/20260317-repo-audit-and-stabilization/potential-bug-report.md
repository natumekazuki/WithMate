# Potential Bug Report

## 目的

- 今回の `repo audit and stabilization` で本体修正までは入れなかった潜在リスクを、後続 triage 用に整理する。
- 既修正の 3 件（approval 実行中変更、workspace 相対 path 解決、workspace file search 鮮度）は本体論点に含めず、必要最小限の回帰注意だけ残す。
- ここで挙げる項目は、実運用で必ず再現すると断定するものではなく、現行文書・実装の読み合わせから優先監視対象と判断したものに限る。

## 前提

- 観測範囲は `README.md`、`docs/要件定義_叩き.md`、`docs/design/*.md`、`src/`、`src-electron/`、`docs/plans/20260317-repo-audit-and-stabilization/repo-audit.md`。
- 実運用 DB の中身、外部 provider の実接続状態、長期運用での実測障害件数は今回の根拠に含めていない。
- 既修正 3 件については、`docs/manual-test-checklist.md` と追加 test を維持し、回帰監視対象として継続する。

---

## PB-001

- **ID**: PB-001
- **優先度**: 高
- **タイトル**: character 未解決 session の続行不可方針が未反映
- **症状 / 想定影響**:
  - 既存 session は `characterId / character 名 / icon / theme snapshot` を保持したまま残る一方、実体 character を削除すると次回 turn 実行時にキャラクター解決に失敗する可能性がある。
  - 条件次第では session 一覧上は通常の session に見えても、送信時に `"キャラクター定義が見つからないよ。"` で停止する。
  - 現在の実装では `resolveSessionCharacter()` が `characterId` で見つからない場合に `character.name` で再解決するため、同名 character 再作成時に意図しない別個体へ再接続する余地もある。
  - ユーザー確定方針では、character を解決できない session は **続行不可** であり、許容したいのは **過去ログ / audit / diff の閲覧** のみである。この `browse-only` 相当の扱いが current 実装へまだ反映されていない。
- **発生条件**:
  - session 作成後、その session が参照する character を Character Editor から削除する。
  - その後、該当 session を再開して送信する、または同名 character を別 ID で再作成する。
- **観測根拠**:
  - `src-electron/main.ts:466-477`
    - `deleteCharacter()` は character storage の削除と一覧再読込だけを行い、既存 session の補正や削除抑止をしていない。
  - `src-electron/main.ts:479-489`
    - `resolveSessionCharacter()` は `characterId` 不一致時に `character.name` で再探索する。
  - `src-electron/main.ts:545-548`
    - turn 実行時に character が解決できなければ即エラーになる。
  - `src-electron/session-storage.ts:95-107, 168-217`
    - session row は character snapshot を独立保持しているため、一覧表示だけは継続できる。
- **なぜ今回は未対応か**:
  - 監査時点では削除済み character と session 継続の扱いが未確定で、文書も複数案を比較する段階だったため。
  - 現在はユーザー方針が確定したが、実装と関連 design docs がまだその方針へ揃っていない。
- **推奨対応**:
  1. current milestone の正本仕様として、character 未解決 session は `実行不可 / 閲覧のみ可能` へ固定する。
  2. Home / Session / storage 設計に `browse-only` または `view-only` 相当の状態を追加し、過去ログ / audit / diff は読めるが新規 turn は送れない導線にする。
  3. `name` fallback で別個体へ再接続する挙動は廃止し、`characterId` を解決できない場合は未解決として扱う。
- **検証観点**:
  - 既存 session がある character を削除したときの Home / Session 表示。
  - 削除後 session の reopen、過去ログ閲覧、audit / diff 閲覧、再送抑止。
  - 同名 character を再作成した場合に誤再接続しないこと。
  - 実行中 session での character 削除可否と close / quit 保護との整合。

## PB-002

- **ID**: PB-002
- **優先度**: 高
- **タイトル**: model catalog import 時の自動 migrate 方針が未反映
- **症状 / 想定影響**:
  - current 実装 / 既存文書では session が旧 `catalogRevision` を保持し続ける前提が強く、catalog import 後も revision drift を許容する記述が残っている。
  - ユーザー確定方針では、**model catalog は import 時に自動 migrate する**。そのため、リスクの中心は「旧 revision をどう見せるか」ではなく、「import 時自動 migrate が未反映のまま旧 revision を残し続けること」に移る。
  - 自動 migrate が未実装のままだと、current active catalog と session 側の `catalogRevision` の意味が文書ごとにずれ、import 後の model / depth 解決ルールが読み取りづらくなる。
- **発生条件**:
  - session 作成後に model catalog を import して active revision を切り替える。
  - その後、既存 session を開く、または model / depth を変更せず turn 実行する。
- **観測根拠**:
  - `docs/design/model-catalog.md:89-126`
    - session は `catalogRevision` を保持し、adapter 実行時は session 側 revision を使う設計。
  - `src-electron/main.ts:179-189, 550`
    - provider 解決は `session.catalogRevision` を使う。
  - `src/App.tsx:168-178`
    - renderer は `window.withmate.getModelCatalog(null)` と subscribe で active catalog を取得している。
  - `src/App.tsx:318-349`
    - model option と depth 候補は active catalog 由来の `selectedProviderCatalog` から組み立てている。
  - `src/App.tsx:533-560`
    - model / depth 変更時には session の `catalogRevision` を current active revision へ更新する。
- **なぜ今回は未対応か**:
  - 監査時点では revision drift をどう扱うか自体が open question で、import 時自動 migrate はまだ方針化されていなかった。
  - 現在は方針が確定したが、storage / Session UI / design docs がその前提へ揃っていない。
- **推奨対応**:
  1. import 成功時に既存 session を新 active revision へ自動 migrate する方針を、`model-catalog` と `session-persistence` の正本仕様へ明記する。
  2. `catalogRevision` は「旧 revision を保持し続ける pin」の説明ではなく、「その session に現在反映済みの catalog revision」を示す前提へ整理する。
  3. 実装時は import 処理と session 正規化を同一フローで扱い、部分反映を残さない。
- **検証観点**:
  - import 前後で既存 session の `catalogRevision`、model、depth がどう正規化されるか。
  - import 後に旧 revision 前提の実行経路が残らないこと。
  - active catalog から削除 / 変更された model を持つ既存 session の migration 失敗時導線が定義されていること。

## PB-003

- **ID**: PB-003
- **優先度**: 高
- **タイトル**: Settings ベース provider 設定方針が未反映
- **症状 / 想定影響**:
  - current 実装の Settings は `System Prompt Prefix` と `Model Catalog` import/export が中心で、provider ごとの enable / disable や API キー入力欄を持たない。
  - 監査時点の文書には provider readiness / preflight を must-have とみなす記述が残るが、ユーザー確定方針では **Settings に provider ごとの有効化チェックボックスを置き、enabled provider は使える前提** とする。
  - そのため current の主リスクは「認証状態可視化が弱いこと」そのものよりも、`Settings 主導で provider を有効化する` という仕様と既存文書がずれている点にある。
- **発生条件**:
  - provider を切り替え / 追加する設計を参照する。
  - Settings に provider 有効化や API キー入力を追加する実装タスクへ着手する。
  - provider readiness / preflight を current must-have と誤読したまま後続設計を進める。
- **観測根拠**:
  - `docs/design/monologue-provider-policy.md:17-23, 47-71, 132-177`
    - coding agent plane と monologue plane で auth 前提が異なる。
  - `docs/要件定義_叩き.md:48-54, 420-424`
    - provider 対応範囲と API key / keychain 前提が示されている。
  - `src/HomeApp.tsx:533-565`
    - Settings overlay は `System Prompt Prefix` と model catalog import/export のみ。
  - `src-electron/preload.ts:42-181`
    - provider auth state を取得・更新する IPC API が無い。
  - `docs/plans/20260317-repo-audit-and-stabilization/repo-audit.md`
    - `Provider 認証 / 接続状態の可視化` をズレ項目として整理済み。
- **なぜ今回は未対応か**:
  - 監査時点では credential / readiness / provider split の設計が揺れており、preflight 前提の整理も候補に入っていた。
  - 現在は Settings ベースの最小方針が確定したが、まだ current 実装や design docs の正本へ反映しきれていない。
- **推奨対応**:
  1. Settings の future scope として、provider ごとの enable / disable チェックボックスと API キー入力欄を正本 docs へ追加する。
  2. enabled provider は「実行時にエラーが出るまでは使える前提」とし、current milestone では readiness / preflight を must-have から外す。
  3. provider 実行失敗時のランタイムエラー導線だけは最低限整理し、Settings 起点の有効化方針と矛盾させない。
- **検証観点**:
  - Settings から provider 有効化 / 無効化と API キー入力の導線が読めること。
  - enabled provider を選んだ時、実行前 preflight に依存しない設計として一貫していること。
  - 実行時エラーの扱いが `provider 無効` と `provider 実行失敗` で混同されないこと。

## PB-004

- **ID**: PB-004
- **優先度**: 中
- **タイトル**: artifact summary / diff 欠落を「変更なし」に見誤るリスク
- **症状 / 想定影響**:
  - artifact の `Changed Files` は provider の `file_change` と workspace snapshot 差分から再構成しているが、snapshot にはサイズ・件数・総量上限があるため、実際の変更があっても diff を取り切れない場合がある。
  - 現 UI は `changedFiles.length === 0` のとき「まだファイル変更はないよ。」と表示するため、実際には「検出不能 / 省略 / 上限超過」でも未変更に見える可能性がある。
  - binary や oversize file を伴う作業、巨大 workspace、ignore 対象近傍の作業では、artifact の過少表示が起きる余地がある。
- **発生条件**:
  - 1 MiB 超の file、binary file、大量 file 変更、または snapshot 上限超過が発生する。
  - provider 側 `file_change` だけでは十分な差分が出ず、snapshot 補完にも取りこぼしが出る。
- **観測根拠**:
  - `docs/design/provider-adapter.md:117-144`
    - diff は `turn.items` から直接取れず、Main Process の before / after snapshot 補完を前提にしている。
  - `src-electron/snapshot-ignore.ts:6-8, 23-35, 180-190, 256-260`
    - snapshot は file size / file count / total bytes 上限を持ち、binary / oversize は読み飛ばす。
  - `src-electron/codex-adapter.ts:656-681`
    - artifact は `changedFiles / operationTimeline / runChecks` から組み立て、差分の検出不能理由は保持していない。
  - `src/App.tsx:856-875`
    - file list 0 件時の empty state は「変更なし」に近い表現。
- **なぜ今回は未対応か**:
  - 正しく扱うには snapshot capture stats を artifact / UI / audit に流す必要があり、文言変更だけでは不十分だった。
  - どの程度まで「欠落の可能性」を前面に出すかは UX 設計とも関係する。
- **推奨対応**:
  1. snapshot capture stats を artifact か audit log へ含める。
  2. `変更なし` と `検出上限により省略` を UI で分離する。
  3. oversize / binary / skipped file 数を補助表示する。
  4. 可能なら provider raw items から回収できる file path を追加ヒントとして残す。
- **検証観点**:
  - 2 MiB 超 file 編集時の `Changed Files` と Diff 表示。
  - binary file 追加 / 更新時の empty state 誤認防止。
  - 大規模 workspace で file count / total bytes limit 到達時の警告表示。
  - canceled / failed 時の partial artifact でも欠落理由が残るか。

## PB-005

- **ID**: PB-005
- **優先度**: 中
- **タイトル**: Character Stream 着手条件の未統一による回帰リスク
- **症状 / 想定影響**:
  - current milestone では `Character Stream` を Session UI に出さない整理へ寄っている一方、一部文書には右ペイン前提や縮退表示前提の記述が残っている。
  - 後続実装者が参照文書を取り違えると、pending 期間中に UI を再露出したり、Codex / CopilotCLI の対応完了前に Character Stream 実装へ着手したりする回帰を招きやすい。
  - ユーザー確定方針では、Character Stream の実装開始は **Codex 対応完了**、**CopilotCLI 対応完了**、**両 CLI と SDK 経由でも使える機能の網羅完了** の後である。ここが roadmap と design docs にまだ十分明文化されていない。
- **発生条件**:
  - `Character Stream` 再開系の実装や UI 調整で、正本文書が統一されないまま既存 design docs を参照する。
- **観測根拠**:
  - `docs/design/product-direction.md:23-29, 120-131, 170-184`
    - current milestone では UI に出さない整理。
  - `docs/design/monologue-provider-policy.md:132-177`
    - pending 中は Session UI に表示しない整理。
  - `docs/design/agent-event-ui.md:50-66`
    - 右主面 `Character Stream` を維持する構成が残る。
  - `docs/design/character-chat-ui.md:92-100`
    - pending 中も縮退表示を出す記述が残る。
  - `docs/plans/20260317-repo-audit-and-stabilization/repo-audit.md:133-145`
    - 文書間競合として整理済み。
- **なぜ今回は未対応か**:
  - 今回は bug fix / stabilization と残ドキュメント整備が主眼で、Character Stream 正本統一そのものは別タスクで扱う前提だった。
  - 単純に 1 文書だけ直すと、関連文書の参照関係まで揃わず、半端な更新になる可能性があった。
- **推奨対応**:
  1. current milestone の正本を `product-direction` と `monologue-provider-policy` に寄せ、Character Stream は current milestone 非着手であることを明記する。
  2. `agent-event-ui` と `character-chat-ui` の競合箇所には `historical draft` / `future option` 注記を付け、current 実装説明として読まれないようにする。
  3. roadmap 側で、Character Stream 実装開始条件を `Codex 完了 + CopilotCLI 完了 + CLI / SDK parity 達成 + 関連 docs 更新完了` へ固定する。
- **検証観点**:
  - `Character Stream` に言及する文書を横断し、current milestone の説明が 1 通りに読めるか。
  - manual test checklist と README に pending 扱いが一貫しているか。
  - 後続 PR review で「参照した正本文書」を申告できる状態になっているか。

---

## 回帰注意メモ（今回修正済み）

- approval 実行中変更禁止
- workspace 相対 path link 解決
- workspace file search cache 鮮度

上記 3 件は `19761900fcd2a92fbe4593d49f41df231e663d30` で修正済み。潜在バグ本体ではなく、以後は manual test / test script での回帰監視対象として扱う。

## Triage まとめ

### 直近対応推奨

- **PB-001** 削除済み character を参照する既存 session の不整合
  - session 続行不可に直結するため、browse-only 導線と `name` fallback 廃止を優先したい。
- **PB-002** model catalog import 時の自動 migrate 方針未反映
  - catalog import を使い始めるほど、自動 migrate 前提と current 実装の差が広がるため早めに揃えたい。
- **PB-003** Settings ベース provider 設定方針未反映
  - provider readiness / preflight を must-have と誤読しないよう、Settings 主導の正本仕様を先に固定したい。

### 仕様整理先行

- **PB-005** Character Stream 着手条件の未統一
  - 実装前に `Codex / CopilotCLI / CLI / SDK parity` のゲートを固定しないと、再開タイミングの解釈が割れる可能性が高い。

### roadmap 側へ送る論点

- **PB-002**
  - import 時自動 migrate をどの粒度で session へ反映するか。
- **PB-003**
  - provider enable / disable と API キー入力を、Settings 中心でどの順に整備するか。
- **PB-004**
  - artifact 欠落理由をどのレイヤーで観測可能にするか。
- **PB-005**
  - Character Stream 実装開始を `Codex / CopilotCLI / CLI / SDK parity` 完了後へどう落とし込むか。
