# Session interfaceの変更

## 概要

v6.3.25では、Session Windowの操作を既存のchat layoutへ収束させ、補助操作や状態表示が本文と競合しないように整理しました。

## messageの補助操作

copy、quote、artifact details、message縮小などの補助操作は、対象messageのowner内に配置します。操作列を通常のlayout flowから分離し、操作のためだけに全messageへ余分な高さや幅を確保しません。

hover、focus、選択中など操作が必要な状態で表示し、keyboard focusでも到達できるようにします。

## HeaderとDetailsのgroup

Session headerの関連操作は一つのgroup surfaceへまとめます。headerの表示状態を切り替えた場合も、buttonの並びと境界を維持します。

message artifactの`Details`では、複数operationをばらばらのcardへ分けず、一つのgroup内に並べます。各operationの種類、summary、詳細は識別できる状態を保ちます。

## Action Dock

通常幅ではprovider設定のlabelとvalueを横方向にまとめ、選択肢の幅に応じて配置します。Send buttonは設定行の中央へ揃えます。

narrow layoutでは無理に一行へ固定せず、既存のresponsive layoutへ戻します。

## blocked状態と送信エラー

workspaceの再検証中やprovider設定によるblocked状態は、prompt送信後に発生したruntime errorと別に保持します。再検証結果で直前の送信エラーを上書きせず、利用者が次に直す対象を区別できるようにします。

## 中央surface

message list、File Preview、Git Diff、commit history preview、Prompt Template、Skill pickerは相互排他で表示します。非表示surfaceの操作やshortcut handlerをactiveなsurfaceへ混在させません。

## 関連文書

- [Desktop UI](../design/desktop-ui.md)
- [Prompt Template workspace](prompt-template-workspace.md)
- [Session messageの縮小表示とnavigator](session-message-collapse-and-navigation.md)
