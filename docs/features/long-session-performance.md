# 長いSessionの性能改善

## 概要

Session数やmessage数が増えた場合の操作遅延を抑えるため、Home一覧、message縮小preview、running turn開始時の保存を差分化しました。

## Home Session一覧

Recent Sessionsはsummary page単位で取得します。Home起動や一覧更新のたびに、全Sessionのmessage本文とJSON columnを展開しません。

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

## 関連文書

- [Data Loading Performance Audit](../design/data-loading-performance-audit.md)
- [Electron Session Store](../design/electron-session-store.md)
