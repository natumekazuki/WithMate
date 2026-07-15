# 003 Session Message Virtualization

- 状態: Accepted
- 日付: 2026-07-15

## Context

Session UI は履歴をすべて renderer の state に保持したまま、表示開始位置だけを 80 件単位で前方へ広げていた。この方式では過去履歴を読み込むたびに DOM と Markdown render の対象が累積し、composer の draft 更新でも同じ React tree が再評価されるため、長い Session ほど文字入力が重くなる。

メッセージには Markdown、artifact、approval、Auxiliary group など可変高の要素があり、固定行高の windowing ではスクロール位置と表示内容がずれる。現メジャーバージョンでは永続化 API や schema を変更せず、renderer の負荷を抑える必要がある。

## Decision

- Session message list は `@tanstack/react-virtual` を使い、全履歴のうち viewport 周辺だけを DOM に描画する。
- 行高は推定値で開始し、描画済み要素を計測して補正する。末尾追従と上方向の読み返し位置を維持する。
- composer の再描画境界と message list の再描画境界を分離し、draft だけが変化した場合は message list と既存 Markdown を再描画しない。
- Message Markdown は入力 props が変わらない限り再描画しない。
- DB schema、Session 読み込み API、永続化方式は変更しない。履歴量そのものが renderer memory や IPC の問題になる場合は、別変更で cursor pagination を設計する。

## Alternatives

### 80 件単位の累積表示を維持する

実装変更は小さいが、読み込んだ履歴が DOM に残り続けるため、長時間利用時の負荷を解消できない。

### 固定行高で自前 virtualize する

依存追加は不要だが、可変高 Markdown、artifact 展開、pending content に対して位置補正が不正確になる。

### DB と IPC を cursor pagination 化する

renderer memory と初期転送量まで抑えられるが、永続化 contract と migration を含む変更になる。当面の運用を安定させる今回の範囲を超える。

## Consequences

### Positive

- Session が長くなっても、DOM と Markdown render の量は viewport 周辺に制限される。
- 文字入力時に既存 message list を再描画しないため、履歴長に比例する入力遅延を避けられる。
- DB migration なしで既存データをそのまま利用できる。

### Negative

- renderer に仮想化ライブラリへの依存が増える。
- 行高計測後にスクロール位置補正が入るため、可変高 content と follow mode は実機確認が必要になる。
- 全履歴は引き続き renderer memory に存在し、巨大 Session の IPC 転送量と memory 使用量は残る。
