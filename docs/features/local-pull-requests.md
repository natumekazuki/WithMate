# ローカル Pull Requests

GitリポジトリのSession Windowから **Pull Requests** を開きます。PRの記録、変更、レビュー、Checksは同じローカルリポジトリで共有されます。GitHubへのpush、PR作成、レビュー投稿は行いません。

## 提出とレビュー

1. **New Pull Request** でmerge先と変更元のcommitを選びます。未コミットのファイルは提出されず、自動commitやstashも行いません。
2. **Changes** で提出版とファイルを選びます。全体差分は提出時のmerge baseから、前回との差分は前回の提出commitから表示します。
3. PR全体、ファイル、行・範囲へ指摘を追加できます。下書きの保存・指摘だけでは会話は始まりません。前の版の指摘はそのまま以前の版に残り、変更された行へ付け替えません。
4. 必要な指摘を選んで同じリポジトリの既存Sessionへ送信します。コメントID、版、比較commit、選んだ範囲のコード文脈を通常のTurn queueに渡します。下書きを選んだ場合はPRのコメントとして先に公開し、その後にSessionでの受付を行います。受付が失敗しても公開済みコメントは残ります。そのSessionでの返答が、自動的にPR返信やApprovalになることはありません。
5. 修正後は同じPRに新しいcommitを提出します。merge先が進んだ場合も、新しい比較対象で提出し直してからレビュー・承認します。

## Checks

CI定義は、選択した提出commitに含まれる `.withmate/ci.yml` を自動検出します。作業ツリーで編集中のファイルや、アプリ側の別定義は使用しません。

```yaml
version: 1
commands:
  - node --version
  - node --run typecheck
```

`commands` はリポジトリのルートで順に実行します。Windowsは `cmd.exe`、macOSとLinuxは `/bin/sh` です。サンプルの `typecheck` は、対象リポジトリに同名のpackage scriptと検証に必要な依存関係がある場合の例です。

WithMateのOS権限でコマンドを実行します。提出commitの独立したcheckoutを用意しますが、Providerのsandboxではありません。Checksでは版ごとの定義、実行状態、結果、ログを確認し、取消または再実行できます。未設定、未実行、失敗、取消、アプリ終了等による中断を成功とは扱いません。以前の提出版の成功はその版の履歴です。

Windowsでは、アプリのデータ保存先が深くてもGitがcheckoutを準備できるよう、作業にはOSの一時フォルダーを使います。実行履歴とログの保存先は変わりません。

## 承認とmerge

**Approve** は、表示した提出commitとmerge先commitの組をGUIで承認します。承認を取り消したとき、新しい版を提出したとき、merge先が進んだときは、以前の承認ではmergeできません。CI結果は判断材料ですが、CIの成功は強制条件ではありません。

承認後の **Merge** は、GUI・MCP・CLIのどの入口からも同じ判定を通ります。merge先をcheckoutしているworktreeで、ブランチとcommitを再確認し、提出commitを指定して通常のGit mergeを実行します。merge先がどのworktreeにもcheckoutされていない場合は、Gitでcheckoutしてから同じPRで再実行してください。WithMateがブランチを切り替えることはありません。提出元の未コミット変更はmergeに含まれません。

Gitが対象ファイルに選ぶ外部merge driverやfilterは、WithMateのOS権限で実行されます。Gitが作業ツリーを確認する際にもfilterが実行されることがあるため、mergeが始まらずに拒否された場合でも、filterによる変更がないとは限りません。

merge先のworktreeに未コミットのtracked変更があれば開始しません。実行中は同じworktreeをほかの操作で編集したり、ブランチを切り替えたりしないでください。直前の確認とGitの実行は一体の操作ではありません。競合やGitの失敗で途中状態が残る場合は、対象worktreeをGitで確認してから再試行してください。WithMateは自動stash、強制reset、失敗時の自動巻き戻しを行いません。WithMate外で実行したGit操作に対しては承認を強制しません。

通常のGit mergeと同じく、追加されるファイルと同じ場所にあるignoredファイルは上書きされることがあります。残したいignoredファイルは、mergeの前に別の場所へ移してください。

## Agentの操作

WithMateが現在のSessionに注入する認証情報で、MCPの `session.pr_*` またはCLIの `withmate-session pr-*` を利用できます。CLIの `schema` で入力を確認できます。対象repoと利用者のSessionはruntime bindingから解決し、別Sessionの識別子や任意のパスを引数として使うことはできません。

Agentは提出・差分確認・コメントと返信・Checks・承認済みPRのmergeを行えます。承認や取消の代理操作はありません。WithMateで行った作業を統合するときは、PRを提出し、ユーザーのGUI承認を待ってからWithMate PR経由でmergeします。
