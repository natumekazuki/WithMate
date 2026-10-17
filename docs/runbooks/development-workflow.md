# Development Workflow

作業内容に応じて[Agent Guide](../../AGENTS.md)から参照する、repository固有の開発規則。

## 回答と変更

- ユーザーへの回答、生成ドキュメント、コミットメッセージは日本語で書く。repository内のファイルはrepository root相対pathで示す。不明な仕様、API、依存関係は実装・設計文書・既存testを確認し、未確認のまま断定しない。
- TypeScriptは`strict`、ES modules、`NodeNext`、React JSX runtimeの既存構成に合わせる。既存コードの2 spaces、double quotes、末尾セミコロンを基本とし、ファイル名はkebab-case、React componentは既存に合わせてPascalCaseを使う。
- 共通処理は既存helperとservice層へ寄せ、無関係な整形・rename・refactorを混ぜない。生成物、ドキュメント、commitにsecret、token、個人環境の絶対pathを残さない。

## 報告

- 通常の作業報告とリリースノートは、実施した変更・観測した結果・利用者に必要な事実を中心に記載する。検証結果には、その意味を理解するために必要な対象・条件・実施内容を添え、未実施事項を網羅的に列挙しない。
- 観測事実と評価を分け、エージェント自身の確認範囲を製品全体の品質・動作評価へ置き換えない。リリースノートには作業の自己評価や免責的な定型文を加えない。
- 判断・利用に影響する既知の失敗、不具合、利用上の制限、具体的な安全上の懸念は記載する。検証の失敗は今回の変更との関係を区別し、必須確認が実施できない場合は完了判断への影響と理由を示す。この報告方針は必須確認を免除せず、失敗・結果不明・未実施を成功へ読み替えない。

## 検証

- 変更種別に合う最小のtargeted testを優先する。永続化、migration、IPC、provider adapterを変更した場合は、関連testに加えてTypeScript型検査を実行する。
- UI変更では、可能ならstate、projection、componentのtestを追加または更新する。UI変更やbranch固有のsmoke・目視確認が有効なら、[READMEの分離したvisual check](../../README.md#分離したvisual-check)をユーザーへ提案する。実行時は対象Worktreeのrootからscriptを呼び、検証用processの差し替えを明示する。
- 起動・build・testのコマンドは[README](../../README.md#開発と検証)、実行定義は`package.json`と各scriptを参照する。
- 開発時の変更範囲に必要な検証と、リリース後の利用確認を分ける。Issueの完了・preview利用後の受入・不具合発見後の追跡は[READMEの完了運用](../../README.md#課題の対応予定とmilestone)に従い、全実機確認項目の消化を各IssueのClose条件にしない。

## Git

- commitは一つの論理変更単位を基本とし、messageはConventional Commits形式を使う。commit前に`git status --short`を確認し、ユーザー由来の無関係な変更を混ぜない。
- `AGENTS.md`はユーザーが明示するまでcommitしない。pushはユーザーが明示した場合だけ実行する。
- 通常の実装commitをリリースとみなさず、リリース規則だけでtag付与、push、外部公開を許可されたと解釈しない。releaseの保存・参照・互換性境界は[Release Notes](../releases/README.md)を参照する。
