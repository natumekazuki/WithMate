# Decisions

## D-001: まず current timeout の固定値と provider surface を確認する

- 日付: 2026-04-02
- 理由: provider ごとに timeout を効かせられる方法が違う可能性があるため

## D-002: timeout は provider ごとの background settings として保持する

- 日付: 2026-04-02
- 理由: 問題の主因が model / reasoning depth によって必要待機時間が変わる点にあり、`Memory Extraction` と `Character Reflection` はすでに provider ごとの model / reasoning 設定を持っているため

## D-003: default は 180 秒、normalize は 30..1800 秒にする

- 日付: 2026-04-02
- 理由: 従来の 60 秒相当より十分長くしつつ、無限待機や極端値は避けたいから

## D-004: Codex と Copilot の両方へ timeout を適用する

- 日付: 2026-04-02
- 理由: Codex SDK は `Thread.run(..., { signal })`、Copilot SDK は `sendAndWait(..., timeout)` を持っており、provider 間で設定意味を揃えられるため
