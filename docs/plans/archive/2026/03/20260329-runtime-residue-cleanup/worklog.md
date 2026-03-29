# Worklog

## 2026-03-29

- plan 文書 5 点の作成方針を整理した
- same-plan 対象 5 件と非対象の境界を固定した
- baseline を `npm run build` 成功維持、`npm run typecheck` 非悪化確認で記録した
- docs-sync 判定を `README.md` 要更新、`docs/design/character-storage.md` 更新不要、`.ai_context/` 更新不要で確定した
- `index.html` / `session.html` / `character.html` の title から `Mock` を除去した
- `README.md` から `.ai_context/` と repo 直下 `characters/` の案内を外し、character の正本保存先がアプリ管理領域である説明へ是正した
- repo 直下 `tmp/` と `characters/` を削除した
- `npm run build` を実行し、成功を確認した
- `npm run typecheck` を実行し、既存 baseline の失敗が継続していることだけを確認した

## 完了

- repo 直下 `tmp/` の削除完了を確認した
- repo 直下 `characters/` の削除完了を確認した
- `npm run build` 成功を確認した
- `npm run typecheck` の baseline 失敗継続を確認した
- plan を `docs/plans/archive/2026/03/20260329-runtime-residue-cleanup/` へ archive した

## 検証メモ

- `npm run build`: 成功
- `npm run typecheck`: 既存 baseline 失敗を確認
