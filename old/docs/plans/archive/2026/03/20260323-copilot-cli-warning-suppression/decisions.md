# Decisions

## 2026-03-23

- `@github/copilot-sdk` は CLI 子プロセスの `stderr` 出力が残ったまま exit すると、`code 0` でも `CLI server exited with code 0` として reject する
- WithMate 側では SDK patch ではなく、Copilot child process の env に warning 抑止を渡して false error を防ぐ
