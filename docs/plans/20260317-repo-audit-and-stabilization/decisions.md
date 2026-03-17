# Decisions

## Summary

- 本タスクは一括実装ではなく、`調査 → 監査レポート → バグ修正 → 検証 → 潜在バグレポート → 完成計画 → コミット` の順で進める。
- 成果物の主ハブは `docs/plans/20260317-repo-audit-and-stabilization/` とする。
- 実装済み / 未実装 / 設計漏れ候補の分類には、必ず根拠ファイルを付与する。
- SQL ツールが使えない場合でも、storage 実装と設計文書の読解をもとに調査を継続する。
- コミットはフェーズ単位で行い、監査文書とコード修正を不必要に混在させない。

## Decision Log

### 0001

- 日時: 2026-03-17
- 論点: どこから調査を始めるか
- 判断: `要件定義 → design docs → エントリポイント → 各機能実装` の順で確認する
- 理由: 先に期待仕様を固定した方が、実装済み / 未実装 / 設計漏れ候補の判定をぶらさずに行える
- 影響範囲: `docs/要件定義_叩き.md`, `docs/design/*.md`, `src/*`, `src-electron/*`

### 0002

- 日時: 2026-03-17
- 論点: 調査結果をどの単位で整理するか
- 判断: 画面単位と基盤単位を併用する
- 理由: Home / Session / Character Editor / Diff Viewer の UX 観点と、storage / provider / IPC の内部観点の両方が必要なため
- 影響範囲: 監査レポート、潜在バグレポート、完成計画

### 0003

- 日時: 2026-03-17
- 論点: 表面バグ修正の優先順
- 判断: `再現容易性が高いもの`、`影響範囲が局所的なもの`、`主要導線を阻害するもの` を優先する
- 理由: 複雑系バグへ先に入るより、監査結果と検証の質を安定させやすい
- 影響範囲: 後続の修正順序、コミット粒度

### 0004

- 日時: 2026-03-17
- 論点: SQL ツール不在時の扱い
- 判断: DB 実データ探索は必須条件にせず、storage 実装・schema 設計・関連 UI の挙動から評価する
- 理由: 今回の目的は全体監査と安定化計画の策定であり、外部ツール依存で進行を止めないため
- 影響範囲: `src-electron/*-storage.ts`, `docs/design/*`, バグ分析の精度

### 0005

- 日時: 2026-03-17
- 論点: コミットをどこで切るか
- 判断: `計画確定`, `監査完了`, `表面バグ修正`, `検証完了`, `最終レポート完了` の節目で切る
- 理由: 差分レビューしやすく、後戻り時の意味単位も明確になる
- 影響範囲: `worklog.md`, `result.md`, 後続作業手順

### 0006

- 日時: 2026-03-17
- 論点: bug fix / stabilization 後の残成果物をどう分けるか
- 判断: `潜在バグレポート` と `完成ロードマップ` は別文書に分離し、前者は未修正リスク、後者は今後の実装順序と完了条件に専念させる
- 理由: リスク列挙と将来計画を混在させると、未修正バグと機能計画の優先度が曖昧になりやすいため
- 影響範囲: `potential-bug-report.md`, `completion-roadmap.md`, `worklog.md`, `result.md`

### 0007

- 日時: 2026-03-17
- 論点: 文書作成フェーズで Character Stream / provider / memory をどう整理するか
- 判断: `potential-bug-report.md` では未修正リスクを session 整合性・catalog drift・provider 認証可視性・artifact summary / diff 欠落・Character Stream 文書競合に限定し、`completion-roadmap.md` では `仕様正本の統一`、`Provider / Credential 基盤`、`Memory 基盤`、`Pending 機能の再開条件` を別章で整理する
- 理由: Character Stream、provider、memory を同じ論点として混在させると、今回の未修正リスクと今後の基盤整備の境界が曖昧になるため
- 影響範囲: `potential-bug-report.md`, `completion-roadmap.md`, `plan.md`, `worklog.md`, `result.md`

### 0008

- 日時: 2026-03-17
- 論点: ユーザーが確定した `PB-001`〜`PB-005` を既存文書へどう反映するか
- 判断:
  - `PB-001`: character を読み込めない session は続行不可とし、過去ログ閲覧のみ継続可能な方針で固定する
  - `PB-002`: model catalog は import 時に自動 migrate される前提へ置き換える
  - `PB-003`: Settings に provider ごとの有効化チェックボックスを置き、enabled provider は利用可能前提とする。実行時エラーが出るまでは readiness / preflight の追加ハンドリングは要求しない。API キーも Settings 入力前提で扱う
  - `PB-004`: 現行の推奨対応を維持し、triage と roadmap の優先度も大きくは変えない
  - `PB-005`: Character Stream 実装開始条件を `Codex / CopilotCLI 対応完了` かつ `両 CLI と SDK 経由で使える機能の網羅完了` 後へ固定し、その前提で関連ドキュメントを更新する
- 理由: 既存の `potential-bug-report.md` と `completion-roadmap.md` には未確定案や前提の揺れが残っており、ユーザー確定事項を反映しないまま final review へ進むと、後続実装の判断が再び分岐するため
- 影響範囲:
  - `docs/plans/20260317-repo-audit-and-stabilization/potential-bug-report.md`
  - `docs/plans/20260317-repo-audit-and-stabilization/completion-roadmap.md`
  - `docs/plans/20260317-repo-audit-and-stabilization/plan.md`
  - `docs/plans/20260317-repo-audit-and-stabilization/worklog.md`
  - `docs/plans/20260317-repo-audit-and-stabilization/result.md`
  - `docs/design/character-storage.md`
  - `docs/design/session-persistence.md`
  - `docs/design/model-catalog.md`
  - `docs/design/settings-ui.md`
  - `docs/design/product-direction.md`
  - `docs/design/monologue-provider-policy.md`
  - 必要に応じて `docs/design/agent-event-ui.md`, `docs/design/character-chat-ui.md`

### 0009

- 日時: 2026-03-17
- 論点: 今回の文書同期タスクで current 実装と future 方針をどう書き分けるか
- 判断:
  - 今回は **文書のみ更新** とし、README や manual test の current 実装入口は不用意に拡張しない
  - 未実装の内容は `確定方針`、`今後反映する仕様`、`current milestone の非対応事項` として表現し、実装済みのようには書かない
  - `PB-001` は `続行不可 / 過去ログ閲覧可`、`PB-002` は `import 時自動 migrate`、`PB-003` は `Settings で provider enable + API key 入力`、`PB-005` は `Codex / CopilotCLI / CLI / SDK parity 完了後に Character Stream 着手` の 4 軸を design docs 側にも波及させる
- 理由: current 実装入口に future 機能を混ぜると、次の実装タスクや review で誤読が発生しやすいため
- 影響範囲:
  - `docs/plans/20260317-repo-audit-and-stabilization/*`
  - `docs/design/character-storage.md`
  - `docs/design/session-persistence.md`
  - `docs/design/model-catalog.md`
  - `docs/design/settings-ui.md`
  - `docs/design/product-direction.md`
  - `docs/design/monologue-provider-policy.md`
  - `docs/design/agent-event-ui.md`
  - `docs/design/character-chat-ui.md`
