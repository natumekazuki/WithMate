# Decisions

## Decision 1

- status: confirmed
- decision: stable unreadable は scan 内 retry を使い切ってから `unreadable` にする
- rationale:
  - `createIgnoreMatcher()` が `EACCES` / `EPERM` / `EBUSY` を 1 回で `unreadable` に確定すると、保存中の一時的なファイルロックだけで matcher が欠落した index が 5 分間キャッシュされる
  - scan 中にすでに retry 機構が存在するため、transient エラーはそちらで吸収し、retry を使い切った場合のみ `unreadable` に降格するのが整合的

## Decision 2

- status: confirmed
- decision: stable unreadable と race-like エラーが同一 scan に混在する場合は `race` を優先する
- rationale:
  - `race` はファイルシステム変動中を意味し、index 自体の信頼性が低い状態であるため、より保守的な扱いが適切
  - 片方が stable unreadable であっても race 状態なら再 scan を促す方が整合性上正しい

## Decision 3

- status: confirmed
- decision: `docs/reviews/` 配下の review ファイル全削除を same-plan cleanup に含める
- rationale:
  - review-0650 の指摘対応が本 plan で完了するため、参照元 review ファイルを残す意義がない
  - archive ではなく削除とし、plan / worklog に対応記録を残すことで追跡可能にする

## Decision 4

- status: confirmed
- decision: docs 更新は不要（`docs/design/` / `.ai_context/` / `README.md` すべて対象外）
- rationale:
  - 変更は `snapshot-ignore.ts` 内部の retry ロジックに限定される
  - ユーザー向けの動作仕様や設計文書に影響する変更ではない
