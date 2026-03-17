# Completion Roadmap

## 現在地

### 目的

- `repo audit and stabilization` の完了後、WithMate を「何から詰めるべきか」を優先順と依存関係つきで共有する。
- Character Stream / provider / memory の 3 系統を混線させず、仕様整理・基盤整備・機能拡張を分離する。

### 背景

- 計画初期化: `9f676b9` `docs(plan): 監査計画を初期化`
- 監査レポート: `72e4d88` `docs(audit): 監査レポートを追加`
- bug fix / stabilization: `19761900fcd2a92fbe4593d49f41df231e663d30` `fix(session): 安定化バグを修正`
- 現時点の repo は、`Home / Session / Character Editor / Diff` の desktop 基盤、Codex 中心の session 実行、audit log、artifact summary、model catalog import/export、character CRUD までは成立している。
- 一方で、`PB-001`〜`PB-005` で確定した方針のうち、character 未解決 session の閲覧専用化、catalog import 時自動 migrate、Settings ベース provider 設定、Character Stream 着手条件はまだ実装・文書への反映途上である。

### 依存関係の見取り図

1. **Stabilization 完了**
2. **仕様正本の統一**
3. **Provider / Settings 基盤**
4. **Memory 基盤**
5. **Pending 機能の再開条件確定**
6. **中長期機能拡張**
7. **運用・品質・リリース準備**

### 成果物

- 本文書
- `repo-audit.md`
- `potential-bug-report.md`
- `result.md`

### 検証 / exit criteria

- 現状の到達点と未到達点が、監査結果と矛盾なく読める。
- 後続タスクが「仕様整理」「基盤整備」「機能拡張」のどれかに分類できる。

---

## Stabilization 完了条件

### 目的

- 監査結果と bug fix を「ひとまず安全に次へ渡せる状態」に閉じる。

### 背景

- approval / relative path / file search の 3 件は修正済みだが、最終フェーズとして文書更新、review、回帰確認を揃える必要がある。

### 依存関係

- なし。現行 branch で直近に完結させる。

### 主要タスク

1. `repo-audit.md`、`potential-bug-report.md`、`completion-roadmap.md`、`worklog.md`、`result.md` の整合確認
2. 修正済み 3 件の回帰確認
   - `node --test --import tsx scripts/tests/open-path.test.ts scripts/tests/workspace-file-search.test.ts`
   - `npm run typecheck`
   - `npm run build`
   - `npm run validate:snapshot-ignore`
3. `docs/manual-test-checklist.md` の対象項目が、修正内容とズレていないか確認
4. final review で
   - 監査結果との矛盾がないこと
   - 残論点の分類が妥当であること
   - rollback 候補が最新フェーズを反映していること
   を確認

### 成果物

- final review 済みの計画ハブ一式
- stabilization 終了を示す最終コミット

### 検証 / exit criteria

- 監査で扱った成果物がすべて存在し、相互参照できる。
- 修正済み 3 件の自動検証が再度 pass する。
- quality review で blocking 指摘が残っていない。

---

## 仕様正本の統一

### 目的

- current milestone の説明を 1 通りに固定し、後続実装で参照先が割れない状態を作る。

### 背景

- 監査で、provider scope、Character Stream、session launch、credential まわりに文書間の揺れが見つかった。
- 特に Character Stream は「pending で UI 非表示」と「右面維持 / 縮退表示あり」が混在している。

### 依存関係

- Stabilization 完了

### 主要タスク

#### M1-1. current milestone scope の固定

- **目的**: 「今できること」と「将来やること」を README / design docs で揃える
- **主要タスク**:
  - `README.md`
  - `docs/design/product-direction.md`
  - `docs/design/desktop-ui.md`
  - `docs/design/window-architecture.md`
  - `docs/design/session-launch-ui.md`
  を横断し、provider 露出、launch flow、pending 機能の扱いを統一する
- **成果物**:
  - current milestone scope を示す更新済み文書群
- **exit criteria**:
  - launch 時の provider 露出有無が 1 通りに読める
  - current UI と manual test が一致する

#### M1-2. Character Stream 正本の一本化

- **目的**: Character Stream を「今は pending、再開は条件付き」と明示する
- **主要タスク**:
  - `product-direction` と `monologue-provider-policy` を current milestone 正本候補として固定
  - `agent-event-ui` と `character-chat-ui` の競合箇所を
    - historical draft
    - future option
    - obsolete
    のいずれかに整理
- **成果物**:
  - Character Stream の正本 / 参考文書境界を明記した design docs
- **exit criteria**:
  - current milestone で Session UI に Character Stream を出すか否かが曖昧でない

#### M1-3. 制約の明文化

- **目的**: 後から「未対応をバグと誤認」しにくくする
- **主要タスク**:
  - character 未解決 session は `続行不可 / 閲覧のみ可能` とする future 方針
  - model catalog import 時自動 migrate の確定方針
  - artifact diff の snapshot 制約
  - provider 設定は Settings 主導で行い、enabled provider は runtime error が出るまで使える前提とする方針
  を正本 docs の既知制約として記録
- **成果物**:
  - Known Constraints / Open Questions の更新
- **exit criteria**:
  - 潜在バグと既知制約の境界が文書上で説明できる

---

## Provider / Settings 基盤

### 目的

- provider ごとの有効化と API キー入力を、Settings 中心の最小構成で整える。

### 背景

- 現実装は Codex 中心で成立しているが、Settings はまだ provider enable / disable や API キー入力を持たない。
- ユーザー確定方針では、Settings に provider ごとの有効化チェックボックスを追加し、有効な provider は runtime error が出るまでは利用可能前提で扱う。
- そのため current must-have は readiness / preflight UI ではなく、Settings から provider を構成できることに寄る。

### 依存関係

- 仕様正本の統一

### 主要タスク

#### M2-1. Settings data model の定義

- **目的**: provider 有効化と API キー入力の正本を Settings に置く
- **主要タスク**:
  - provider ごとの enable / disable 状態を持つ設定モデル定義
  - provider ごとの API キー入力項目をどこまで Settings に置くか決める
  - import/export 対象と Settings 内保持項目の境界を整理する
- **成果物**:
  - provider settings spec
  - preload / IPC contract 案
- **exit criteria**:
  - `enabled provider は使える前提` という仕様が Settings のデータモデルで表現できる

#### M2-2. Settings UI の拡張

- **目的**: provider 設定を Home Settings から完結できるようにする
- **主要タスク**:
  - provider ごとの有効化チェックボックス追加
  - API キー入力欄追加
  - 保存 / 反映導線追加
- **成果物**:
  - 更新済み Settings UI
  - manual test 項目
- **exit criteria**:
  - provider 有効化と API キー設定を current UI の入口を壊さずに実行できる

#### M2-3. 実行時エラー導線の最小整理

- **目的**: preflight 前提を増やさずに、失敗時だけ読める状態を作る
- **主要タスク**:
  - provider 無効時の抑止
  - enabled provider 実行時の runtime error 表示整理
  - Session / Settings のどちらで再設定へ戻すか決める
- **成果物**:
  - runtime error handling spec
- **exit criteria**:
  - Settings ベース構成と runtime error 案内が矛盾しない

#### M2-4. adapter 拡張前提の整理

- **目的**: multi-provider 拡張前に責務境界を固める
- **主要タスク**:
  - `provider-adapter.md` の current MVP と future adapter 拡張点を明確化
  - model catalog と provider enable / disable の関係を整理
- **成果物**:
  - 更新済み `provider-adapter.md`
  - adapter extension checklist
- **exit criteria**:
  - Copilot / OpenAI monologue provider を後から足すときの変更点が読み取れる

---

## Memory 基盤

### 目的

- Session 継続性と将来の Character Stream を支える memory 層を、実装可能な最小単位で具体化する。

### 背景

- `memory-architecture.md` と `session-persistence.md` は先行しているが、実装は session / audit / settings / model catalog / character storage までで止まっている。
- memory を実装しないまま Character Stream を再開すると、継続性とコスト制御の両方が曖昧になる。

### 依存関係

- 仕様正本の統一
- provider / settings 基盤の状態モデル

### 主要タスク

#### M3-1. Memory MVP の境界決定

- **目的**: LangGraph 前提を維持するか、段階的導入にするかを決める
- **主要タスク**:
  - `Session Memory` と `Character Memory` の最小保存項目を決める
  - LangGraph checkpointer / Store を MVP から入れるか、前段を SQLite summary で持つか比較
  - monologue 未実装期間でも意味がある session summary を定義
- **成果物**:
  - memory MVP design
  - backend choice memo
- **exit criteria**:
  - 「何を保存し、何をまだ保存しないか」が明文化される

#### M3-2. write / read / degrade 契約の定義

- **目的**: memory 更新失敗時に本体 chat を巻き込まない
- **主要タスク**:
  - turn 完了時の更新契機
  - session 終了時の圧縮契機
  - 読み出し失敗時の fallback
  - audit / debug でどこまで観測するか
  を定義
- **成果物**:
  - failure & degraded behavior spec
  - audit visibility spec
- **exit criteria**:
  - memory 障害時に session run 自体を止めるか、警告付き継続にするか決まっている

#### M3-3. Session Memory 実装

- **目的**: まず session 継続の要約面を作る
- **主要タスク**:
  - storage 層追加
  - turn 後更新
  - session reopen 時の復元
  - manual test / automated test 追加
- **成果物**:
  - Session Memory 実装
  - test / docs
- **exit criteria**:
  - session をまたいで goal / decisions / recent summary を再読できる

#### M3-4. Character Memory 実装

- **目的**: session をまたぐキャラ継続性を分離する
- **主要タスク**:
  - character 単位保存
  - 昇格ルール定義
  - session 閉鎖・節目更新
- **成果物**:
  - Character Memory 実装
  - 昇格ルール文書
- **exit criteria**:
  - 複数 session 間で character 側の継続要素を共有できる

---

## Pending 機能の再開条件

### 目的

- 仕様や基盤が揃う前に pending 機能へ戻って手戻りするのを防ぐ。

### 背景

- Character Stream は価値仮説として重要だが、provider / memory / UI の依存が強い。
- Copilot などの provider 拡張も、診断基盤なしでは reopen しにくい。

### 依存関係

- Provider / Settings 基盤
- Memory 基盤
- 仕様正本の統一

### 主要タスク

#### R1. coding plane parity の完了

- **目的**: Character Stream より先に coding agent 本体の対応範囲を揃える
- **完了条件**:
  - Codex 対応が current target scope で完了している
  - CopilotCLI 対応が current target scope で完了している
  - 両 provider で、CLI / SDK 経由でも使える機能の網羅範囲が明文化されている
  - 上記を前提に `product-direction` / `monologue-provider-policy` / 関連 UI docs が更新済みである
- **成果物**:
  - coding plane parity checklist
  - provider coverage matrix
- **exit criteria**:
  - Character Stream へ進む前提として、coding agent 本体側の対応完了を説明できる

#### R2. Character Stream 実装開始条件

- **目的**: Character Stream を premature に本適用しない
- **実装開始条件**:
  - `R1. coding plane parity の完了` を満たしている
  - current milestone 正本 docs が `non-start / future scope` として整理済みである
  - Character Stream 関連 docs が future scope / historical draft の注記を持ち、current 実装と混同されない
- **成果物**:
  - Character Stream reopen checklist
  - implementation scope draft
- **exit criteria**:
  - `表示だけ先に出す`、`docs だけ current 実装のように見せる` 状態を避けられる

#### R3. richer artifact / memory 連携の再開条件

- **目的**: Session Memory と artifact summary を後から安全に連携できるようにする
- **再開条件**:
  - artifact 欠落理由を観測できる
  - session summary 更新契機が固まっている
  - audit log と duplicated responsibility を整理済み
- **成果物**:
  - artifact-to-memory contract
- **exit criteria**:
  - artifact / audit / memory が同じ情報を別形式で重複保存しすぎない

---

## 中長期機能拡張

### 目的

- 基盤整備後に広げる機能群を、土台が要るものから順に整理する。

### 背景

- WithMate の将来価値は Character Stream、multi-provider、memory continuity、キャラ体験拡張にある。
- ただし現時点では基盤より先に広げると、current UI の説明と実装が再度乖離しやすい。

### 依存関係

- Pending 機能の再開条件を満たすこと

### 主要タスク

#### E1. multi-provider 実装

- **目的**: Codex 以外の coding provider を段階追加する
- **背景**: Character Stream より前に coding plane parity を揃える
- **主要タスク**:
  - CopilotCLI adapter
  - CLI / SDK feature coverage 差分の整理
  - launch / settings / runtime error handling 更新
- **成果物**:
  - provider adapter 拡張
  - provider ごとの test / docs
- **exit criteria**:
  - 少なくとも Codex と CopilotCLI で、定義済み scope の coding session UX 原則を保てる

#### E2. Character Stream 本実装

- **目的**: WithMate 固有価値の第 3 層を成立させる
- **背景**: 現在は pending。着手は `R1` / `R2` 完了後
- **主要タスク**:
  - monologue trigger 実装
  - Session UI 配置確定
  - monologue plane の audit / debug 方針
- **成果物**:
  - Character Stream UI / provider integration
- **exit criteria**:
  - coding agent 本体を邪魔せず、継続的な monologue を表示できる

#### E3. artifact / diff の高度化

- **目的**: CLI parity をより安定させる
- **主要タスク**:
  - snapshot 欠落理由の可視化
  - richer timeline
  - 大規模 diff / binary change の扱い改善
- **成果物**:
  - artifact summary v2
- **exit criteria**:
  - `何が変わったか` を誤認しにくい

#### E4. relationship / memory 体験拡張

- **目的**: キャラクター継続性を WithMate らしい体験へつなぐ
- **主要タスク**:
  - relationship summary
  - character state
  - cross-session continuity UX
- **成果物**:
  - memory-backed character continuity
- **exit criteria**:
  - session を跨いでもキャラ体験に継続感が出る

#### E5. 追加体験拡張

- **目的**: 要件書の中長期項目へ進む
- **候補**:
  - 音声会話
  - マルチキャラクター
  - 感情モデル
- **exit criteria**:
  - 基盤と競合せず、個別機能として計画できる

---

## 運用・品質・リリース準備

### 目的

- 仕様・基盤・機能が揃った後に、継続開発とリリース準備で詰まらない状態を作る。

### 背景

- 現時点でも typecheck / build / snapshot validation / 一部 node test はあるが、provider・memory・Character Stream を含むと検証面の密度が足りない。

### 依存関係

- 各基盤整備と機能拡張の完了

### 主要タスク

#### Q1. 自動検証の拡張

- **主要タスク**:
  - session lifecycle
  - model catalog revision
  - character delete / orphan case
  - provider enable / disable と runtime error handling
  - memory write / read / fallback
  の自動 test 追加
- **成果物**:
  - test suite 拡張
- **exit criteria**:
  - 潜在バグ上位項目に自動回帰検知がある

#### Q2. manual test と運用 runbook 整備

- **主要タスク**:
  - `docs/manual-test-checklist.md` の拡充
  - auth / migration / interrupted recovery / rollback の runbook 作成
- **成果物**:
  - release-ready manual checklist
  - rollback / migration guide
- **exit criteria**:
  - reviewer / test-runner が迷わず手順を実行できる

#### Q3. データ移行と rollback 準備

- **主要タスク**:
  - session schema 変更
  - memory schema 追加
  - provider settings / API key storage 導入
  - model catalog revision 遷移
  の migration / rollback 計画
- **成果物**:
  - migration plan
  - rollback criteria
- **exit criteria**:
  - 破壊的変更の戻し先が release 単位で定義される

#### Q4. 最終リリース準備

- **主要タスク**:
  - package build
  - 初回起動シード確認
  - appData 配下の保存確認
  - ドキュメント入口の最終整備
- **成果物**:
  - release checklist
  - 更新済み README / docs index
- **exit criteria**:
  - 新規環境でもセットアップから主要導線まで再現できる

---

## 優先順サマリ

1. Stabilization 完了
2. 仕様正本の統一
3. Provider / Settings 基盤
4. Memory 基盤
5. Pending 機能の再開条件確定
6. multi-provider / Character Stream / artifact 拡張
7. 運用・品質・リリース準備

## 直近 3 マイルストーンで見ると

- **最優先**: 仕様正本の統一
  - Character Stream、launch provider、Settings 導線の文書競合を止める
- **次点**: Provider / Settings 基盤
  - Settings から provider を有効化できる前提を揃え、将来機能の入口を固定する
- **その次**: Memory 基盤
  - Character Stream 再開の前提であり、継続性の要件達成にも必要
