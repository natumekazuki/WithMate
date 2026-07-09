# decisions

## 2026-04-02

- WCAG 2.1 の contrast ratio を正本にし、`relativeLuminance > 閾値` での前景色選択は廃止する
- helper は `src/theme-utils.ts` に集約し、Home card / Character Editor / Session / Diff が同じ foreground selection を使う
- secondary / muted text も background 合成後の contrast を考慮して alpha を決める
- `.ai_context/` と `README.md` は更新不要
  - `.ai_context/`: アーキテクチャや DI ルールではなく、renderer の見た目計算ルール変更に留まるため
  - `README.md`: セットアップや導線は変えていないため
