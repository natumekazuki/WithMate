# Decisions

- query は recent conversation の user / assistant 発話だけを使う
- `Session Memory` や `Project Memory` は Character Memory retrieval query に混ぜない
- ranking は lexical match + category weight + recency boost の軽量方式にする
- hit が無い時だけ recent fallback を返す
