# decisions

## 2026-04-02

- live region は pending indicator の状態変化を優先し、retry conflict / follow banner / composer feedback は visible text を正本にして常時 live 通知を外す
- blocked send feedback は `blank draft でも常時 helper を出さない` 方針を維持しつつ、`Ctrl+Enter` / `Cmd+Enter` など blocked 操作時だけ inline reason を強制表示する
- Error Boundary は `SessionPaneErrorBoundary` の局所回復と、各 renderer entry point の window-level fallback の 2 段に分ける
- `.ai_context/` と `README.md` は更新不要
  - `.ai_context/`: 公開アーキテクチャや DI ルールは変えていないため
  - `README.md`: 入口やセットアップ手順は変えておらず、今回の変更は UI 詳細と実機確認観点に閉じるため
