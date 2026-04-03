# Plan: tasks command investigation

## 目的

- GitHub issue `#17` の `/tasks` 相当機能について、Copilot SDK と Codex 側の current surface を確認する
- WithMate に実装可能な slice を整理し、必要なら最小実装まで進める

## スコープ

- Copilot adapter / provider capability / Session UI まわりの既存実装確認
- `docs/design/` の capability 系ドキュメント更新要否の判断
- 実装可能な最小 slice が見つかった場合の実装と検証

## 非スコープ

- `#10` 全体の slash command 吸収方針をここで確定すること
- provider SDK が expose していない機能を推測実装すること

## 進め方

1. issue 本文、既存 design doc、adapter 実装、test を確認する
2. Copilot / Codex の current surface を codebase と installed package から確認する
3. WithMate で扱える slice を決める
4. 必要な code / doc / test を更新する
5. 結果を backlog と plan に記録する

## 検証

- 影響範囲の unit test
- `npm run build`
