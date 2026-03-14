# Worklog

## Timeline

### 0001

- 日時: 2026-03-15
- チェックポイント: Plan 作成と Home card theme の初回適用
- 実施内容: Plan ディレクトリを作成し、Home の session card / character card に `main = 背景 / sub = 左アクセント` を適用した。前景色は helper で自動決定するようにした。
- 検証: 未実施
- メモ: 次は Character Editor と Session に同じ rule を広げる
- 関連コミット: 

### 0002

- 日時: 2026-03-15
- チェックポイント: Character Editor の小ウインドウ時レイアウト調整
- 実施内容: Character Editor を外側スクロール優先に変更し、内部スクロールの多重化を減らした。高さが足りない時は preview / form / role を縦積みに寄せるレスポンシブを追加した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: 次は配色 rule 自体を `ベース固定 + accent のみ character color` に揃える
- 関連コミット: 

### 0003

- 日時: 2026-03-15
- チェックポイント: Character Editor の情報整理
- 実施内容: 価値の低い `Updated` と `Mode` を削除した。`character.md` の常時表示をやめ、`Profile / character.md` の 2 モードに分離した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: `character.md` を分離したことで、小さいウインドウでも metadata 編集が崩れにくくなった
- 関連コミット: 

### 0004

- 日時: 2026-03-15
- チェックポイント: Character Editor の action 領域整理
- 実施内容: `Save / Delete` が別 panel として重なって見えていたため、右側 action 領域から panel の外枠を外した。action は独立領域として最小構成にした。
- 検証: `npm run typecheck`, `npm run build`
- メモ: 次は Character Editor 自体の配色を `ベース固定 + accent のみ character color` に寄せる
- 関連コミット: 

### 0005

- 日時: 2026-03-15
- チェックポイント: Character Editor の action bar 再配置
- 実施内容: 右カラム自体をやめて、`Save / Delete` を下部固定の action bar に移した。全画面でも小さいウインドウでも action の位置が一定になるようにした。
- 検証: `npm run typecheck`, `npm run build`
- メモ: Character Editor は `Profile / character.md` の本文と action を分離したので、次は配色整理に集中できる
- 関連コミット: 

### 0006

- 日時: 2026-03-15
- チェックポイント: Character Editor の footer 固定方式修正
- 実施内容: sticky footer をやめ、画面全体を `header / content / footer` の 3 段グリッドにした。footer は常に画面最下部、本文はその間だけスクロールする構成に変更した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: 重なりの原因は footer の overlay だった。本文側の高さ上限をグリッドで制御する形に寄せた
- 関連コミット: 

### 0007

- 日時: 2026-03-15
- チェックポイント: Character Editor の tabs 固定
- 実施内容: 当初 sticky 固定、その後スクロール領域外への分離を試したが、最終的に `Profile / character.md` の tabs はスクロール領域外へ置きつつ、背景色や固定レールは持たせない形に整理した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: tabs の位置は scroll container 外、見た目は素の切り替え行、という切り分けにした
- 関連コミット: 

### 0008

- 日時: 2026-03-15
- チェックポイント: Character Editor content 高さ調整
- 実施内容: 中央の content カードが利用可能高さを常に使い切るようにした。`character.md` 側だけ低く見える状態を解消し、editor も親高さに追従するようにした。
- 検証: `npm run typecheck`, `npm run build`
- メモ: 空白の原因は action bar ではなく、content カード自体が stretch されていなかったこと
- 関連コミット: 

### 0009

- 日時: 2026-03-15
- チェックポイント: Character Editor `character.md` panel 比率調整
- 実施内容: 比率指定をやめ、`character.md` タブも `Profile` と同じ content レイアウト定義に揃えた。あわせて、このデータがキャラクター定義の正本であり、プロンプト合成に使われる説明を UI に追加した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: `character.md` 側だけ特別な高さルールを持たせるより、`Profile` と同じ content モデルに揃える方が素直
- 関連コミット: 

### 0010

- 日時: 2026-03-15
- チェックポイント: Character Editor の小高さ崩れ修正
- 実施内容: `Profile` 側を card 内スクロールに変更し、`Theme` などの下部要素がカード外へはみ出さないようにした。あわせて、小さい高さでは preview avatar を 72px へ縮小し、説明文へ重ならないようにした。
- 検証: `npm run typecheck`, `npm run build`
- メモ: 今回の崩れは `Profile` 側だけスクロール責務が外側に残っていたことと、avatar 実寸が media query に追従していなかったことが原因
- 関連コミット: 

### 0011

- 日時: 2026-03-15
- チェックポイント: Character Editor `character.md` 説明カード化
- 実施内容: `character.md` タブの説明文ブロックに背景、枠線、余白を付けて、`Profile` と同じ文脈で読めるカード表示へ揃えた。
- 検証: `npm run typecheck`, `npm run build`
- メモ: タブ文言は `システムプロンプト` に寄せ、説明文と editor を同じカード内へまとめた
- 関連コミット: 

### 0012

- 日時: 2026-03-15
- チェックポイント: Character Editor scrollbar gutter 固定
- 実施内容: `Profile` 側の scroll container に `scrollbar-gutter: stable` を追加し、スクロールバーの表示有無で内部レイアウト幅が揺れないようにした。
- 検証: `npm run typecheck`, `npm run build`
- メモ: レイアウト差分の原因はコンテンツ量ではなく、スクロールバー出現時の横幅変化だった
- 関連コミット: 

### 0013

- 日時: 2026-03-15
- チェックポイント: Character Editor top preview 固定化
- 実施内容: 低い window 向け media query で avatar サイズと preview グリッドを変えていたルールを撤去し、top preview のレイアウトを常に固定にした。
- 検証: `npm run typecheck`, `npm run build`
- メモ: 高さ不足は content スクロールで吸収し、preview 自体の配置は動かさない方針に戻した
- 関連コミット: 

### 0014

- 日時: 2026-03-15
- チェックポイント: Character Editor base color を Home に揃える
- 実施内容: Character Editor page のベース変数を Home と同じ dark tone に寄せ、preview / input / theme card / footer / 補助ボタンの白基調を dark base へ置き換えた。
- 検証: `npm run typecheck`, `npm run build`
- メモ: この段階ではキャラカラーを全面に使わず、まず土台だけを Home と共通化している
- 関連コミット: `d8f40bf refactor(character-editor): align base palette with home`

### 0015

- 日時: 2026-03-15
- チェックポイント: Character Editor 前景色補正
- 実施内容: dark base で沈んでいたヘッダー名、preview 名、`Theme` の `Main / Sub`、`character.md` 見出しの前景色を補正した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: ベース配色変更で発生した可読性崩れだけを先に潰し、アクセント運用は次段に分離する
- 関連コミット: `d8f40bf refactor(character-editor): align base palette with home`

### 0016

- 日時: 2026-03-15
- チェックポイント: Character Editor accent color 初回適用
- 実施内容: `main` を active tab / focus / Save、`sub` を preview と各カードの補助ラインへ割り当てた。あわせて `Save` と `Delete` の文字色を調整し、footer action の可読性を上げた。
- 検証: `npm run typecheck`, `npm run build`
- メモ: `danger` はキャラカラーへ寄せず、引き続き破壊的操作の色を維持する
- 関連コミット: `be8052d fix(character-editor): apply theme accents`

### 0017

- 日時: 2026-03-15
- チェックポイント: Session base color を Home に揃える
- 実施内容: Session page のベース変数を Home と同じ dark tone に寄せ、header / message / composer / artifact など白基調の UI を dark base へ置き換えた。あわせて、タイトル、approval 選択中、artifact の file path、Audit Log のラベルと本文など、dark base で沈んでいた前景色を Session 専用の `ink / muted / session-main-contrast` へ振り直した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: キャラカラー由来の accent はまだ薄く残しているが、今回の主眼は Session 全体の土台色と可読性を揃えること
- 関連コミット: `959d284 fix(session-ui): reset session tones to neutral`

### 0018

- 日時: 2026-03-15
- チェックポイント: Session の character accent 撤去
- 実施内容: Session Window から character theme 由来の動的色反映を外し、固定 accent も使わない neutral 表現へ戻した。`buildSessionThemeStyle()` と root style 注入を削除し、bubble / action / file kind を無彩色の面と境界線だけで見せる形に整理した。
- 検証: `npm run typecheck`, `npm run build`
- メモ: character color は Home card と Character Editor のアクセントに限定し、Session は app 共通の dark base + neutral tone を維持する
- 関連コミット: `959d284 fix(session-ui): reset session tones to neutral`

## Open Items

- Character Editor の theme rule を Home と揃える
- Session の bubble / primary action の theme rule を Home と揃える
