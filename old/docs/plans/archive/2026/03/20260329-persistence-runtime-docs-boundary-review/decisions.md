# 20260329 Persistence Runtime Docs Boundary Review Decisions

## 初期判断

- `database-schema.md` は保存構造の正本として維持し、service 責務は持たせない
- `electron-session-store.md` は session / audit / memory persistence orchestration の supporting doc として維持する
- `session-run-lifecycle.md` は running session lifecycle と background hook の正本として維持する
- `electron-window-runtime.md` は current の BrowserWindow / preload / bootstrap detail に寄せ、古い「この段階では未実装」表現は除去する
