# Decisions

## 2026-03-29

### Git 履歴ベースの復元を第一優先にする

- `f6850da` / `da89b88` / `b892f01` では character が composed prompt に含まれていた
- 既知の正常系が履歴上にあるため、まずはその性質を現行構造へ最小移植する
- memory 導入後の prompt section 構成は維持し、character 注入だけを確実に戻す

### 原因コミット候補は `0a8f4bd` として扱う

- `0a8f4bd` で `systemBodyText` と `logicalPrompt.systemText` の責務が分離した
- その時点で `logicalPrompt.composedText` が prefix のみを使い続けたため、Codex 経路だけ character を失う構造になった
- 調査・結果記録ではこの commit を第一候補として残す

### 復元先は `logicalPrompt.systemText` / `logicalPrompt.composedText` の整合性を優先する

- Codex は `logicalPrompt.composedText` を transport text として使う
- そのため `systemBodyText` だけ直しても不十分
- `logicalPrompt.systemText` を system-level 情報の実体に合わせ、`composedText` もそこから合成する

### Copilot 挙動は変えない

- Copilot は `buildCopilotSystemMessage(prompt)` で `systemBodyText` を使っている
- 今回は `systemBodyText` の contract を崩さず、Codex 側の欠落だけを最小修正する

### `docs/design` / `README.md` / `.ai_context` は更新しない

- 今回は provider prompt の内部バグ修正で、利用者向け仕様や設計境界の文章更新までは不要
- no-op 判断は `result.md` にも明記する
