# メッセージ画像のlightbox

## 概要

chat messageに表示されたraster imageを、message columnの幅に制限されないlightboxで確認できます。File Previewと共通の画像viewportを使い、拡大率と表示位置を管理します。

## 開き方と終了

message内の画像を選択するとlightboxを開きます。背景またはclose操作で元のmessageへ戻ります。lightboxを閉じてもSessionのscroll位置とmessage本文は変更しません。

## 画像操作

lightboxでは次の操作を利用できます。

- Zoom Out
- Zoom In
- 100%
- Fit
- Reload
- Copy Image

`Fit`はviewportと画像の寸法から倍率を計算し、実際の描画へ反映します。100%を超えて表示する場合は、画像をpanして確認できます。

`Copy Image`は表示中のbitmap内容をclipboardへコピーします。file objectをコピーする`Copy File`とは別の操作です。

## 状態の境界

- 別の画像を開いた場合は、前の画像のzoomとpanを引き継ぎません。
- load失敗時は失敗状態を表示し、以前の画像を成功したように残しません。
- message画像の操作はmessage owner内に置き、本文layoutへ常設の余白を追加しません。

## 関連文書

- [WindowsのCopy File](windows-file-object-copy.md)
- [Message Rich Text](../design/message-rich-text.md)
