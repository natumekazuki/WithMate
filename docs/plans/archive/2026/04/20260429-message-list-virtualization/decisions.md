# Decisions

## D-001: repo plan として扱う

- status: accepted
- date: 2026-04-29
- decision: `message-list-virtualization` は repo plan として管理する。
- reason: 複数ファイルにまたがる UI 挙動変更で、Red/Green/Review の段階化、検証記録、handoff 価値があるため。

## D-002: `src/virtual-list.ts` を再利用する

- status: accepted
- date: 2026-04-29
- decision: 新しい virtualizer を導入せず、既存 `calculateVirtualListWindow` を message-list に適用する。
- reason: 監査ログ仮想化で利用実績があり、今回の目的は message-list の DOM 全件描画を抑えることに限定されるため。

## D-003: `artifactKey` は現行 index ベースを維持する

- status: accepted
- date: 2026-04-29
- decision: `artifactKey` は現行 `${sessionId}-${index}` を維持し、window 内 index ではなく元配列 index を使う。
- reason: 今回は DB/schema や `Message` id 追加へ踏み込まないため。append-only 前提の既存挙動を保つ。
- consequence: append-only でない履歴再構成時の展開状態ずれは残る。安定 id 化は follow-up とする。

## D-004: 行高は固定推定高で先行する

- status: accepted
- date: 2026-04-29
- decision: 初期実装では固定推定高 + overscan による windowing とし、可変高実測は導入しない。
- reason: artifact や approval card の可変高を正確に扱う実測 virtualizer はスコープが広く、今回の最小目的を超えるため。
- consequence: 大きな message 行で scrollbar 体感位置にずれが残る可能性がある。

## D-005: DOM client test harness は follow-up とする

- status: accepted
- date: 2026-04-29
- decision: 今回は `renderToStaticMarkup`、pure function test、build/test、手動確認項目で担保する。
- reason: harness 導入自体が独立した検証基盤タスクになり、今回の仮想化実装と目的、変更範囲、検証軸が分かれるため。

## D-006: design gate は workspace-only とする

- status: accepted
- date: 2026-04-29
- decision: `docs/design/` と `.ai_context/` の正本更新は不要とする。
- reason: 既存 utility と既存 UI 内部実装の再利用であり、公開仕様、データモデル、主要アーキテクチャの変更を伴わないため。

## D-007: viewport 高さ変更は `ResizeObserver` で再計測する

- status: accepted
- date: 2026-04-29
- decision: message-list の `clientHeight` は初回描画と message 数変更だけでなく、`ResizeObserver` で高さ変更時にも再計測する。
- reason: panel resize や window resize 後も virtual window の表示範囲を現在の viewport に合わせるため。

## D-008: artifact 内 fold は component state で保持する

- status: accepted
- date: 2026-04-29
- decision: artifact の `Changed Files` と `Operations` の `<details>` は controlled state とし、virtualization による unmount/remount 後も開閉状態を維持する。
- reason: window 外へ出た artifact が戻ってきたとき、ユーザーが開いた詳細の状態が失われる回帰を避けるため。
