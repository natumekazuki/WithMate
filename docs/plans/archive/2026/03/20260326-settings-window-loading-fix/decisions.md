# Decisions

- 保存値自体は DB に残っているため、storage migration ではなく renderer 初期表示の問題として扱う
- `Settings Window` は `appSettings` と `modelCatalog` が揃うまで loading state を出す
