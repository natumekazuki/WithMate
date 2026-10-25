# Git履歴とcommit preview

## 概要

Session WindowのFile Explorerから、認可済みGit rootのcommit履歴とcommit時点のfileを参照できます。作業ツリーの現在状態を扱う`Changes`とは別のread-only機能です。

## Historyタブ

`History`タブでは、File Explorerに含まれるGit rootごとに次の情報を表示します。

- commitのhash、subject、author、日時
- commitが指すHEAD、branch、tag。共通のbadgeで表示し、文字markerとlabelによって色だけに依存せず種類を区別します。
- 選択したcommitに含まれるfile
- commit全体または一つのfileに限定した差分
- commit時点のfile preview
- 同じcanonical Git repositoryを複数rootから参照する場合は、History repositoryを一つにまとめます。
- repository discoveryでは存在するGit repositoryだけを公開し、non-Gitまたはmissing rootはrepository一覧へ追加しません。履歴出力が上限を超えた場合は成功結果として表示しません。
- branch selectorは`refs/heads`にあるlocal branchだけを対象とし、remote-tracking branchは表示しません。detached HEADまたはbranchがないrepositoryでは、branchを選択するまでcommit listを表示しません。
- 同一rootのrefreshでは選択中branchを保持し、root変更では新しいrootのcurrent branchを初期選択します。選択branchが削除された場合は、利用できない状態を表示します。現在選択中のbranchには表示label `Current`を付けます。
- merge commitのdetailとdiffはfirst parentとの比較として表示します。

履歴やfile一覧はpage単位で読み込み、commit listの追加pageは表示中の専用scroll rootの末尾sentinelが表示領域に入ったときに取得します。初回表示・tab／pane／Windowの復帰、関連Main／Auxiliaryのturn終端、`Refresh`でrepository・refs・一覧を更新します。非表示中は新しい取得を開始しません。

同一repositoryの更新では取得済み内容、選択中branch、commit詳細、Compare、中央Diffと閲覧位置を保持し、失敗は内容を残したまま理由を表示します。詳細／Compareを閲覧中のcommit list更新は一覧へ戻るまで延期します。一覧更新は取得済み件数を目安に先頭からpageを取り直し、新しい先頭と古いoffset cursorを混在させません。repositoryや認可rootの選択を変更した場合は旧表示と非同期取得を失効させ、新しい選択へ旧応答を反映しません。

commit詳細の取得失敗は、エラー詳細を開閉するiconと`Retry Commit Detail`の再試行iconを表示します。診断文は初期状態では折りたたみ、エラーiconを操作すると原文を表示します。再試行中も詳細の開閉状態と操作の位置を保持し、成功後は取得した詳細へ戻ります。

## Compare

`Compare`はHistoryの同じpane内で起動し、4つ目のtabや別のdiff実装は追加しません。toolbarまたはcommit entryから開け、commit entryからはそのcommitをbaseの初期値にします。通常のtargetは表示中branchです。

比較対象にはlocal branch、remote-tracking branch、tag、`HEAD`、short/full commit object IDを指定できます。annotated tagはtag refとして解決し、入力されたref名をそのままGitの引数へ渡しません。

- `Direct comparison`は解決したbase commitからtarget commitまでを比較します。
- `Branch changes`はbaseとtargetのmerge-baseからtargetまでを比較します。merge-baseがない場合や複数ある場合は、空の差分と混同しないエラーとして表示します。
- 比較開始時に解決したcommit object IDをsnapshotとして保持します。refが移動しても表示中のpatchを別のcommitへ差し替えず、`Compare`の再実行で明示的に更新します。File Explorerの`Refresh`は比較結果や開いているDiffを再取得しません。
- changed file listは既存のChangesと同じtree shell、filter、`Open All Changes`を使います。patchは選択したfileまたは全fileを必要時に取得し、rename、add、deleteでは利用可能なbefore / after previewをそれぞれ表示します。
- nested rootではrepository全体ではなく、そのrootに認可されたrelative pathだけを比較対象にします。working tree、index、checkout、fetch、worktreeの作成は行いません。
- 変更なし、invalid selector、commit not found、merge-base unavailable / ambiguous、Gitの上限超過・実行失敗は別の結果として扱います。

## commit時点のFile Preview

commitに含まれるfileは、中央surfaceまたは独立したFile Preview Windowで開けます。表示形式は通常のFile Previewと同じ判定を使い、text、Markdown、JSON、YAML、画像などを表示します。

差分から`Open Preview`を実行すると、同じcommitとGit rootに属するfileを開きます。commit previewから現在の作業ツリーへ暗黙に切り替えません。

## 安全境界

- Git commandは認可済みrootをworking directoryとして実行します。
- user設定由来のclean filterやprocess filterを実行しません。必要なfilterがあるrootでは、Historyを利用できない理由を表示します。
- repository root、relative path、commit objectを別rootの値と混在させません。
- blobとdiffには読込上限を設け、無制限にmemoryへ展開しません。
- HistoryのGit出力にも上限を設け、上限を超えた履歴を成功結果として公開しません。
- Historyはread-onlyであり、checkout、reset、commit作成などrepositoryを変更する操作は行いません。

## 関連文書

- [Desktop UI](../design/desktop-ui.md)
- [ADR 020: File Preview Window Navigation](../adr/020-file-preview-window-navigation.md)
