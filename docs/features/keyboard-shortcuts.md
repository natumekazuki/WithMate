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
- Mainの最下部へ移動（`Scroll Main To Bottom`。初期は未割当）
- 選択中Auxiliaryの最下部へ移動（`Scroll Auxiliary To Bottom`。初期は未割当）
- 下部パネルのPromptとTerminalの切り替え（既定はWindows／Linuxで`Ctrl+Shift+T`、macOSで`Cmd+Shift+T`）
- message送信（Windows／Linuxは`Ctrl+Enter`、macOSは`Cmd+Enter`。実行中は次Turnを予約）
- Codexの実行中追加入力（Windows／Linuxは`Ctrl+Shift+Enter`、macOSは`Cmd+Shift+Enter`。現在のComposer下書きを現在Turnへ送信）

固定操作やOSと衝突しやすい操作は変更対象にしません。

末尾移動の2commandは既存割当を維持するため初期キーを持たず、`Not Assigned`と表示します。`Change`でそれぞれ登録したキーだけが有効になり、`Reset`で指定commandだけ未割当へ戻ります。未割当commandはキーを予約せず、他の有効な保存済み割当を変更しません。

## command scope

shortcut commandは、chat、file preview、入力欄、dialogなどのscopeを持ちます。同じキーに複数の候補がある場合も、現在activeなsurfaceだけを対象にします。

入力要素がfocusされている場合、文字編集と競合するcommandは実行しません。中央surfaceが切り替わった場合、非表示surfaceのhandlerを候補に含めません。

MainとAuxiliaryの末尾移動はそれぞれ独立して登録でき、Composer入力中も使えます。送信対象やfocusを切り替えず、指定した表示中の列だけ末尾へ移動して最新messageへの追従を再開します。未取得・折りたたみ中の列、Auxiliaryの読込中・取得失敗、中央Preview表示中は実行しません。

端末本文ではPrompt／Terminal切替だけをアプリshortcutとして扱い、会話送信・検索・cancelなどは横取りしません。切替はcomposer内でも利用でき、IME変換中とkey repeatでは発火しません。

端末への貼り付けは`Ctrl+Shift+V`、Windowsでは`Ctrl+V`も使えます。Windowsの`Ctrl+V`はWSL内でもClipboardの内容を貼り付け、シェルへの制御文字送信には使いません。macOSの標準貼り付けは`Cmd+V`を使い、macOS／Linuxの`Ctrl+V`はシェルへ渡します。

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
