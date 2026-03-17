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
