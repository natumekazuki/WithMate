# Worklog

- 2026-03-25: plan 作成。current の `sessionCopy` は単一文字列で、session-copy tab は専用 scroll 定義が無いことを確認した。
- 2026-03-25: `CharacterSessionCopy` を複数候補配列へ変更し、Character Editor は 1 行 1 候補として編集できるようにした。
- 2026-03-25: session-copy tab に scroll を追加し、SessionWindow 側は slot ごとの stable seed で候補を 1 件選ぶようにした。
