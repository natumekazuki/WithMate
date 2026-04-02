# Decisions

## D-001: まず completed audit log 更新の欠落原因を特定する

- 日付: 2026-04-02
- 理由: UI 表示欠落ではなく storage / update 経路の問題かもしれないため、先に真因を絞る

## D-002: 修正は storage ではなく renderer の再読込条件で行う

- 日付: 2026-04-02
- 理由: storage と memory orchestration は completed 時に `assistant_text` / `raw_items_json` を保存しており、`Audit Log` modal が background activity の終了を拾わず stale cache を表示していたため
