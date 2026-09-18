# Messageのブックマークとnavigator絞り込み

## 調査結果

### 対象画面と利用者

対象は通常SessionのMain会話と、同じchat shellに表示される選択中Auxiliaryである。共通のmessage columnと右ペインのMessages navigatorを使うため、modeごとに専用の表示構造は作らない。Companion Modeの新規作成・provider turn・ReviewからのAuxiliary起動は退役済みだが、既存Companionの履歴とReview UIは互換性のため維持される。そのため、今回のbookmark control / filterはCompanion Reviewへ追加しない。

保存済みのuser / assistant messageを読み返す際、あとで戻りたい発言を個別に残し、右ペインから一覧を絞り込んで移動できることを中心体験とする。live assistant、pending bubble、streaming中の仮想messageは保存済みの対象ではないため、ブックマーク対象から除外する。

### 保存経路

- 現行SessionのV6保存はmessage body JSONを正本としているため、`Message`のbookmark stateを同じJSONへ保存する。V4 Sessionの移行先も`messages_json`を使うため、bookmarkのための構造化message table列は追加しない。
- Auxiliaryはpayload JSON内のmessagesが正本であり、同じ`Message`形状を通す。
- Companionの保存形式や更新経路にはbookmark stateを追加しない。
- V1のmessages JSONは既存の`normalizeMessage`を通る。V2/V3 Sessionの構造化message tableでは、`session_messages.is_bookmarked INTEGER NOT NULL DEFAULT 0`を追加し、既存DBには起動時に不足列を追加する。Companion message tableには追加しない。
- 保存時は投影側の一時keyや表示配列のindexを識別子として保存しない。現在のsourceが示す元Session / Auxiliaryのmessage位置を使ってmessage本体を更新する。
- ブックマーク解除はfalseを残すのではなく、既存のoptional fieldを除去して保存する。未指定とfalseはUI上どちらも未ブックマークとして扱い、旧データはfalse相当になる。

### UI仕様

- 各保存済みmessageの本文付近に、`Add bookmark` / `Remove bookmark`を行うbuttonを置く。buttonは既存の縮小 / 展開controlと同じ本文上のhover / focus時だけ表示し、アイコンだけにせず、accessible name、`aria-pressed`、visible focus、keyboard activationを持つ。
- 右ペインのMessages navigator上部に`All` / `Bookmark`の二択だけを置く。初期値は`All`で、選択状態は`aria-pressed`と色以外のstate表現で判別できるようにする。filter toolbarは固定し、スクロール対象をmessage listだけにする。read-only Sessionでは既存messageの閲覧・filterだけを許可し、Add / Remove操作と永続更新は行わない。
- 絞り込み中もnavigatorの既存のclick、Enter、Arrow操作とmessage jumpを使う。絞り込みはnavigatorの項目だけに適用し、本文側のmessage projectionやjump keyは変更しない。
- session / targetを切り替えたら絞り込みは`All`へ戻す。`Bookmark`が0件の場合は説明文を表示せず、空のmessage listだけを保つ。

## 採用理由

既存のMessage projection、storage normalize、共通chat shellを使えば、Main / Auxiliaryで同じ表示・移動・保存契約を共有できる。既存Companion Reviewは閲覧互換を維持しつつ、今回のbookmark操作・filterの対象外に置く。別bookmark tableや新しいhash / ledgerは、今回必要な個別messageの保存と復元に対して責務と更新競合を増やすため採用しない。表示だけのReact stateも再起動後に失われるため採用しない。

検索、tag、複数カテゴリ、bookmark専用一覧、live messageの一時保存は今回の目的に含めない。

## 検証範囲

projectionのbookmark伝播とnavigator絞り込み、V6 / Auxiliary / 旧構造storageの保存・復元、旧データの既定値、既存のjump key維持をtargeted testで確認する。Companion storageにbookmark stateが追加されていないこともschema / storage testで確認する。TypeScript型検査とproduction buildも実行する。

Electron GUIの実描画・実機keyboard操作は、この作業ではComputer Useの権限が与えられていないため未確認として扱う。test / typecheck / buildの成功を視覚確認の代替にはしない。
