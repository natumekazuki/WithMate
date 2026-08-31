# Session messageの縮小表示とnavigator

## 概要

長いSessionで過去のmessageを読み返しやすくするため、messageの縮小表示とnavigatorを提供します。保存済みmessage本文は変更せず、表示状態だけをSession Window内で管理します。

## messageの縮小と展開

縮小対象のmessageには、本文領域に操作buttonを表示します。操作buttonのsticky範囲は本文内で完結し、展開したDetailsやartifact領域には追従しません。縮小すると本文の代わりに短いpreviewを表示し、再度操作すると元の本文へ戻ります。

個別操作buttonはaccessible nameと展開状態を持ち、hoverだけでなくkeyboard focusからも操作できます。

一括操作では、現在のSessionにある縮小対象をまとめて縮小または展開します。個別操作と一括操作は同じ状態を更新します。

## navigator

navigatorには、messageのspeaker、短いpreview、縮小状態を表示します。項目を選択すると、仮想化された履歴を含めて対象messageへ移動します。

navigatorは現在のSessionだけを対象とします。Sessionを切り替えた場合、前のSessionの選択や縮小状態を新しいSessionへ引き継ぎません。

## 検索との連携

検索結果が縮小messageに含まれる場合、そのmessageを検索中だけ一時展開します。検索を閉じた後は、利用者が設定した縮小状態へ戻します。

## keyboard操作

message縮小の一括切り替えはshortcut registryへ登録されています。割り当て変更が許可されているcommandはSettingsの`Keyboard shortcuts`から変更できます。

入力欄や別の中央surfaceがshortcutを所有している場合、message用commandを実行しません。

## 性能

縮小previewはmessage本文から生成します。一度生成したpreviewはmessage identityと本文が変わらない限り再利用し、composer入力やstreaming更新のたびに履歴全体を再計算しません。

## 関連文書

- [キーボードショートカット](keyboard-shortcuts.md)
- [長いSessionの性能改善](long-session-performance.md)
