# Worklog

## Timeline

### 0001
- 日時: 2026-03-14
- チェックポイント: 着手
- 実施内容: Home 専用 dark theme の方針を整理した
- 検証:
- メモ: 実装前
- 関連コミット:

### 0002
- 日時: 2026-03-14
- チェックポイント: Home dark theme 適用
- 実施内容: `.home-page` 配下で token を上書きし、Recent Sessions / Characters / toolbar / settings を黒基調へ切り替えた。Session 側の既存配色は維持した。
- 検証:
  - `npm run typecheck`
  - `npm run build`
- メモ: body 全体ではなく Home shell 側で dark surface を描画している。
- 関連コミット:
