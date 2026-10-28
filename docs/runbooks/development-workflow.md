# Development Workflow

WithMateのコード変更、検証、課題管理、Git操作の運用規則です。[Agent Guide](../../AGENTS.md)から作業内容に応じて参照します。

## 回答と変更

- ユーザーへの回答、生成ドキュメント、コミットメッセージは日本語で書く。repository内のファイルはrepository root相対pathで示す。不明な仕様、API、依存関係は実装・設計文書・既存testを確認し、未確認のまま断定しない。
- TypeScriptは`strict`、ES modules、`NodeNext`、React JSX runtimeの既存構成に合わせる。既存コードの2 spaces、double quotes、末尾セミコロンを基本とし、ファイル名はkebab-case、React componentは既存に合わせてPascalCaseを使う。
- 共通処理は既存helperとservice層へ寄せ、無関係な整形・rename・refactorを混ぜない。生成物、ドキュメント、commitにsecret、token、個人環境の絶対pathを残さない。

## 実装境界

Main、preload、renderer、CLIの境界をまたぐ型・定数・正規化処理は、`src-shared/`のIPC、session、settings、character、memoryなどのdomainを正本とします。利用側は必要なdomainから直接importし、共有層へReact・DOM・Electron・filesystem・DBの実装を持ち込みません。

Chat layout preferenceの型・既定値・検証は`src-shared/settings/chat-layout-preference.ts`に置き、保存APIを呼ぶrenderer adapterは`src/chat/chat-layout-preference.ts`に置きます。

## 報告

- 通常の作業報告とリリースノートは、実施した変更・観測した結果・利用者に必要な事実を中心に記載する。検証結果には、その意味を理解するために必要な対象・条件・実施内容を添え、未実施事項を網羅的に列挙しない。
- 観測事実と評価を分け、エージェント自身の確認範囲を製品全体の品質・動作評価へ置き換えない。リリースノートには作業の自己評価や免責的な定型文を加えない。
- 判断・利用に影響する既知の失敗、不具合、利用上の制限、具体的な安全上の懸念は記載する。検証の失敗は今回の変更との関係を区別し、必須確認が実施できない場合は完了判断への影響と理由を示す。この報告方針は必須確認を免除せず、失敗・結果不明・未実施を成功へ読み替えない。

## 検証

- 変更種別に合う最小のtargeted testを優先する。永続化、migration、IPC、provider adapterを変更した場合は、関連testに加えてTypeScript型検査を実行する。
- UI変更では、可能ならstate、projection、componentのtestを追加または更新する。UI変更やbranch固有のsmoke・目視確認が有効なら、[分離したvisual check](#分離したvisual-check)をユーザーへ提案する。実行時は対象Worktreeのrootからscriptを呼び、検証用processの差し替えを明示する。
- 起動・build・testのコマンドは[README](../../README.md#開発と検証)、実行定義は`package.json`と各scriptを参照する。
- 開発時の変更範囲に必要な検証と、リリース後の利用確認を分ける。Issueの完了・preview利用後の受入・不具合発見後の追跡は[課題の対応予定と完了運用](#課題の対応予定とmilestone)に従い、全実機確認項目の消化を各IssueのClose条件にしない。

### 型検査と依存境界

`typecheck`はSQLite実行ownerと依存方向のcheckも実行します。依存方向checkは`src/`、`src-shared/`、`src-electron/`、`src-cli/`全体のimport・re-export・dynamic importをtype-onlyも含めて検査します。RendererとsharedからNode/Electron/Provider SDKへの依存、sharedからReactへの依存、および実行環境の境界を逆流する相対importを拒否します。preloadはpreload内とshared、CLIはCLI内とsharedおよび限定したMainのplatform adapterを参照できます。Storage Workerの検証済みhandler entryだけは動的解決を許可し、実際のentry解決をWorker testで確認します。

### テストの選択と実行

テストは`tests/`内の`*.test.ts`・`*.test.tsx`を再帰列挙し、Node test runnerで実行します。helperやfixtureはテストファイルのsuffixを持たないため、実行対象には含まれません。通常実行とshardは同じ列挙・選択経路を使います。
test失敗、空の実行対象、不正なshard指定は非zero終了となり、CIで成功扱いにしません。

```bash
# 実行対象の一覧（testは実行しない）
npm test -- --list
# CIと同じ3分割のうち1番目
npm run test:shard -- --shard=1/3
# 対象を絞った実行
node --import tsx --test tests/main/session-storage.test.ts
# testとhelper/fixtureを含む型検査（実行時transpileとは別）
npm run typecheck:tests
```

Windows PowerShellで`--`以降の引数を渡す場合は、`npm.ps1`による区切りの消費を避けるため、`npm.cmd test -- --list`、`npm.cmd run test:shard -- --shard=1/3`のように`npm.cmd`を使います。Windows CIも同じ呼び方です。

`typecheck`はproduction・階層化した開発scriptに加え、`typecheck:tests`によるtest全体とhelper/fixtureの型検査も実行します。runtime validationを確認する意図的な不正入力は、通常のfixtureと区別し、検査対象を除外したり型検査の抑止で不整合を隠したりしないでください。

### 分離したvisual check

Windowsで作業branchのsmoke / 目視確認を行う場合は、対象Worktreeのrootから次のスクリプトで起動します。現在のWorktreeをbuildし、専用のuser dataでElectronを起動します。

```powershell
& .\scripts\start-withmate-visual-check.ps1

# 初回にデータを持ち込まず、初期状態で起動
& .\scripts\start-withmate-visual-check.ps1 -DataMode Fresh

# インストール版のデータから検証用データを再作成して起動
& .\scripts\start-withmate-visual-check.ps1 -DataMode Copy
```

このスクリプトは`%APPDATA%\WithMate-visual-check`を使用します。安全に識別できる既存のvisual check processがある場合は差し替えますが、インストール版WithMateは停止しません。データの扱いは`-DataMode`で選択します。

| モード | データの扱い |
| --- | --- |
| `Reuse`（既定） | 検証用ディレクトリを再コピーせず、そのデータで起動します。対象ディレクトリがなければ停止し、`Fresh`または`Copy`を案内します。必要なマイグレーション・初期化は通常のアプリ起動処理が行います |
| `Fresh` | 検証用ディレクトリが不存在または空の場合だけ、コピー元のデータを持ち込まず初期状態で起動します。隠しファイルを含めて何か残っている場合は、削除・上書きせず停止します |
| `Copy` | `%APPDATA%\WithMate`をコピー元として、検証用データを再作成します。通常ファイルをコピーし、SQLiteはbackup APIで整合したsnapshotを作成します。コピー元は変更しません |

`Fresh`と`Reuse`にはコピー元の`%APPDATA%\WithMate`は不要です。`Fresh`で既存データがある場合や、`Copy`で検証用データを残したい場合は、必要なデータを事前に退避してください。自動退避や強制削除のオプションはありません。`Reuse`でもマイグレーション等による検証用データの更新は発生します。

全モードで現在のWorktreeをbuildします。`-ValidateOnly`は選択モードの条件確認とbuildまでを行い、検証用プロセスの停止、データの準備、Electron起動は行いません。依存関係が不足する場合は準備します。`Get-Help .\scripts\start-withmate-visual-check.ps1 -Detailed`でも選択方法を確認できます。

agentが実行する場合は、選択モード、プロセスの差し替え、`Copy`では検証用データの置き換えを事前に明示します。

ブラウザー用の検証手段で実rendererを確認する場合は、`-RemoteDebuggingPort 0`を明示すると分離アプリだけにloopback用のdebug portを開きます。portは検証用user dataの`DevToolsActivePort`から確認できます。通常の起動ではこの指定を付けません。検証後はdebug port付きのプロセスを終了し、継続利用用には指定なしで起動し直します。

起動・終了時は次のルールを守ってください。

- 検証用環境の起動はスクリプト経由に統一し、Electronや`release/win-unpacked/WithMate.exe`の直接起動で代替しません。手動で`WITHMATE_USER_DATA_PATH`や`--withmate-visual-check`を付けても、同じ管理対象になるとは限りません。配布物自体の検証は別目的として扱い、この検証用user dataを共用しません。
- Electronが見つからない場合も別の実行ファイルへ独断で切り替えません。スクリプトは`package-lock.json`指定versionのElectronを探索・準備します。失敗した場合はその原因を確認し、既存データの保持が必要でスクリプトを使えない場合は、その制約を報告して起動方法を確認します。
- ロックが残って停止した場合は、使用中のプロセスの実行ファイルpath、引数、user dataを照合し、対象を安全に特定できた場合だけ終了します。アプリ名だけで一括終了したり、`lockfile`を削除して起動を強行したりしません。対象を特定できない場合は停止したまま確認を依頼します。
- 検証終了時は、自分が起動した検証用アプリだけを終了し、ロック解放を確認します。ユーザーが継続利用するために残す場合は、起動中であることと終了対象を引き継ぎます。インストール版WithMateには触れません。

## 課題の対応予定とMilestone

課題・不具合・レビュー残件・作業計画はGitHub Issue／PRで管理します。対応予定の正本はGitHub Milestoneとし、正式版`vX.Y.Z`ごとに1件を作ります。その版のpreviewで扱う課題も同じMilestoneに含め、preview別のMilestoneや版別ラベル、repository内の予定表は設けません。期限は合意された日付がある場合だけ設定します。

IssueをMilestoneへ割り当てるのは、その版で扱うことが明示的に決まった場合だけです。未割当ては対応版未決定を意味し、不採用や着手禁止を意味しません。ブランチ名、package version、調査対象のpreview tagだけから対応予定を決めません。既に固定されたリリース範囲をMilestoneへの移行だけで拡張せず、個々の予定をIssue本文やラベルへ二重記録しません。

Milestoneは予定であり、実装・レビュー・対象ブランチへの統合・課題完了・公開とは別の状態です。Issueの完了は次の運用で判断します。

- 要求された実装・レビュー・変更範囲に必要な検証・対象ブランチへの統合が完了したIssueは、リリース後の動作確認だけを理由にOpenを維持せず、原則としてCloseします。実機での通常利用や環境・操作条件を広げた確認は、リリース後に別途行います。
- previewリリースをしばらく利用し、ユーザーから問題ないとの報告・判断を得た場合、そのpreviewに収録されたIssueをすべて完了とみなします。全確認項目・全環境の個別消化は求めず、利用期間の固定日数も設けません。経過時間や報告がないことだけで問題なしとは推定しません。
- 収録範囲はリリースタグ、リリースノート、統合commit／PRで確認します。同じMilestoneにあるだけの未実装・未統合Issueや、具体的な修正残件を完了扱いしません。非ブロッカーの後追い課題は独立して追跡し、元Issueの完了条件へ戻しません。
- Closeやpreviewの受入判断と個々の検証結果は別に扱います。結果と利用上の注意の記載は[報告方針](#報告)に従います。

不具合が見つかった場合は、Open／Closedを含めて既存Issueを検索し、同じ現象・原因を扱うIssueへ追記するか、新規Issueを作成します。元Issueを継続して扱う場合は必要に応じて再Openし、新規Issueでは重複・原因になったIssueを関連付けます。発生したバージョン、再現条件、影響、判明している原因を記録し、推測と確認済みの事実を分けます。

重複・不採用によるクローズは修正完了と区別します。予定変更時は理由と変更後の扱いをIssue／PRへ記録し、残件を隠すために移動・クローズしません。

リリース範囲の確定時と公開判断時は、対象Milestoneの未完了Issueに加え、未割当ての関連Issueの取りこぼしを確認します。preview tagではMilestoneを閉じず、正式版の公開と対象Issueの完了・正当な延期を確認してから閉じます。タグとリリースノート、互換性境界は[Release Notes](../releases/README.md)の規則に従います。

## Git

- commitは一つの論理変更単位を基本とし、messageはConventional Commits形式を使う。commit前に`git status --short`を確認し、ユーザー由来の無関係な変更を混ぜない。
- `AGENTS.md`はユーザーが明示するまでcommitしない。pushはユーザーが明示した場合だけ実行する。
- 通常の実装commitをリリースとみなさず、リリース規則だけでtag付与、push、外部公開を許可されたと解釈しない。releaseの保存・参照・互換性境界は[Release Notes](../releases/README.md)を参照する。
