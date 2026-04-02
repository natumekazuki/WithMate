# decisions

## status

- 進行中

## 決定

- `Copilot` の retry classifier には stale connection だけでなく missing session も含める
- adapter-level retry の partial 判定は `rawItems` / usage を根拠にせず、user-visible partial の有無で止める
- `SessionRuntimeService` 側の stale retry classifier は変更せず、`CopilotAdapter` 内部 recovery に閉じる
