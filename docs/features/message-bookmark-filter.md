# Messageのブックマークとnavigator絞り込み

MainとAuxiliaryの保存済みuser／assistant messageにブックマークを付け、Session右ペインのMessages navigatorから`All`／`Bookmark`で絞り込める。送信先の選択や会話の実行状態に関係なく、表示中の両会話で付与・解除できる。streaming中の仮messageやpending bubbleは対象にしない。

本文付近の`Add bookmark`／`Remove bookmark` buttonはhoverまたはfocusで表示し、keyboard操作、accessible name、`aria-pressed`を備える。navigatorのfilterは項目一覧だけを絞り、会話本文やmessage jump keyを変更しない。`Bookmark`に対象がなければ一覧本文は空のままにする。Sessionまたは表示対象の会話を切り替えるとfilterは`All`へ戻る。read-only Sessionでは閲覧・絞り込みだけを許可する。

ブックマークは一時的な表示stateではなくmessageの保存値として保持する。Mainの`session_messages_v6`とAuxiliaryの`auxiliary_session_messages`の対象行だけを更新し、解除時はoptionalなbookmark fieldを除去する。実行結果の保存は同じrole・本文の確定messageの最新Bookmarkを保持し、付与だけでなく解除も古いsnapshotで戻さない。rendererも遅れて届く実行結果・詳細読込み・失敗復旧で新しいBookmarkを維持し、Bookmarkだけの変更でterminal本文の反映を捨てない。保存失敗は成功扱いせず、owner・incarnationが変わった会話へ古い保存結果を適用しない。送信・投影の境界は[Desktop UI](../design/desktop-ui.md)と[Auxiliary Session](../design/auxiliary-session.md)を参照する。
