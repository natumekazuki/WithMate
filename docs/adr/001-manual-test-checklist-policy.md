# 001 Manual Test Checklist Policy

- 状態: Withdrawn（2026-10-18、現行適用対象外）
- 日付: 2026-03-14

## 適用状態

ユーザーが項目表を利用していないため、本ADRが定めるチェックリスト本体・運用方針・更新義務を廃止する。以下の本文は当時の判断として保持する。変更範囲に必要な検証は[Development Workflow](../runbooks/development-workflow.md#検証)、リリース後の利用確認と完了判断は[README](../../README.md#課題の対応予定とmilestone)に従う。

当時の文書は[項目表](https://github.com/natumekazuki/WithMate/blob/274af7da4d4259c517fc269a272796d7a28be5ba/docs/manual-test-checklist.md)と[運用方針](https://github.com/natumekazuki/WithMate/blob/274af7da4d4259c517fc269a272796d7a28be5ba/docs/design/manual-test-checklist.md)を参照する。

## Context

WithMate は Electron デスクトップアプリとして、Home / Session / Character Editor / Diff Window / Settings overlay / 永続化 / 実行保護の挙動を持つ。
現時点では自動テストだけで UI とランタイム挙動を十分に保証できず、実機での確認項目を継続的に保守する必要がある。

これまで実機確認観点が散在していたため、機能追加や UI 変更のたびに確認漏れが起きやすい状態だった。

## Decision

- 実機テスト項目表の正本を `docs/manual-test-checklist.md` に置く
- ユーザーが触れる挙動を変更した場合は、同じ論理変更単位で実機テスト項目表を更新する
- 実機テスト項目表は現行実装のみを扱い、pending 機能は含めない
- README と主要 Design Doc から実機テスト項目表へ導線を張る
- 実機テスト項目表の運用方針は `docs/design/manual-test-checklist.md` に保持する

## Consequences

### Positive

- 実機確認の入口が 1 か所に揃う
- UI / runtime の変更時に、確認観点の更新漏れを減らせる
- Design Doc と実機確認項目の関係が明確になる

### Negative

- ユーザー向け挙動を変えた変更では docs 更新コストが必ず発生する
- 変更粒度が大きいと、チェック項目の見直しも増える

## Notes

- 実施結果の保存形式まではこの ADR では固定しない
- 自動テスト追加の余地は残すが、実機テスト項目表の更新責務は維持する
