# Decisions

## Decision 1

- status: confirmed
- decision: icon は生成 AI ではなく code-native の raster 生成で作る
- rationale:
  - app icon は simple shape と brand tone が中心で、repo 内で deterministic に再生成できる方が運用しやすいため
  - Windows / macOS 向けに `png` と `ico` を確実に残したいため

