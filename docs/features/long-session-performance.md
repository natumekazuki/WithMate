# 長いSessionの性能改善

## 概要

Session数やmessage数が増えた場合の操作遅延と本文保持量を抑えるため、一覧・会話の分割取得、message縮小previewの再利用、running turn開始時の差分保存を行います。

## 会話の読込み

Main／Auxiliaryは最初に最新60件を表示します。`Earlier Messages`／`Later Messages`で過去・後続の範囲へ移動し、最新への移動で追従を再開できます。表示済みページを無制限に積み上げず、最新tailと閲覧中のpageだけを保持します。

Findの検索対象とMessages navigatorのBookmarkは保存済み全履歴です。Source／Previewの検索の意味は変えず、検索結果やBookmarkへ移動すると対象範囲の本文を取得します。履歴の保存位置を使うため、ページを変えても別messageへBookmarkやDetailsの操作が移りません。

非表示Auxiliaryの再取得可能な詳細cacheは8件を上限とします。実行中・未保存変更・処理中などの保護対象は別に保持し、draft／caretと保存処理は表示cacheの解放と独立して継続します。

保存済み履歴を削除・要約する変更ではなく、Providerへ渡す文脈も変えません。単一messageの大きさ、全文検索の走査、検索・navigatorの結果metadata、実行中のruntime保持量は引き続き履歴や内容に依存します。

## Home Session一覧

`RecentSessions`はsummary page単位で取得します。Home起動や一覧更新のたびに、全Sessionのmessage本文とJSON columnを展開しません。

詳細は[Home Session一覧のpagination](home-session-pagination.md)を参照してください。

## message縮小preview

縮小previewはmessage identityと本文に対応付けて再利用します。composerへの入力、別messageのstreaming、paneの開閉だけでは、保存済み履歴全体のpreviewを再計算しません。

検索による一時展開は表示状態だけを変更し、preview cacheのownerを変更しません。

## running turn開始時の保存

turn開始時は対象Sessionのuser message、running状態、必要なsnapshotだけをtransactionへ渡します。全Sessionの保存済みmessageを再構築して書き直しません。

詳細は[running turn開始時の永続化](running-turn-start-persistence.md)を参照してください。

## 維持する契約

性能改善後も、次の動作は変更しません。

- Homeの検索、pin、open状態
- Sessionの全messageへ到達できること
- message縮小と検索の連携
- turn開始後に再起動してもuser messageとrunning状態を復元できること
- 保存失敗時に送信成功として扱わないこと

## 会話読込みの計測

`scripts/benchmarks/benchmark-conversation-storage.mjs`は一時DBへMainと20個のAuxiliaryを各6,000件・本文1KiBで作成し、productionのstorage Worker経由で取得件数・本文bytes・JSON応答bytes・所要時間・メモリを記録します。保存先は検証用の空ディレクトリーを明示します。

```powershell
node --import tsx scripts/benchmarks/benchmark-conversation-storage.mjs --mode view --label current --output-dir <検証用ディレクトリー>
```

`scripts/benchmarks/benchmark-conversation-loading.cjs`は合成API fixtureと実Electron IPC・rendererを使い、非表示Windowで初回読込み、Auxiliary反復切替、processメモリ、描画・操作を記録します。通常アプリのuserDataは使いません。`npm run build:renderer`後に実行します。

```powershell
npx --no-install electron scripts/benchmarks/benchmark-conversation-loading.cjs --page-size 60 --label current --output-dir <検証用ディレクトリー> --verify-ui
```

JSON応答bytesはIPC framingを含まない見積りです。メモリは強制GCを行わない観測値で、Workerは別processではなくthreadです。単回の時間・メモリ値を実利用環境の改善保証として扱いません。保存境界の計測とrenderer fixtureの操作確認を分けて評価します。

## 関連文書

- [Electron Session Store](../design/electron-session-store.md)
