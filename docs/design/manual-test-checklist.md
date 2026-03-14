# Manual Test Checklist

- 作成日: 2026-03-14
- 対象: `docs/manual-test-checklist.md` の運用方針

## Goal

Electron 版 WithMate の現行実装に対して、人手で確認すべき項目を 1 か所に集約し、実装変更と同時に最新化される状態を維持する。

## Decision

- 実機テスト項目表の正本は `docs/manual-test-checklist.md` とする
- 実機テスト項目表は現行実装のみを対象にし、pending 機能は含めない
- ユーザーが触れる挙動を変更した場合は、同じ論理変更単位で実機テスト項目表を更新する
- README と主要 Design Doc から実機テスト項目表へ導線を張る
- 実機テスト項目表の更新責務は ADR にも残し、単なる運用メモで終わらせない

## Scope

- Home / Session / Character Editor / Diff Window の現行 UI
- session 永続化
- run lifecycle の保護
- model catalog import / export

## Non Goals

- 自動テストの代替
- pending 機能の将来項目の先行登録
- 実施結果の保存形式まで固定すること

## Maintenance Policy

### 更新が必要な変更

- 新しいユーザー操作を追加したとき
- 既存フローの前提条件を変えたとき
- 永続化や復旧挙動を変えたとき
- 設定項目や import / export のような運用フローを変えたとき

### 更新単位

- 実装変更と同じ論理変更単位で更新する
- 変更した機能の項目修正だけで済まない場合は、関連する前提条件や補足も合わせて見直す

### 参照順

1. Design Doc
2. 実装
3. 実機テスト項目表

実機テスト項目表は Design Doc と実装に追従する文書として扱う。

## Related Documents

- `docs/manual-test-checklist.md`
- `docs/design/desktop-ui.md`
- `docs/design/window-architecture.md`
- `docs/design/session-persistence.md`
- `docs/design/session-run-lifecycle.md`
- `docs/adr/001-manual-test-checklist-policy.md`
