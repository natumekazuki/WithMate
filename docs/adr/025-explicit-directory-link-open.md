# ADR 025: 明示的なdirectory linkのOS open

- Status: Accepted
- Supersedes: [ADR 020](020-file-preview-window-navigation.md)の登録root外directory拒否のみ

## 背景

会話で案内された別Worktree等の既存directoryを開く操作が、Sessionのfile root外という理由で拒否される。OSのfile managerへ移動する操作と、アプリのdirectory列挙・Providerへのアクセス許可は別の権限である。[Issue #748](https://github.com/natumekazuki/WithMate/issues/748)の制限解除方針と実装判断の委譲に基づき、明示的なopenだけを許可する。

## 判断

- Session会話・Markdown file previewで利用者が有効化したdirectory linkは、登録root内外を問わずOSのfile managerで開く。追加の確認dialogは設けない。
- 所有するSession rendererまたは現在のresourceをbaseとして指定したPreview rendererだけが既存のlink IPCを使う。リンク解決後、OS open直前にも送信元Windowの同一性とSession所有／Preview baseを再確認する。
- Mainで既存pathをcanonical real pathへ解決する。symlink／junctionはその解決先を対象とし、directory専用のopen経路でkindとcanonical pathを再確認する。file、special object、消失、検査失敗、解決先変更を失敗とし、別対象へfallbackしない。
- canonical pathをURLとして再parse／decodeせず、行番号suffixも再解釈しない。OS APIへのpath引渡しはfilesystemと原子的ではないため、検証後の外部変更まで排除した保証にはしない。
- link表示・解決だけでOSを起動しない。directory列挙、埋込み画像の読込、Additional Directory、Provider指示・権限は拡張しない。汎用`openPath` IPCを変更しない。
- 成功時は既存の操作元errorを消し、OSが開くdirectoryを結果とする。失敗時は操作元の既存feedbackへ理由を返す。regular fileはroot内外とも既存のfile previewへ進む。

## 代案と影響

- Additional Directoryへの登録を要求する案は、OSで見るだけの要求にエージェント権限の追加を結び付けるため不採用。
- 汎用path openの制約を緩める案は、任意Renderer・fileのOS実行まで範囲を広げるため不採用。
- root外専用の確認dialogは、クリック以外の新しい権限を与えない操作へ反復確認を追加するため不採用。

永続化形式とProvider契約は変更しない。現行操作は[Message Rich Text](../design/message-rich-text.md#link-handling)、実機確認は[Manual Test Checklist](../manual-test-checklist.md)を参照する。

## macOSのfile manager表示

directoryの閲覧だけを許可する判断は、macOSのapp bundle／packageにも適用する。これらもfilesystem上はdirectoryであり、既定openへ渡すとアプリが起動し得るため、macOSではすべてのdirectory linkをFinderの選択表示にそろえる。

- Mainから`/usr/bin/open -R`をshellを介さず実行し、canonical pathを独立した引数として渡す。通常folderも親folder内で選択表示する。
- commandの終了を待って結果を返し、実行失敗・非zero終了を既存feedbackへ返す。成功結果はOSへの表示依頼の成功であり、Finder実描画の検証結果ではない。
- bundle拡張子の列挙による判定は行わず、command失敗時も既定app openへfallbackしない。Windows／Linuxのdirectory open、汎用`openPath`、Provider権限は変更しない。
- Electronの`showItemInFolder`は戻り値による失敗通知がないため、このdirectory linkの失敗feedbackには使用しない。
