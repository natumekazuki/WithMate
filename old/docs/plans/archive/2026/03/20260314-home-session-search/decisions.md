# Decisions

## Summary
- Home の session 検索は 1 個のテキストボックスとし、`taskTitle` と `workspacePath` の部分一致だけを対象にする。

## Decision Log

### 0001
- 日時: 2026-03-14
- 論点: 検索対象をどこまで広げるか
- 判断: 初期実装は `taskTitle` と `workspacePath` の部分一致に限定する
- 理由: Home は resume picker なので、会話本文や metadata 全文検索まで入れると役割がぶれるため
- 影響範囲: Home の検索 UX, Recent Sessions の docs, manual test
