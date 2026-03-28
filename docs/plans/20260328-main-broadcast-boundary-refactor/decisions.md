# Decisions

- 次の hotspot は `broadcastSessions / broadcastCharacters / broadcastModelCatalog / broadcastAppSettings / broadcastOpenSessionWindowIds` の境界整理とする
- `SessionObservabilityService` に入れた event broadcast と重複しないよう、window 向け broadcast は別 service または helper module にまとめる
- 今回の slice は送信経路の整理に留め、payload shape は維持する
