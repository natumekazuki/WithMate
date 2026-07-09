# Decisions

## Summary

- composer UX は、入力補助の多機能化より `送れるか / 何が送られるか / 何を直せば送れるか` の明快さを優先する
- sendability feedback は Send 近傍の単一導線へ寄せ、session-level blocked reason / input-level error / blank draft を分裂させない
- attachment chip と `@path` 候補は既存データ源のまま改善し、persistent draft や source 拡張は new-plan へ分離する
- `src/App.tsx` / `src/styles.css` / docs は interruption / retry task と重なるため、same-plan の局所変更として衝突注意を残す

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: Session composer で最優先すべき UX は何か
- 判断: Send 条件と attachment 可視性を主軸にし、`@path` 候補は過剰に肥大化させない
- 理由: coding agent への入力体験では、入力補助の多機能さより「送れているか」「何が送られるか」の明快さの方が価値が高いから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-20
- 論点: session-level blocked reason / input-level error / blank draft の sendability feedback をどう整理するか
- 判断: Send / Cancel row 近傍の単一 feedback area に統合し、session-level blocked reason を最優先、input-level error をその次、blank / whitespace draft helper を最後に扱う
- 理由: 現状は composer 上部 banner と別 error list に分裂しており、何が送信を止めているかを視線移動なしで判断できないため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`

### 0003

- 日時: 2026-03-20
- 論点: attachment chip の見せ方で今回やる範囲をどこまでにするか
- 判断: file / folder / image の軽量な種別表示、basename 優先、workspace-relative path、副次情報としての outside-workspace ラベルと long path 省略表示までを same-plan に含める
- 理由: 問題は chip の識別性不足であり、新しい metadata 取得や picker 変更なしでも読みやすさを大きく改善できるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`

### 0004

- 日時: 2026-03-20
- 論点: `@path` 候補 UI の今回スコープに keyboard navigation を含めるか
- 判断: 表示条件と候補 source は現状維持としつつ、open 中候補に限った `ArrowUp` / `ArrowDown` / `Enter` / `Tab` / `Escape` の keyboard navigation を same-plan に含める
- 理由: 現状が mouse selection 中心で、既存候補の活用体験を改善するには最小限の keyboard 操作追加が費用対効果に優れるため。bare `@` 対応や source 拡張まで広げる必要はないため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`

### 0005

- 日時: 2026-03-20
- 論点: draft 保持を今回どこまで扱うか
- 判断: current task では renderer local な draft 保護と sendability 整理までに留め、persistent draft storage や再起動復元は new-plan とする
- 理由: persistent draft まで含めると目的、変更範囲、検証軸が Session composer の局所 UI 改修から外れ、storage / lifecycle 設計へ広がるため
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `new-plan`
- 想定影響範囲: storage、window lifecycle、session 復元導線
- 検証観点: 再起動復元、window reopen 後保持、session 切替時の整合性

### 0006

- 日時: 2026-03-20
- 論点: 前タスク差分とファイルが重なる composer UX 改修をどう扱うか
- 判断: interruption / retry UX と同じ files に対する局所変更として same-plan で閉じるが、`src/App.tsx` / `src/styles.css` / docs の dirty 差分衝突を明示的なリスクとして残す
- 理由: composer 周辺 UI の範囲で完了条件は共有しており別 plan に分けるほど独立していない一方、実装時の merge ミスは現実的な主要リスクだから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`
