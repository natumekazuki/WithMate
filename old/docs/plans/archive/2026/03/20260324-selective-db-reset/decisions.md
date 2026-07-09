# Decisions

## 2026-03-24

- reset 対象は `sessions / auditLogs / appSettings / modelCatalog` の 4 種類に限定する
- `all selected` の場合は DB ファイルを削除して storage を再初期化する
- `partial selected` の場合は storage ごとの reset API を呼ぶ
- reset 結果は従来どおり `sessions / appSettings / modelCatalog` を返し、renderer 側の再同期に使う
