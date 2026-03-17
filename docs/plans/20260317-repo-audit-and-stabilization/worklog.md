# Worklog

## Timeline

### 0001

- 日時: 2026-03-17
- チェックポイント: repo audit and stabilization plan の初期化
- 実施内容:
  - セッション計画ファイルの新規作成方針を整理
  - `docs/plans/20260317-repo-audit-and-stabilization/` を成果物ハブとして定義
  - plan / decisions / worklog / result の初期ひな型を作成
  - 実行フェーズを `調査 → 監査レポート → バグ修正 → 検証 → 潜在バグレポート → 完成計画 → コミット` に整理
- 検証: 文書作成のみのため未実施
- メモ:
  - 現時点ではコード修正を行わない
  - SQL ツールがない場合でも進められるよう、ファイルベース監査を前提にした
- 関連コミット:
  - `9f676b9` `docs(plan): 監査計画を初期化`

### 0002

- 日時: 2026-03-17
- チェックポイント: 監査フェーズ着手と repo audit 文書作成
- 実施内容:
  - `README.md`、`docs/要件定義_叩き.md`、`docs/design/*.md`、`docs/manual-test-checklist.md`、`src/`、`src-electron/` を横断確認
  - 実装済み / 部分実装 / 未実装 / 設計漏れ候補を区別して整理
  - `docs/plans/20260317-repo-audit-and-stabilization/repo-audit.md` を新規作成
  - `worklog.md` と `result.md` に監査フェーズ進行状況を反映
- 検証:
  - 今回は文書更新のみのため追加コマンド実行は未実施
  - 基線検証 `npm run typecheck`, `npm run build`, `npm run validate:snapshot-ignore` は着手前 pass 済みという前提を受領
- メモ:
  - 現時点の主要実装は Codex 中心で、Character Stream は pending と判断
  - memory 設計は文書先行で、現実装とのギャップが大きい
- 関連コミット:
  - `9f676b9` `docs(plan): 監査計画を初期化`

### 0003

- 日時: 2026-03-17
- チェックポイント: quality-review 指摘に基づく監査文書の補正
- 実施内容:
  - `repo-audit.md` の優先候補を `仕様整理 backlog` と `bug fix / stabilization backlog` に分離
  - Character Stream pending 中の縮退表示ポリシーを `設計から漏れている候補` ではなく `設計文書の競合 / 要件・設計・実装のズレ` として再整理
  - Session launch 判定の根拠に `docs/design/session-launch-ui.md` を追加し、launch flow の一致点 / 不一致点を provider 露出に絞って補正
- 検証:
  - 文書更新のみのため追加コマンド実行は未実施
- メモ:
  - bug fix backlog は「実バグ候補」を優先し、仕様整理 backlog とは分離した
  - 現時点の launch flow は全体不一致ではなく、主に provider の確認 / 選択の扱いが揺れている整理に改めた

### 0004

- 日時: 2026-03-17
- チェックポイント: bug fix / stabilization backlog 上位 3 件の実装着手
- 実施内容:
  - `Session Window` 実行中の approval UI を無効化し、renderer handler と Main Process `updateSession` に実行中ガードを追加
  - Session rich text / artifact link クリック時に workspace 相対 path を session workspace 基準で解決し、local path fragment を除去して開く処理を追加
  - `workspace-file-search` に TTL 付き cache freshness policy を追加し、session run 完了 / 失敗 / cancel 後に invalidate するよう更新
  - `docs/manual-test-checklist.md` と関連 design docs を今回の修正内容に合わせて更新
  - pure helper / cache 挙動を確認する test を `scripts/tests/` に追加
- 検証:
  - `node --test --import tsx scripts/tests/open-path.test.ts scripts/tests/workspace-file-search.test.ts` pass
  - `npm run typecheck` pass
  - `npm run build` pass
  - `npm run validate:snapshot-ignore` pass
- メモ:
  - Main Process 側の session update 制限は renderer 経由更新のみを対象にし、run 中の内部状態遷移は既存 `upsertSession()` を継続利用する
  - workspace 相対 link は session workspace root 解決を優先し、URL / 絶対 path の既存挙動は維持する

## Open Items

- Character Stream の正本ドキュメントをどれに揃えるか決める
- provider 対応範囲を current milestone と将来計画に分けて確定する
- memory ギャップを bug fix と feature work のどちらで扱うか切り分ける
