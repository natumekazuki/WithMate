# Decisions

## Summary

- まず Home の card 表現から theme rule を揃える
- 文字色は固定色ではなく、background の luminance から自動決定する

## Decision Log

### 0001

- 日時: 2026-03-15
- 論点: キャラカラーをどこから揃えるか
- 判断: Home の session card / character card を最初の適用先にする
- 理由: 一覧 UI は差分が見えやすく、`main / sub` の役割を最も整理しやすい
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-15
- 論点: background と文字色の衝突をどう防ぐか
- 判断: `main` 色の relative luminance から前景色を自動決定する
- 理由: 色の自由度を落とさずに、Home / Character Editor / Session で同じルールを再利用できる
- 影響範囲: `src/ui-utils.tsx`, `src/HomeApp.tsx`, `src/styles.css`

### 0003

- 日時: 2026-03-19
- 論点: Character Editor / Session のキャラカラー適用を継続するか
- 判断: Character Editor と Session の両方でキャラカラー適用を継続する
- 理由: Home だけで theme rule を閉じず、create / edit / run の主要面でキャラカラーの一貫性を持たせるため
- 影響範囲: `src/CharacterEditorApp.tsx`, `src/App.tsx`, `src/styles.css`, `docs/design/character-management-ui.md`

### 0004

- 日時: 2026-03-19
- 論点: Session のキャラカラーをどこから戻すか
- 判断: まず Character Editor と同じく dark base を維持したまま accent だけ戻し、header / composer / 補助 UI へ適用する
- 理由: Session 固有の message bubble や artifact 面は情報量が多く、先に全体へ色を広げると可読性リスクが高いため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0005

- 日時: 2026-03-20
- 論点: Diff へキャラカラーをどこまで持ち込むか
- 判断: Diff は add / delete / modify の意味色を維持し、character theme は `titlebar / subbar / pane header` の chrome にだけ薄く適用する
- 理由: 差分行の背景色まで character color へ寄せると意味色と衝突しやすく、可読性より装飾が勝ってしまうため
- 影響範囲: `src/App.tsx`, `src/DiffApp.tsx`, `src/DiffViewer.tsx`, `src/theme-utils.ts`, `src/styles.css`, `docs/design/desktop-ui.md`
