# Worklog

- 開始: character-update session を Home 表示から外す

- 実装: home-session-projection で character-update session を除外する pure rule を追加
- 実装: desktop-ui / character-update-workspace doc を current 仕様へ更新
- 検証: npm run build
- 検証: node --test --import tsx scripts/tests/home-session-projection.test.ts
- コミット: `a572f9f` `feat(character): add update workspace monitor and session kind`
