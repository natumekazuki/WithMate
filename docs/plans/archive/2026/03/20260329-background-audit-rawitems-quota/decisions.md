# Decisions

- background task の `Raw Items` は `[]` 固定にせず、provider response を compact trace として残す
- Copilot の premium request quota は background task 完了時に再取得し、audit log の transport payload に付与する
- Copilot の premium request quota は通常 turn の audit log にも同じ field 名で付与する
