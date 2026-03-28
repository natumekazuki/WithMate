# Decisions

- session_kind は current schema の必須 column とみなし、旧 sessions table への ALTER TABLE は削除する
- session_kind 欠落 DB を救済する test は削除する

