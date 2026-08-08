# 018 Codex Stream Error Classification

- 状態: Accepted
- 日付: 2026-08-09
- 更新対象: [ADR 002](002-provider-turn-terminal-and-cancellation.md) の Codex `error` event 終端判定

## Context

Codex の streaming event では、transport の再接続を試みている途中にも `error` が通知される。これを最初の通知時点で terminal event とみなすと、SDK が後続の retry、item、`turn.completed`、`turn.failed` を返す前に WithMate が stream を閉じる。その結果、`Reconnecting... 2/5` のような途中経過が最終エラーとして保存され、実際の turn outcome を取得できない。

一方で、`error` の後に terminal event が来ないまま stream が終了する経路では、最後に取得した diagnostic を失わず failure として返す必要がある。transport cleanup を turn 完了条件にしないことと、terminal event 後の bounded close は ADR 002 の判断を維持する。

## Decision

- Codex turn の terminal event は `turn.completed` と `turn.failed` に限定する
- `error` event は retry を含む stream diagnostic として保持し、単独では iterator を閉じない
- 後続の assistant delta または item event を受け取った場合、古い diagnostic は live error projection から消す
- `turn.failed` を受け取った場合、その `error.message` を canonical failure とする
- `error` の後に terminal event がないまま EOF へ到達した場合、最後に保持した diagnostic を failure として返す
- terminal event も diagnostic もないまま EOF へ到達した場合は protocol failure とする
- SDK 更新時は、retry diagnostic 後の成功と、retry diagnostic 後の `turn.failed` の両方を executable contract で確認する

## Alternatives

- 最初の `error` を terminal とする: retry 中の diagnostic で stream を閉じ、最終 outcome を失うため採用しない
- `Reconnecting` など特定の message だけを非 terminal とする: provider の文言変更に依存し、同じ event contract を複数分類へ分けるため採用しない
- EOF まで常に待つ: terminal event 後に transport cleanup が停止する問題を再発させるため採用しない
- `error` をすべて破棄する: terminal event が欠落した stream で利用可能な failure diagnostic を失うため採用しない

## Consequences

### Positive

- retry が成功した turn は途中の接続エラーで失敗扱いにならない
- retry が尽きて `turn.failed` へ到達した場合、途中経過ではなく最終エラーを保存できる
- terminal event が欠落した異常 stream でも最後の diagnostic を利用できる

### Negative

- terminal event が欠落した stream では failure 判定が EOF まで遅れる
- SDK が `error` event 自体を terminal contract に変更した場合、adapter と契約テストの更新が必要になる
