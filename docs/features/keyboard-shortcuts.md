# キーボードショートカット

## 概要

WithMateのkeyboard操作はshortcut registryで管理します。各画面が独立したkeydown handlerを増やすのではなく、command、scope、既定binding、変更可否を一つのregistryへ登録します。

## Settingsでの変更

Settingsの`Keyboard shortcuts`では、変更可能なcommandの現在値を確認し、新しいキーを登録できます。登録を取り消して既定値へ戻すこともできます。

変更対象には次の操作が含まれます。

- messageの検索
- messageの一括縮小と展開
- file preview内の検索
- MarkdownのPreviewとSourceの切り替え
- message送信

固定操作やOSと衝突しやすい操作は変更対象にしません。

## command scope

shortcut commandは、chat、file preview、入力欄、dialogなどのscopeを持ちます。同じキーに複数の候補がある場合も、現在activeなsurfaceだけを対象にします。

入力要素がfocusされている場合、文字編集と競合するcommandは実行しません。中央surfaceが切り替わった場合、非表示surfaceのhandlerを候補に含めません。

## 登録時の検証

次のbindingは保存しません。

- shortcutとして成立しない入力
- OSまたはWithMateが予約している組み合わせ
- 同じscopeで既存commandと競合する組み合わせ
- 変更を許可していないcommandへの上書き

不正な保存値を読み込んだ場合は、そのcommandの既定値を使用します。

## 関連文書

- [Session messageの縮小表示とnavigator](session-message-collapse-and-navigation.md)
- [Markdown表示とcode block操作](markdown-rendering-and-code-actions.md)
