# decisions

## status

- 進行中

## 決定

- `New Session` の last-used selection は global 1 件ではなく、選択中 provider に一致する直近 session から引く
- launch dialog 自体には model / depth / custom agent を追加せず、session 作成時の hidden default として引き継ぐ
- 既存 session を開いた時の selection 復元は current session metadata をそのまま使い、今回の変更対象に含めない
