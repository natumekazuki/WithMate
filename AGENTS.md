# WithMate Agent Guide

WithMateはElectron + React + TypeScriptのデスクトップアプリである。作業に関係する文書だけを参照する。

- 起動、build、test、repository構成は[README](README.md)を参照する。実行コマンドの正本は`package.json`と各scriptとする。
- 回答・コード変更・検証・Git操作の規則は[Development Workflow](docs/runbooks/development-workflow.md)に従う。
- 課題・不具合・review残件・作業計画の管理先はGitHub Issue／PRとする。文書の保存・更新時は[Documentation Map](docs/design/documentation-map.md#文書の保存区分)を参照する。
- UIを変更する時は[Desktop UI](docs/design/desktop-ui.md)を参照する。保存・移行・Memoryを変更する時は[Database Schema](docs/design/database-schema.md)から該当する現行設計をたどる。
- 互換性・継続性の維持対象はpreviewを含むリリースタグが指すcommitであり、未リリースの途中状態は対象にしない。互換性やリリースを扱う時は[Release Notes](docs/releases/README.md)を参照する。
- `AGENTS.md`はユーザーが明示するまでcommitしない。
