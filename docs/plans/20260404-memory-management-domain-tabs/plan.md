# 2026-04-04 Memory Management Domain Tabs

## 目的

- `Memory 管理` の dropdown 文字色を背景と十分にコントラストする状態へ直す
- domain 切り替えを dropdown 依存ではなく tab でも行えるようにする

## 対象

- `src/home-components.tsx`
- `src/styles.css`
- 必要なら `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md`

## 進め方

1. current の filter bar と memory domain section の構造を確認する
2. domain 切り替え tab を追加し、既存 domain filter state と統合する
3. select の文字色と背景のコントラストを修正する
4. docs 同期と build 確認を行う
