# Session Windowの復元

## 概要

WithMateは、アプリ終了前に開いていたSession Windowの集合を保存します。次回起動時に自動で全Windowを開くのではなく、Home Windowから利用者が明示的に復元します。

## 復元操作

Home共通headerの`Restore Sessions`は、保存された集合のうち現在開いていないSessionがある場合に利用できます。操作すると対象を順に開き、復元できなかったSessionがある場合だけ対象と理由をHomeへ表示します。全対象の復元に成功した場合と、要求時点で対象がなくなっていた場合は、正常系のfeedbackを表示しません。

既にopenまたはopeningのSessionは重複して開きません。復元中に同じ操作を繰り返しても、同じSession Windowを複数作成しません。

## 保存する集合

復元集合は、Session Windowがopenまたはcloseになった時点で更新します。読込途中のWindowは、正常にopenしたことが確定するまで集合へ追加しません。

アプリ終了処理中も、最後に確定したWindow集合を保存します。復元操作自体で、まだ開けていないSessionを集合から先に削除しません。

起動時に読み込んだ未処理・復元失敗の対象は、現在openが確定したWindowと合わせて同じsnapshotへ保存します。復元途中に先行Windowの保存が走っても、残りの対象は次回起動の候補に残ります。手動でopenしたWindowを明示的にcloseした場合、そのSessionは未処理集合からも外し、進行中の復元で開き直しません。全対象が成功した後は現在openのWindowだけが保存対象になります。

## 失敗時の扱い

Sessionが削除済み、読取不能、open失敗の場合は、失敗したSessionと理由だけを表示します。一つの失敗で、残りのSession復元を中止しません。

複数のHome Windowがある場合、復元操作と結果通知はprimary Homeへ集約します。

## 関連文書

- [Electron Session Store](../design/electron-session-store.md)
- [Desktop UI](../design/desktop-ui.md)
