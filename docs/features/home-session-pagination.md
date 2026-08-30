# Home Session一覧のpagination

## 概要

Home WindowのRecent Sessionsは、Session本文を含む全件読込ではなく、一覧表示に必要なsummaryをpage単位で取得します。Session数が増えても、Home起動時のdatabase読込とrendererへの転送量を一定範囲へ抑えます。

## 一覧の読込

最初に先頭pageを取得し、一覧末尾へ到達した時点で次のpageを追加します。追加読込中は既存のrowを残し、同じpageを重複して要求しません。

summaryには、一覧表示、検索、pin、open状態の判定に必要な項目だけを含めます。message本文、audit log、Character snapshot本文などは一覧queryで展開しません。

## 再取得時の状態維持

Sessionのtitle、pin、実行状態などが更新された場合は一覧を再取得します。既に複数pageを読み込んでいる場合、先頭pageだけへ戻さず、同じ範囲を再構成します。

再取得後も可能な限りscroll位置を維持します。削除や検索条件の変更でrow集合が変わった場合は、現在の結果に合わせて位置を調整します。

## queryの分離

Home用summary page、open Sessionの詳細、検索条件は別の契約として扱います。Home一覧の性能改善を理由に、Session Windowが必要とする詳細情報をsummaryへ追加しません。

database更新通知にはquery generationを使用します。古いgenerationの非同期結果を、更新後の一覧へ反映しません。

## 関連文書

- [Data Loading Performance Audit](../design/data-loading-performance-audit.md)
- [Electron Session Store](../design/electron-session-store.md)
