# Decisions

## Summary

- Audit Log は entry 単位の card は展開したまま維持しつつ、長文本文だけをカテゴリ単位で折りたたむ
- デフォルトで閉じるのは `System Prompt` `Input Prompt` `Composed Prompt` `Response` `Operations` `Raw Items`
- `phase` `createdAt` `provider/model/depth/approval` は常時表示に残す

## Decision Log

### 0001

- 日時: 2026-03-15
- 論点: Audit Log を entry ごとに折りたたむか、内部セクションだけ折りたたむか
- 判断: entry card 自体は開いたままにして、長文セクションだけを折りたたむ
- 理由: phase や timestamp などの概要は一覧で見たい一方で、prompt / response / raw items は常時展開だと長すぎるため
- 影響範囲: src/App.tsx, src/styles.css, docs/design/audit-log.md
