# Development Workflow

WithMateのコード変更、検証、課題管理、Git操作の運用規則です。[Agent Guide](../../AGENTS.md)から作業内容に応じて参照します。

## 回答と変更

- ユーザーへの回答、生成ドキュメント、コミットメッセージは日本語で書く。repository内のファイルはrepository root相対pathで示す。不明な仕様、API、依存関係は実装・設計文書・既存testを確認し、未確認のまま断定しない。
- TypeScriptは`strict`、ES modules、`NodeNext`、React JSX runtimeの既存構成に合わせる。既存コードの2 spaces、double quotes、末尾セミコロンを基本とし、ファイル名はkebab-case、React componentは既存に合わせてPascalCaseを使う。
- 共通処理は既存helperとservice層へ寄せ、無関係な整形・rename・refactorを混ぜない。生成物、ドキュメント、commitにsecret、token、個人環境の絶対pathを残さない。

### ソースコメント

保守するソースの説明は日本語で書きます。ライセンス・著作権表示、識別子、API名、JSDocタグ、コマンド例、compiler／bundler／lint指示、`@test-value`等の機械向けメタデータは意味と形式を維持します。生成物・同梱の外部コードは直接翻訳せず、必要なら管理している入力ソースを直します。テスト内の文字列やfixtureが再現する原文は翻訳対象にしません。

- 名前付きの型・クラス・関数・メソッド、公開変数、関数値を持つ変数／プロパティには、宣言の直前に本文のある日本語のJSDoc（`/** … */`）を置きます。非公開の処理・メソッドも対象です。必要に応じて契約・前提・結果・副作用・エラーを記します。名前のない一般のコールバックにはJSDocを要求しません。
- `node:test`の登録・suite・setup／teardownは登録する式文／return文の直前にJSDocを置きます。名前付き・別名・default／namespace import、`test.only`等の修飾、コールバック引数経由の`t.test`等も対象です。守る条件、期待する観測結果、検出したい故障を自然文で説明します。テスト名だけで代用せず、既存メタデータがある場合はその後ろに置きます。
- `if`／`else`、`switch`の各処理枝、ループ、`try`／`catch`／`finally`は、直前または本文先頭の通常コメントで目的を説明します。処理が合流するcase群は合流先に説明を置きます。同じブロック内の連続する変数宣言・式文・return・throwは、目的を示す通常コメントで12文以内に区切ります。別ブロックやネストした関数内の説明、宣言のJSDoc、空コメント、メタデータ、文字列中のコメント風の記述で代用しません。

Gitが追跡する通常ファイルのJS/TS系（JSX、TSX、MJS/CJS、MTS/CTSを含む）を既存のPrettier TypeScript parserで解析します。再生成するSession／Glossary CLI同梱物2ファイルは検査対象外です。他形式の説明やコメントと実装の一致、根拠、説明の十分さはレビューで確認します。lintは日本語の文字を含む説明の有無・位置・形式を確認するもので、文章の意味や全行の翻訳までは判定しません。

初回導入で既存宣言に一律の追記はしません。差分のJS/TSファイルについて、比較元に同じ規則・所属・対象の違反があれば、その件数まで引き継ぎます。新規ファイルは既存違反なしとして扱い、日本語の説明を削除するなど新たな違反があれば非ゼロ終了します。Gitが検出したrenameは旧パスを比較元にし、削除は新規違反にしません。旧違反の全解消や、同じ構文・名前に見える箇所の間での違反の移動は保証しません。

## 実装境界

Main、preload、renderer、CLIの境界をまたぐ型・定数・正規化処理は、`src-shared/`のIPC、session、settings、characterなどのdomainを正本とします。利用側は必要なdomainから直接importし、共有層へReact・DOM・Electron・filesystem・DBの実装を持ち込みません。

Chat layout preferenceの型・既定値・検証は`src-shared/settings/chat-layout-preference.ts`に置き、保存APIを呼ぶrenderer adapterは`src/chat/chat-layout-preference.ts`に置きます。

### MCPとCLIの機能・操作契約

WithMateが提供するMCPまたはCLIの機能を追加・変更・廃止するときは、対応するもう一方の入口も同じ論理変更で反映します。公開操作、入力の意味、対象Session、権限、返却情報、保存効果、エラーの意味を両入口で揃え、片側だけの実装で完了としません。表記形式やprotocolのbootstrapは異なっても、別機能による代替や権限の拡大を対応済みとは扱いません。

業務ロジック・認証認可・保存は既存のapplication boundaryを利用します。実装・reviewの完了確認では全変更操作の対応、配布CLIの入口とhelp、MCP schemaと利用説明を照合し、両入口の実呼出経路で正常系と契約上必要な失敗系を確認します。

## 報告

- 通常の作業報告は、実施した変更・観測した結果・判断に必要な事実を中心に記載する。検証結果には、その意味を理解するために必要な対象・条件・実施内容を添え、未実施事項を網羅的に列挙しない。
- 観測事実と評価を分け、エージェント自身の確認範囲を製品全体の品質・動作評価へ置き換えない。判断に影響する既知の失敗、不具合、利用上の制限、具体的な安全上の懸念は報告する。検証の失敗は今回の変更との関係を区別し、必須確認が実施できない場合は完了判断への影響と理由を示す。この報告方針は必須確認を免除せず、失敗・結果不明・未実施を成功へ読み替えない。
- リリースノートは[Release Notes](../releases/README.md)の記載規則に従う。変更内容とその利用者への影響を事実として記載し、動作確認や検証状況、作業の自己評価や免責的な定型文は加えない。

## 検証

- 変更種別に合う最小のtargeted testを優先する。永続化、migration、IPC、provider adapterを変更した場合は、関連testに加えてTypeScript型検査を実行する。
- UI変更では、可能ならstate、projection、componentのtestを追加または更新する。UI変更やbranch固有のsmoke・目視確認が有効なら、[分離したvisual check](#分離したvisual-check)をユーザーへ提案する。実行時は対象Worktreeのrootからscriptを呼び、検証用processの差し替えを明示する。
- 起動・build・testのコマンドは[README](../../README.md#開発と検証)、実行定義は`package.json`と各scriptを参照する。
- 開発時の変更範囲に必要な検証と、リリース後の利用確認を分ける。Issueの完了・preview利用後の受入・不具合発見後の追跡は[課題の対応予定と完了運用](#課題の対応予定とmilestone)に従い、全実機確認項目の消化を各IssueのClose条件にしない。

### 型検査と依存境界

`typecheck`はSQLite実行ownerと依存方向のcheckも実行します。依存方向checkは`src/`、`src-shared/`、`src-electron/`、`src-cli/`全体のimport・re-export・dynamic importをtype-onlyも含めて検査します。

RendererとsharedからNode/Electron/Provider SDKへの依存、sharedからReactへの依存、および実行環境の境界を逆流する相対importを拒否します。

preloadはpreload内とshared、CLIはCLI内とsharedおよび限定したMainのplatform adapterを参照できます。Storage Workerの検証済みhandler entryだけは動的解決を許可し、実際のentry解決をWorker testで確認します。

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

撮影は、そのdebug接続で対象rendererのタブを選び、ブラウザー用のスクリーンショット機能でPNGへ保存します。対象の画面・viewport・選択状態を記録し、保存した画像を開いて内容を確認します。

非表示のブラウザーでproduction componentを確認するfixtureは作業SessionFolderに置き、実データや認証・認可の迂回に依存させません。APIを置き換えた箇所は確認結果へ明記し、実IPC／storageの確認と区別します。画像もSessionFolderに保存し、機密情報がないことを確かめて返答へ埋め込みます。可視Windowやデスクトップ操作が必要な場合は、agentの操作許可を別途確認してください。

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
- Closeやpreviewの受入判断と個々の検証結果は別に扱います。作業報告やIssue／PRでの結果の記載は[報告方針](#報告)に従います。

不具合が見つかった場合は、Open／Closedを含めて既存Issueを検索し、同じ現象・原因を扱うIssueへ追記するか、新規Issueを作成します。元Issueを継続して扱う場合は必要に応じて再Openし、新規Issueでは重複・原因になったIssueを関連付けます。発生したバージョン、再現条件、影響、判明している原因を記録し、推測と確認済みの事実を分けます。

重複・不採用によるクローズは修正完了と区別します。予定変更時は理由と変更後の扱いをIssue／PRへ記録し、残件を隠すために移動・クローズしません。

リリース範囲の確定時と公開判断時は、対象Milestoneの未完了Issueに加え、未割当ての関連Issueの取りこぼしを確認します。preview tagではMilestoneを閉じず、正式版の公開と対象Issueの完了・正当な延期を確認してから閉じます。タグとリリースノート、互換性境界は[Release Notes](../releases/README.md)の規則に従います。

## Git

- commitは一つの論理変更単位を基本とし、messageはConventional Commits形式を使う。commit前に`git status --short`を確認し、ユーザー由来の無関係な変更を混ぜない。
- `AGENTS.md`はユーザーが明示するまでcommitしない。pushはユーザーが明示した場合だけ実行する。
- 通常の実装commitをリリースとみなさず、リリース規則だけでtag付与、push、外部公開を許可されたと解釈しない。releaseの保存・参照・互換性境界は[Release Notes](../releases/README.md)を参照する。

### Git hookの有効化

Node.jsとGit（WindowsではGit for Windows）をPATHに置き、`npm ci`で依存を準備してください。リポジトリの `.githooks/pre-commit` は自動登録されません。

1. `git config --show-origin --get core.hooksPath` で設定を確認します。未設定の場合も、`git rev-parse --git-path hooks` のディレクトリに有効なhookがないか確認します（`*.sample`は対象外）。
2. **単独cloneで既存hook／hook pathがない場合**は、リポジトリrootで `git config --local core.hooksPath .githooks` を実行すると、以後のコミットで自動実行します。既存hookがあれば上書きせず、既存のhook管理方法で `npm run check:staged` を組み込み、非ゼロ終了をコミットに返してください。
3. **linked worktree**の `--local` 設定はほかのworktreeと共有されます。すでにworktree固有の設定を利用できる場合のみ、既存hookを確認して `git config --worktree core.hooksPath .githooks` を選べます。共有設定を変えない場合は `npm run check:staged` を手動実行するか、既存hookがないことを確かめて `git -c core.hooksPath=.githooks commit ...` でその1回だけ有効にします。

hookと `npm run check:staged` は検査入口をindexから読み込み、空白／衝突マーカー検査とコメントlintを実行します。lintに失敗したらテストに進みません。コード・テスト・実行設定などの変更では、検査自体の回帰テスト、配布設定のsmoke、ステージ済みの `tests/**/*.test.ts(x)` を実行します。ファイルはindexのtreeから一時展開し、インストール済みの `node_modules` だけを再利用します。package manifestやlockfileを変更した場合は、対象内容に合う依存を先にインストールしてください。検証中にindexが変わった場合は再実行を要求します。未ステージ／未追跡の作業ファイルは検査対象に含みません。

文書など対象外の変更ではテストを省略し、空の差分では検査対象なしと表示します。コミット前のテストは全件の代わりではありません。実際の統合候補の差分は `npm run lint -- --base <比較元commit>`（Windows PowerShellでは `npm.cmd`）で検査できます。GitHub CIはPRのbaseまたはpush直前を比較元として同じlintを実行し、型・依存境界とテスト全体も検査します。
