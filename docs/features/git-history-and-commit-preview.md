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

履歴やfile一覧はpage単位で読み込みます。repositoryやcommitの選択を変更した場合、以前の非同期取得結果を新しい選択へ反映しません。

## commit時点のFile Preview

commitに含まれるfileは、中央surfaceまたは独立したFile Preview Windowで開けます。表示形式は通常のFile Previewと同じ判定を使い、text、Markdown、JSON、YAML、画像などを表示します。

差分から`Open Preview`を実行すると、同じcommitとGit rootに属するfileを開きます。commit previewから現在の作業ツリーへ暗黙に切り替えません。

## 安全境界

- Git commandは認可済みrootをworking directoryとして実行します。
- user設定由来のclean filterやprocess filterを実行しません。必要なfilterがあるrootでは、Historyを利用できない理由を表示します。
- repository root、relative path、commit objectを別rootの値と混在させません。
- blobとdiffには読込上限を設け、無制限にmemoryへ展開しません。
- Historyはread-onlyであり、checkout、reset、commit作成などrepositoryを変更する操作は行いません。

## 関連文書

- [Desktop UI](../design/desktop-ui.md)
- [ADR 020: File Preview Window Navigation](../adr/020-file-preview-window-navigation.md)
