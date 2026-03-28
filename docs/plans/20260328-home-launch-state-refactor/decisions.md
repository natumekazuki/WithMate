# Decisions

## D-001 launch dialog state は単一 draft にまとめる

- `open`、`title`、`workspace`、`providerId`、`characterId`、`characterSearchText` を 1 つの draft として扱う
- `openLaunchDialog` / `closeLaunchDialog` の reset ルールは helper で固定する

## D-002 session input の組み立ては renderer helper に置く

- `CreateSessionInput` の組み立ては backend 変更ではなく renderer の派生責務として扱う
- invalid な条件では `null` を返して event handler 側で送信しない
