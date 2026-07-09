# 20260325 character-session-copy

## Goal

- SessionWindow の固定文言を character ごとに差し替えられるようにする
- default copy は無味で汎用的にし、character 設定がある時だけ体験差を出す

## Scope

- `CharacterProfile` / character storage に session copy 設定を追加する
- Character Editor から session copy を編集できるようにする
- SessionWindow の主要固定文言を character copy 経由で描画する
- 未設定時の bland default copy を整える

## Out Of Scope

- provider prompt や memory への反映
- Home / Character Stream 側の copy 差し替え
- main process dialog や OS dialog の copy 差し替え

## Initial Slice

1. pending indicator copy
2. retry banner title copy
3. `Latest Command` empty / waiting copy
4. `Changed Files` empty copy
5. `Context` empty copy

## Steps

1. session copy slot と default copy を設計する
2. character storage / app state / editor に session copy を追加する
3. SessionWindow の固定文言を session copy lookup に置き換える
4. docs と manual test を同期する
