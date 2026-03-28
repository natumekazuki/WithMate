# Decisions

- first slice は `session 起動 / 再開 / turn 実行 / in-flight 管理` を対象にする
- service 化しても provider adapter と storage の public interface は極力維持する
- Memory / Character reflection の trigger 呼び出しは一旦既存のまま残し、session runtime から呼ぶ形に留める
