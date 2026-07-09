# Decisions

- 追加 metadata は `transport payload` の補助 field に寄せる
- 実行時間は `durationMs` で main/background 共通に載せる
- retrieval 件数は current 実装で確実に取れる `projectMemoryHits` を先に載せる
- memory 件数は background task ごとに保存件数を載せる
- main turn では `attachmentCount` も合わせて載せる
- AuditLog overlay の details は初期状態をすべて collapsed に揃える
