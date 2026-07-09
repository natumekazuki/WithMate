# Decisions

## same-plan として扱う理由

### 1. repo 直下 `tmp/` の削除

- runtime residue cleanup の中心対象であり、不要資源整理そのものに当たる
- 変更範囲が repo 直下の局所に閉じる
- 他対象と同じ validation で確認できる

### 2. repo 直下 `characters/` の削除

- 不要資源 cleanup と README 誤案内是正が同じ問題を見ている
- `README.md` の案内是正と一緒に扱うことで、実装現状と docs のズレをまとめて解消できる
- `docs/design/character-storage.md` の保存方針を変える話ではなく、repo residue の撤去に留まる

### 3. `index.html` / `session.html` / `character.html` の `Mock` 文言除去

- 開発初期の残置表記を除く cleanup であり、仕様変更ではない
- 3 ファイルの title 修正に閉じるため、同一プランで扱う粒度として適切
- build 影響も軽微で、不要資源 cleanup と同時に完了できる

### 4. `README.md` の `.ai_context/` 案内是正

- 現状と異なる案内を放置すると cleanup 後も利用者を誤誘導する
- 実装変更ではなく docs-sync の範囲で完結する
- same-plan 内の README 更新として他対象と一緒に処理できる

### 5. `README.md` の repo 直下 `characters/` 案内是正

- repo 直下 `characters/` 削除と不可分の docs cleanup
- `docs/design/character-storage.md` の既存方針に README を追従させるだけで済む
- 保存方針の設計変更を伴わず、今回の cleanup で閉じられる

## 非対象として切り分ける理由

### `dist/` / `dist-electron/`

- build artifact の管理方針を含むため、今回の residue cleanup より判断範囲が広い
- 追跡対象か生成物かの整理が必要で、same-plan の最小変更から外れる

### review remediation 本体

- CSP、sandbox、`package.json`、open-path などは security / runtime policy の検討を伴う
- cleanup task と混在させると validation が build だけでは足りなくなる
- 変更リスクが高く、別 task で扱うべき

### `vite.config.ts`

- bundler 設定変更は回帰範囲が広い
- 今回の完了条件達成に必須ではない

### `src-electron/main.ts` 巨大化

- 構造改善や責務分割の論点であり、runtime residue cleanup と目的が別
- same-plan へ混在させるとスコープが膨らむ
