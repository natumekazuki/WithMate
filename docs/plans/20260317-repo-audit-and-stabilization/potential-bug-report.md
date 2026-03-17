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
- **タイトル**: 削除済み character を参照する既存 session の不整合
- **症状 / 想定影響**:
  - 既存 session は `characterId / character 名 / icon / theme snapshot` を保持したまま残る一方、実体 character を削除すると次回 turn 実行時にキャラクター解決に失敗する可能性がある。
  - 条件次第では session 一覧上は通常の session に見えても、送信時に `"キャラクター定義が見つからないよ。"` で停止する。
  - `resolveSessionCharacter()` が `characterId` で見つからない場合に `character.name` で再解決するため、同名キャラクター再作成時に意図しない別個体へ再接続する余地もある。
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
  - 「character 削除時に session をどう扱うか」が仕様未確定だったため。
  - 選択肢として、削除禁止、session 側へ tombstone 化、別 character への再割当、role snapshot 完全保持など複数案があり、表面バグ修正だけでは決め切れない。
- **推奨対応**:
  1. current milestone の正本仕様として、`character 削除` と `既存 session 継続` の整合ルールを固定する。
  2. 実装方針は少なくとも次のいずれかに寄せる。
     - 参照中 session がある character は削除前に警告し、削除を抑止する。
     - session 作成時に role snapshot を保持し、元 character 削除後も session 実行は継続可能にする。
     - session を `orphaned character` 状態へ遷移させ、再割当 UI を出す。
  3. `name` fallback で別個体へ紐づく挙動は、仕様として許容しない限り停止または明示再選択へ変える。
- **検証観点**:
  - 既存 session がある character を削除したときの Home / Session 表示。
  - 削除後 session の reopen、再送、rename、delete。
  - 同名 character を再作成した場合に誤再接続しないこと。
  - 実行中 session での character 削除可否と close / quit 保護との整合。

## PB-002

- **ID**: PB-002
- **優先度**: 高
- **タイトル**: model catalog revision drift による UI と実行解決の乖離
- **症状 / 想定影響**:
  - session は `catalogRevision` を保持している一方、Session Window は active catalog を購読して model / depth 候補を描画しているため、旧 revision session を開いた時に「見えている候補」と「実際に turn 実行時に参照される revision」がずれる可能性がある。
  - catalog import 後、既存 session は旧 revision のまま実行できるが、UI 上は active revision ベースの選択肢へ寄るため、利用者には revision pin 状態が見えにくい。
  - model / depth を触った瞬間に session が active revision へ移る設計自体は文書化されているが、その境目が UI から読み取りづらい。
- **発生条件**:
  - session 作成後に model catalog を import して active revision を切り替える。
  - その後、旧 revision を保持した既存 session を開く。
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
  - 実害は UI 認知と migration ルールにまたがるため、単純なバグ修正よりも revision UX の整理が先と判断した。
  - 「旧 revision を pin 表示するか」「常に migrate を促すか」「変更前後差分を見せるか」は仕様決めが必要。
- **推奨対応**:
  1. Session Window に `session catalog revision` と `active revision` の差分状態を可視化する。
  2. 既存 session 表示は active catalog だけでなく、必要に応じて `selectedSession.catalogRevision` の snapshot も読めるようにする。
  3. revision drift のときに選べる操作を明確化する。
     - 旧 revision のまま続行
     - active revision へ migrate
     - 互換対象が消えている場合の警告
  4. model / depth 変更時の revision 切替は UI 文言で明示する。
- **検証観点**:
  - import 前後で既存 session の model / depth 表示がどう変わるか。
  - 旧 revision のまま送信した時と、model 変更後に送信した時で解決結果が想定どおり切り替わるか。
  - active catalog から削除された model を持つ既存 session の表示とエラー導線。

## PB-003

- **ID**: PB-003
- **優先度**: 高
- **タイトル**: provider 認証状態が UI から不可視
- **症状 / 想定影響**:
  - 現行 milestone では Codex 中心実装でも、利用者が「実行前に provider が使える状態か」を確認する面が薄い。
  - 将来の `Character Stream` では OpenAI API key、要件書では Copilot まで視野に入っており、provider ごとに認証前提が違うが、状態診断 UI が存在しない。
  - 認証切れや未設定は送信後の失敗としてしか見えず、セットアップ不備と実行エラーの切り分けが難しくなる。
- **発生条件**:
  - Codex CLI が未 login / 期限切れ / 利用不能の状態で session を実行する。
  - 将来の OpenAI API key 未設定状態で Character Stream を再開する。
  - multi-provider 化の途中で provider ごとの readiness 判定が混在する。
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
  - current milestone では credential storage 自体が未実装で、Codex / OpenAI / Copilot を同じ基盤で扱う仕様も未確定だった。
  - 表面修正だけで UI を足すと、後で provider split 方針と衝突する可能性が高い。
- **推奨対応**:
  1. provider ごとの readiness state を定義する。
     - 例: `ready / login-required / key-required / unavailable / error`
  2. Settings か Session Header のどちらを正本導線にするか決め、状態表示と再設定導線を追加する。
  3. credential 保存方針を明文化し、平文保存を避ける。
  4. turn 実行前 preflight と、失敗時の診断メッセージを分ける。
- **検証観点**:
  - Codex 未 login 状態での起動時表示と実行時表示。
  - provider 切替や future provider 追加時に状態モデルを再利用できるか。
  - API key 未設定 / 無効 / 期限切れ / ネットワーク不通の区別が UI 上で読めるか。

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
- **タイトル**: Character Stream 文書競合由来の回帰リスク
- **症状 / 想定影響**:
  - current milestone では `Character Stream` を Session UI に出さない整理へ寄っている一方、一部文書には右ペイン前提や縮退表示前提の記述が残っている。
  - 後続実装者が参照文書を取り違えると、pending 期間中に UI を再露出したり、auth / memory 未整備のまま実装を再開したりする回帰を招きやすい。
  - provider / memory / UI の再開条件が揃わないまま進むと、coding agent 本体と monologue plane を混線させる可能性がある。
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
  1. current milestone の正本を `product-direction` と `monologue-provider-policy` に寄せるか、別の master doc を立てるか決める。
  2. 競合する文書には `historical draft` / `future option` / `obsolete` の注記を付ける。
  3. Character Stream 再開条件を roadmap 側で明示し、auth・memory・UI を同時に満たすまで本適用しない。
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
  - session 継続不可に直結しやすく、仕様未確定でも最低限の保護方針を早めに決めたい。
- **PB-002** model catalog revision drift
  - catalog import を使い始めるほど UI と実行の認知差が広がるため、revision pin / migrate の可視化を優先したい。
- **PB-003** provider 認証状態不可視
  - current milestone の Codex 診断にも効き、将来の Character Stream / multi-provider 基盤にも直結する。

### 仕様整理先行

- **PB-005** Character Stream 文書競合由来の回帰リスク
  - 実装前に正本を固定しないと、作業者ごとに解釈が割れる可能性が高い。
- **PB-001** のうち character 削除ポリシー
  - bug としての表面対処は可能でも、最終的には session と character の責務整理が必要。

### roadmap 側へ送る論点

- **PB-002**
  - revision 固定 session をどう migrate させるか。
- **PB-003**
  - provider readiness / credential storage / settings 導線をどの順で整備するか。
- **PB-004**
  - artifact 欠落理由をどのレイヤーで観測可能にするか。
- **PB-005**
  - Character Stream 再開条件を provider / memory / UI のどれが満たされた時点に置くか。
