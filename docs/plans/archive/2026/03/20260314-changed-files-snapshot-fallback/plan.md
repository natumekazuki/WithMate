# Plan

- command_execution で発生したファイル変更を snapshot 差分から補完する
- add/edit/delete を before/after snapshot 比較で抽出する
- file_change イベントがある場合はその情報を優先しつつ、漏れを補完する
- design docs を同期し、typecheck/build を通す
