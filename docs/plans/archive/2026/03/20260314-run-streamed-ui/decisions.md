# Decisions

- 永続 session state と、実行中だけ存在する transient stream state を分離する
- Renderer は stream イベントで逐次表示し、completed 時点で保存済み session に収束させる
- audit log は最終確定値を従来通り保存し、stream の途中経過は session payload に永続化しない
