# Development Workflow

作業内容に応じて[Agent Guide](../../AGENTS.md)から参照する、repository固有の開発規則。

## 回答と変更

- ユーザーへの回答、生成ドキュメント、コミットメッセージは日本語で書く。repository内のファイルはrepository root相対pathで示す。不明な仕様、API、依存関係は実装・設計文書・既存testを確認し、未確認のまま断定しない。
- TypeScriptは`strict`、ES modules、`NodeNext`、React JSX runtimeの既存構成に合わせる。既存コードの2 spaces、double quotes、末尾セミコロンを基本とし、ファイル名はkebab-case、React componentは既存に合わせてPascalCaseを使う。
- 共通処理は既存helperとservice層へ寄せ、無関係な整形・rename・refactorを混ぜない。生成物、ドキュメント、commitにsecret、token、個人環境の絶対pathを残さない。

## 検証

- 変更種別に合う最小のtargeted testを優先する。永続化、migration、IPC、provider adapterを変更した場合は、関連testに加えてTypeScript型検査を実行する。
- UI変更では、可能ならstate、projection、componentのtestを追加または更新する。UI変更やbranch固有のsmoke・目視確認が有効なら、[READMEの分離したvisual check](../../README.md#分離したvisual-check)をユーザーへ提案する。実行時は対象Worktreeのrootからscriptを呼び、検証用processの差し替えを明示する。
- 全体検証が無関係な既存の失敗で落ちた場合は、関係する失敗と切り分けて報告する。検証できない場合は理由、代替確認、残るリスクを明記する。起動・build・testのコマンドは[README](../../README.md#開発と検証)、実行定義は`package.json`と各scriptを参照する。

## Git

- commitは一つの論理変更単位を基本とし、messageはConventional Commits形式を使う。commit前に`git status --short`を確認し、ユーザー由来の無関係な変更を混ぜない。
- `AGENTS.md`はユーザーが明示するまでcommitしない。pushはユーザーが明示した場合だけ実行する。
- 通常の実装commitをリリースとみなさず、リリース規則だけでtag付与、push、外部公開を許可されたと解釈しない。releaseの保存・参照・互換性境界は[Release Notes](../releases/README.md)を参照する。
