# codex-monologue-schema-fix

## 目的

- `Codex` の background structured output で `invalid_json_schema` が出る不具合を解消する

## 対応

- `Character Reflection` schema を strict JSON schema に合わせる
- `Session Memory extraction` schema も同じ基準で見直す
- parser の compact 動作は維持する
- `build` と関連 test で確認する
