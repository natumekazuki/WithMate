# Companion provider workspace 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

provider 実行時の cwd / snapshot root / path 表示に、通常 Session の `workspacePath` とは別の実行用 workspace path を渡せるようにする。Companion runtime からは shadow worktree path を渡す前提を作る。

## スコープ

- `RunSessionTurnInput` に実行用 workspace path を追加する。
- Codex adapter が cwd、additional directories 正規化、snapshot、path 表示で実行用 workspace path を使うようにする。
- Copilot adapter が workingDirectory、snapshot、permission / tool summary で実行用 workspace path を使うようにする。
- 対象テストと design doc を更新する。

## 対象外

- Companion Window の作成。
- Companion 専用 `runCompanionSessionTurn` IPC。
- Review Window。
- selected files merge / discard。

## チェックポイント

1. [x] provider 実行で `workspacePath` を参照している箇所を確認する。
2. [x] runtime input に実行用 workspace path を追加する。
3. [x] Codex / Copilot adapter を実行用 workspace path に対応させる。
4. [x] テストと設計書を更新する。
5. [x] 検証、archive、commit。
