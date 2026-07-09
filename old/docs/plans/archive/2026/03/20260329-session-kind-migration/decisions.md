# Decisions

- 既存 DB は session_kind TEXT NOT NULL DEFAULT 'default' を追加する migration で維持する
- Home 非表示判定は branch ではなく sessionKind で行う
- Character Update session は branch を実 branch 用に戻し、用途は sessionKind='character-update' で表す

