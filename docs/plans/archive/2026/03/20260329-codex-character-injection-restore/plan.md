# Plan

## Goal

- Codex 実行経路で欠落した character 注入を Git 履歴ベースで最小復元する
- `src-electron/provider-prompt.ts` の現行構造を大きく崩さず、`logicalPrompt.systemText` / `logicalPrompt.composedText` が system-level 情報を失わないよう整える
- 回帰テストを追加して、今後 `thread.runStreamed()` 向け prompt から character が落ちたときに即検知できる状態にする

## Scope

- `src-electron/provider-prompt.ts` の prompt composition 修正
- `scripts/tests/provider-prompt.test.ts` の assertion 強化
- 必要最小限の関連確認
- session plan 更新
- 今回の調査・判断・検証方針を `docs/plans/20260329-codex-character-injection-restore/` に記録

## Out Of Scope

- Copilot の prompt 経路の仕様変更
- memory feature 全体の再設計
- `docs/design` / `README.md` / `.ai_context` の広域更新
- commit / archive 作業

## new-plan にする理由

- 今回は単純なコード修正だけでなく、Git 履歴上の旧挙動確認、原因コミット候補の明示、復元優先方針、session plan 更新、回帰テスト整備までを一体で管理する必要がある
- 問題は `0a8f4bd` 以降の prompt 構成差分で混入した可能性が高く、履歴ベースで「何を復元するか」を残さないと再発時に追跡しづらい

## Cause Candidate

- 第一候補は `0a8f4bd` `feat(memory): promote and inject project memory`
- この変更で `systemBodyText` は `system prompt prefix + character` を保持する一方、`logicalPrompt.systemText` は prefix のみを指し続け、`logicalPrompt.composedText` も `[systemPromptText, inputPromptText]` のままになった
- その結果、`prompt.logicalPrompt.composedText` を直接 `thread.runStreamed()` へ渡す Codex 経路で character が欠落した

## Restore Strategy

### 優先: Git 履歴ベースの復元

- `f6850da` / `da89b88` / `b892f01` 時点では composed prompt に character が含まれていた
- 現行の `Session Memory` / `Project Memory` セクション構成は維持しつつ、Codex が参照する `logicalPrompt.systemText` / `logicalPrompt.composedText` に character を戻す

### fallback: 新規最小修正

- 旧文字列レイアウトをそのまま戻せない場合でも、`logicalPrompt` が表す system-level prompt と `systemBodyText` を整合させ、Codex の送信 text から character が落ちない形を優先する
- Copilot は引き続き `systemBodyText` を利用するため、既存挙動を壊さないことを前提にする

## Verification Policy

- `scripts/tests/provider-prompt.test.ts` で以下を明示的に検証する
  - `logicalPrompt.systemText` が `systemBodyText` と一致すること
  - `logicalPrompt.composedText` が `system-level + input-level` の完全合成であること
  - system prompt prefix が空でも character が composed prompt に残ること
- 必要なら Codex adapter 側テスト追加を検討するが、今回の最小修正では provider prompt の回帰テストを主軸にする
- 実装後は対象テストを手動実行して未コミット状態で確認する

## Docs Judgment

- `docs/design` / `README.md` / `.ai_context` は今回不要見込み
- 理由: 外部仕様ではなく、provider prompt の内部整合と Codex 回帰修正が対象だから
- 最終的な no-op 判断は `result.md` にも残す
