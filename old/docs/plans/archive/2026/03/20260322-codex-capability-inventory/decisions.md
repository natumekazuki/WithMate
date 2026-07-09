# Decisions

## 2026-03-22

### Capability inventory は新規 doc として切り出す

- `docs/design/provider-adapter.md` は境界設計の正本として残す
- current 実装で「何が使えるか」を素早く見たい用途には粒度が粗い
- そのため current snapshot 用に `docs/design/codex-capability-matrix.md` を別で持つ

### 実装済み / 一部対応 / 未対応を明示する

- Codex 周りは docs が増えているため、「設計だけある」項目が混ざりやすい
- inventory doc では各項目に status を付けて、current shipped capability を明示する

### 次タスク候補も同じ doc に残す

- 今回の目的は棚卸しで終わりではなく、次に潰す順番を作ること
- capability inventory の末尾に優先度つきの next slice を残す
