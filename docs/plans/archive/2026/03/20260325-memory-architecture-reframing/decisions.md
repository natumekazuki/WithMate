# Decisions

- Memory は `Repository / Session / Character` の 3 層で扱う
- `Repository Memory` は `Session Memory` からの昇格先として扱う
- 分類や昇格判断はユーザーではなく内部処理で行う
