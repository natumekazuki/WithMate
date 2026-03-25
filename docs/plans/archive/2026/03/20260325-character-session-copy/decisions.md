# Decisions

## 2026-03-25

- `session copy` は `CharacterProfile` の一部として保持し、Session へ複製しない
- copy slot は最小の named field 集合として持ち、自由な任意キー map にはしない
- copy 文字列では `{name}` placeholder を使えるようにし、character 名埋め込みを簡単にする
- default は bland で短い文言を使い、character 未設定でも UX が過剰にキャラ化しないようにする
