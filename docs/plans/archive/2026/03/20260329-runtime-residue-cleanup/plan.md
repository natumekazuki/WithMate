# Plan

## Goal

- repo 直下に残っている不要資源と README の誤案内を整理し、現行実装とドキュメントの整合を取る
- same-plan 対象 5 件だけを最小変更で片付ける
- cleanup 後も `npm run build` 成功を維持し、`npm run typecheck` の既存失敗を悪化させない

## Scope

- repo 直下 `tmp/` の削除
- repo 直下 `characters/` の削除
- `index.html` / `session.html` / `character.html` の `Mock` 文言除去
- `README.md` の `.ai_context/` 案内是正
- `README.md` の repo 直下 `characters/` 案内是正

## Out Of Scope

- `dist/`
- `dist-electron/`
- review remediation 本体
  - CSP
  - sandbox
  - `package.json`
  - open-path など
- `vite.config.ts`
- `src-electron/main.ts` 巨大化対応
- `docs/design/character-storage.md` の改訂
- `npm run typecheck` の既存失敗解消

## 実施対象

1. 不要資源 cleanup
   - repo 直下 `tmp/` を削除する
   - repo 直下 `characters/` を削除する
2. runtime residue 表記 cleanup
   - `index.html` の title から `Mock` を除去する
   - `session.html` の title から `Mock` を除去する
   - `character.html` の title から `Mock` を除去する
3. docs-sync
   - `README.md` の `.ai_context/` 案内を現状に合わせて是正する
   - `README.md` の repo 直下 `characters/` 案内を現状に合わせて是正する

## 実施順

1. `README.md`、`index.html`、`session.html`、`character.html` の現状記述を再確認する
2. `index.html` / `session.html` / `character.html` から `Mock` 文言を除去する
3. `README.md` の `.ai_context/` と repo 直下 `characters/` 案内を是正する
4. repo 直下 `tmp/` と `characters/` を削除する
5. `npm run build` を実行して成功を確認する
6. `npm run typecheck` を実行して既存失敗の非悪化だけを確認する

## docs-sync 判定

- `README.md`: 要更新
  - `.ai_context/` 案内是正が必要
  - repo 直下 `characters/` 案内是正が必要
- `docs/design/character-storage.md`: 更新不要
  - 設計正本はすでに repo 直下以外を保存先として説明しており、今回のズレは README 側の追従不足
- `.ai_context/`: 更新不要
  - current repo には存在せず、README 側の誤案内是正で閉じる

## validation

- `npm run build`
  - 成功必須
- `npm run typecheck`
  - 既存失敗ありを前提に、cleanup task で悪化していないことだけを確認する
- 目視確認
  - repo 直下 `tmp/` が消えている
  - repo 直下 `characters/` が消えている
  - `index.html` / `session.html` / `character.html` に `Mock` が残っていない
  - `README.md` の `.ai_context/` 案内が現状に合っている
  - `README.md` が repo 直下 `characters/` を正本の保存先として案内していない

## risks

- repo 直下 `tmp/` に手元確認用の一時資材が残っていた場合、削除で参照できなくなる
- repo 直下 `characters/` に検証用サンプルが残っていた場合、削除前確認が必要になる
- HTML title の `Mock` 除去で手動確認メモや既存期待値にズレが出る可能性がある
- `README.md` の案内を削りすぎると、実際の character 保存方針の理解補助が弱くなる

## follow-up

- `dist/` / `dist-electron/` の扱い整理は別 task 候補
- review remediation 本体は別 task
- `vite.config.ts` の見直しは別 task
- `src-electron/main.ts` 巨大化対応は別 task
