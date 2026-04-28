# decisions

- 2026-04-28: まず synthetic V2 DB を生成して DB read path の計測を行い、その結果を見て Message / Audit UI virtualization の優先順位を決める。
- 2026-04-28: 既存 AppData はデフォルトでは触らず、明示した出力先または一時ディレクトリに benchmark DB を作る。
- 2026-04-29: DB read path は medium profile で数 ms 程度だったため、次の改善対象は Renderer 側の過剰描画とする。
- 2026-04-29: Message 一覧は scroll follow / unread / artifact 展開状態への影響が大きいため、先に Audit Log モーダルを windowing する。
- 2026-04-29: Audit Log は既存の Load More と detail lazy load を維持し、無限スクロール化は今回の対象にしない。
