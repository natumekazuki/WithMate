# Decisions

## 2026-03-22

### New Session の provider は launch dialog で明示選択にする

- `model catalog` と `Coding Agent Providers` が複数 provider 前提になったので、session 作成時に provider が見えない状態はよくない
- 今回は `provider` だけを launch dialog に追加し、approval / model / depth は既存どおり session 作成後に調整する

### Settings の provider toggle は 1 行 row で見せる

- current UI は checkbox だけが浮いて見え、provider name と設定対象の関係が弱い
- `ProviderName` を左、`Enabled` checkbox を右に置く row のほうが把握しやすい
