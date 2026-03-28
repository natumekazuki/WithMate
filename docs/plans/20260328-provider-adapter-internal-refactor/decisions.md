# 20260328 Provider Adapter Internal Refactor Decisions

## 初期判断

- first slice は class 分割ではなく、同一ファイル内で helper 群を plane ごとに整理する
- `CodexAdapter` と `CopilotAdapter` の public interface は維持する
- 共通化よりも、まず各 adapter の責務境界を読みやすくすることを優先する
