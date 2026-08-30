# Session Windowの復元

## 概要

WithMateは、アプリ終了前に開いていたSession Windowの集合を保存します。次回起動時に自動で全Windowを開くのではなく、Home Windowから利用者が明示的に復元します。

## 復元操作

Home右ペインの`Restore Sessions`は、保存された集合のうち現在開いていないSessionがある場合に利用できます。操作すると対象を順に開き、成功数と失敗したSessionをHomeへ表示します。

既にopenまたはopeningのSessionは重複して開きません。復元中に同じ操作を繰り返しても、同じSession Windowを複数作成しません。

## 保存する集合

復元集合は、Session Windowがopenまたはcloseになった時点で更新します。読込途中のWindowは、正常にopenしたことが確定するまで集合へ追加しません。

アプリ終了処理中も、最後に確定したWindow集合を保存します。復元操作自体で、まだ開けていないSessionを集合から先に削除しません。

## 失敗時の扱い

Sessionが削除済み、読取不能、open失敗の場合は、成功したSessionとは分けて結果を表示します。一つの失敗で、残りのSession復元を中止しません。

複数のHome Windowがある場合、復元操作と結果通知はprimary Homeへ集約します。

## 関連文書

- [Electron Session Store](../design/electron-session-store.md)
- [Desktop UI](../design/desktop-ui.md)
