# Messageのブックマークとnavigator絞り込み

MainとAuxiliaryの保存済みuser／assistant messageにブックマークを付け、Session右ペインのMessages navigatorから`All`／`Bookmark`で絞り込める。streaming中の仮messageやpending bubbleは対象にしない。

本文付近の`Add bookmark`／`Remove bookmark` buttonはhoverまたはfocusで表示し、keyboard操作、accessible name、`aria-pressed`を備える。navigatorのfilterは項目一覧だけを絞り、会話本文やmessage jump keyを変更しない。`Bookmark`に対象がなければ一覧本文は空のままにする。Sessionまたは表示対象の会話を切り替えるとfilterは`All`へ戻る。read-only Sessionでは閲覧・絞り込みだけを許可する。

ブックマークは一時的な表示stateではなくmessageの保存値として保持する。MainのV6 messageとAuxiliary payloadのそれぞれの正本を更新し、解除時はoptionalなbookmark fieldを除去する。送信・投影の境界は[Desktop UI](../design/desktop-ui.md)と[Auxiliary Session](../design/auxiliary-session.md)を参照する。
