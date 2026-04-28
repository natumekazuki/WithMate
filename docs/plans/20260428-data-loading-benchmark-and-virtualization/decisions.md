# decisions

- 2026-04-28: まず synthetic V2 DB を生成して DB read path の計測を行い、その結果を見て Message / Audit UI virtualization の優先順位を決める。
- 2026-04-28: 既存 AppData はデフォルトでは触らず、明示した出力先または一時ディレクトリに benchmark DB を作る。
