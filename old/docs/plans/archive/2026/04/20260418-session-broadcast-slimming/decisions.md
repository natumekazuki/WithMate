# Decisions

## Decision 1

- status: confirmed
- decision: 本 task は repo plan として管理する
- rationale:
  - session broadcast 契約、main / renderer の責務、関連テスト、design doc 判断まで含み、複数段階の変更になるため
  - handoff / 再開価値が高く、archive-ready な追跡が必要なため

## Decision 2

- status: confirmed
- decision: 現時点では追加質問を出さず、既存 roadmap とユーザー指示を前提に計画を開始する
- rationale:
  - plan tier、plan ディレクトリ、初期成果物、problem / approach が明示済みで、着手判断に必要な前提がそろっているため

## Decision 3

- status: confirmed
- decision: session summary payload は Home 系 window へ寄せる
- rationale:
  - `src/HomeApp.tsx` は一覧・集約表示の責務が中心で、summary payload の受け取り先として最も自然なため
  - 全 window への fan-out を抑え、不要な再描画と clone コストを減らしやすいため

## Decision 4

- status: confirmed
- decision: Session window は full summary 再送ではなく、軽量な invalidation / changed 通知を受けて detail を再取得する方針で進める
- rationale:
  - `src/App.tsx` は active session detail の表示責務が中心であり、summary payload を常時受ける必要が薄いため
  - summary/detail hydration の方向性と整合し、用途別購読へ分離しやすいため

## Decision 5

- status: confirmed
- decision: Session window 向け軽量イベントは `sessionId[]` payload の invalidation 通知として扱う
- rationale:
  - delete / reset / bulk replace でも単一契約で扱え、selected session の再 hydrate 判定を renderer 側で単純にできるため
  - full summary や detail diff を持たずに fan-out を小さく保てるため
