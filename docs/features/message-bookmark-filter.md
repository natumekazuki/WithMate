# Messageのブックマークとnavigator絞り込み

## 調査結果

### 対象画面と利用者

対象は通常SessionのMain会話、同じchat shellに表示される選択中Auxiliary、Companion Reviewの通常会話画面である。いずれも共通のmessage columnと右ペインのMessages navigatorを使うため、modeごとに専用の表示構造は作らない。

保存済みのuser / assistant messageを読み返す際、あとで戻りたい発言を個別に残し、右ペインから一覧を絞り込んで移動できることを中心体験とする。live assistant、pending bubble、streaming中の仮想messageは保存済みの対象ではないため、ブックマーク対象から除外する。

### 保存経路

- 現行SessionのV6保存はmessage body JSONを正本としているため、`Message`のbookmark stateを同じJSONへ保存する。
- Auxiliaryはpayload JSON内のmessagesが正本であり、同じ`Message`形状を通す。
- V1のmessages JSONは既存の`normalizeMessage`を通る。V2/V3/V4系の構造化message tableでは、`is_bookmarked INTEGER NOT NULL DEFAULT 0`を追加し、既存DBには起動時に不足列を追加する。
- 保存時は投影側の一時keyや表示配列のindexを識別子として保存しない。現在のsourceが示す元Session / Auxiliaryのmessage位置を使ってmessage本体を更新する。
- ブックマーク解除はfalseを残すのではなく、既存のoptional fieldを除去して保存する。未指定とfalseはUI上どちらも未ブックマークとして扱い、旧データはfalse相当になる。

### UI仕様

- 各保存済みmessageの本文付近に、ブックマークの追加 / 解除を行うbuttonを置く。buttonはアイコンだけにせず、accessible name、`aria-pressed`、visible focus、keyboard activationを持つ。
- 右ペインのMessages navigator上部に`すべて` / `ブックマーク`の二択だけを置く。初期値は`すべて`で、選択状態は`aria-pressed`と色以外のstate表現で判別できるようにする。
- 絞り込み中もnavigatorの既存のclick、Enter、Arrow操作とmessage jumpを使う。絞り込みはnavigatorの項目だけに適用し、本文側のmessage projectionやjump keyは変更しない。
- session / targetを切り替えたら絞り込みは`すべて`へ戻す。ブックマークが0件の場合は短いempty stateを表示し、Messages paneが説明文で膨らまないようにする。

## 採用理由

既存のMessage projection、storage normalize、共通chat shellを使えば、Main / Auxiliary / Companionで同じ表示・移動・保存契約を共有できる。別bookmark tableや新しいhash / ledgerは、今回必要な個別messageの保存と復元に対して責務と更新競合を増やすため採用しない。表示だけのReact stateも再起動後に失われるため採用しない。

検索、tag、複数カテゴリ、bookmark専用一覧、live messageの一時保存は今回の目的に含めない。

## 検証範囲

projectionのbookmark伝播とnavigator絞り込み、V6 / Auxiliary / 旧構造storageの保存・復元、旧データの既定値、既存のjump key維持をtargeted testで確認する。TypeScript型検査とproduction buildも実行する。

Electron GUIの実描画・実機keyboard操作は、この作業ではComputer Useの権限が与えられていないため未確認として扱う。test / typecheck / buildの成功を視覚確認の代替にはしない。
