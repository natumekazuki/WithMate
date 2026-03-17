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
- 一方で、provider scope、credential、memory、Character Stream の current milestone 定義はまだ整理途上。

### 依存関係の見取り図

1. **Stabilization 完了**
2. **仕様正本の統一**
3. **Provider / Credential 基盤**
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
  - model catalog revision drift の現仕様
  - artifact diff の snapshot 制約
  - character 削除と session 継続の open question
  を正本 docs の既知制約として記録
- **成果物**:
  - Known Constraints / Open Questions の更新
- **exit criteria**:
  - 潜在バグと既知制約の境界が文書上で説明できる

---

## Provider / Credential 基盤

### 目的

- provider ごとの実行前提と credential 管理を、UI・Main Process・storage の共通基盤として整える。

### 背景

- 現実装は Codex 中心で成立しているが、auth state は不可視。
- Character Stream は OpenAI API を前提にしており、要件書では Copilot も視野に入っている。
- 今のままでは provider 拡張前に診断面が先に破綻しやすい。

### 依存関係

- 仕様正本の統一

### 主要タスク

#### M2-1. provider readiness state の定義

- **目的**: 実行前診断の共通語彙を作る
- **主要タスク**:
  - `ready / login-required / key-required / unavailable / error` などの状態モデル定義
  - provider ごとの判定責務を main process に寄せる
- **成果物**:
  - provider readiness spec
  - preload / IPC contract 案
- **exit criteria**:
  - Codex、future OpenAI API、future Copilot を同じ状態モデルで表現できる

#### M2-2. credential 保存方針の確定

- **目的**: 認証情報の扱いを後付けではなく基盤として固定する
- **主要タスク**:
  - OS keychain / secure storage の候補比較
  - 平文保存禁止方針の決定
  - import/export 対象から credential を切り分け
- **成果物**:
  - credential storage design
  - migration / reset 方針
- **exit criteria**:
  - 保存場所、暗号化方針、消去方法が説明できる

#### M2-3. UI 診断導線の実装

- **目的**: 「送るまで分からない」を避ける
- **主要タスク**:
  - Home Settings か Session Header に auth 状態表示を追加
  - preflight check と run-time error の文言を分離
  - 再認証 / 再設定導線を置く
- **成果物**:
  - provider diagnostics UI
  - manual test 項目
  - 失敗パターン別の表示仕様
- **exit criteria**:
  - auth 未完了時に、送信前に不足が分かる
  - 実行失敗時に auth 不備と provider 側エラーを切り分けて案内できる

#### M2-4. adapter 拡張前提の整理

- **目的**: multi-provider 拡張前に責務境界を固める
- **主要タスク**:
  - `provider-adapter.md` の current MVP と future adapter 拡張点を明確化
  - model catalog と provider readiness の関係を整理
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
- provider / credential 基盤の状態モデル

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

- Provider / Credential 基盤
- Memory 基盤
- 仕様正本の統一

### 主要タスク

#### R1. Character Stream 再開条件

- **目的**: Character Stream を premature に本適用しない
- **再開条件**:
  - current milestone 正本が統一済み
  - OpenAI API key / auth 導線がある
  - Session Memory / Character Memory の最低限がある
  - pending 中の縮退表示を出すか、完全非表示を維持するかが決定済み
  - monologue 実行失敗時の degraded UX が定義済み
- **成果物**:
  - reopen checklist
  - implementation scope
- **exit criteria**:
  - 「表示だけ先に出す」状態を避けられる

#### R2. Copilot provider 再開条件

- **目的**: provider 追加を単発実装で終わらせない
- **再開条件**:
  - provider readiness state が実装済み
  - adapter extension point が明文化済み
  - model catalog に provider 追加時の import/export 仕様が固まっている
  - セットアップ / login 診断の manual test が書ける
- **成果物**:
  - Copilot feasibility / scope doc
- **exit criteria**:
  - `要件に書いてある` だけでなく、着手条件が measurable になっている

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

#### E1. Character Stream 本実装

- **目的**: WithMate 固有価値の第 3 層を成立させる
- **背景**: 現在は pending
- **主要タスク**:
  - monologue trigger 実装
  - Session UI 配置確定
  - monologue plane の audit / debug 方針
- **成果物**:
  - Character Stream UI / provider integration
- **exit criteria**:
  - coding agent 本体を邪魔せず、継続的な monologue を表示できる

#### E2. multi-provider 実装

- **目的**: Codex 以外の provider を段階追加する
- **背景**: 要件書とのギャップ解消
- **主要タスク**:
  - Copilot adapter
  - provider 別 capability 差分吸収
  - launch / settings / diagnostics 更新
- **成果物**:
  - provider adapter 拡張
  - provider ごとの test / docs
- **exit criteria**:
  - 少なくとも 2 provider で同じ session UX 原則を保てる

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
  - provider readiness
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
  - credential storage 導入
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
3. Provider / Credential 基盤
4. Memory 基盤
5. Pending 機能の再開条件確定
6. Character Stream / multi-provider / artifact 拡張
7. 運用・品質・リリース準備

## 直近 3 マイルストーンで見ると

- **最優先**: 仕様正本の統一
  - Character Stream、launch provider、credential 導線の文書競合を止める
- **次点**: Provider / Credential 基盤
  - current Codex 診断にも効き、将来機能の前提にもなる
- **その次**: Memory 基盤
  - Character Stream 再開の前提であり、継続性の要件達成にも必要
