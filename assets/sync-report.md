# Docs Sync Report

- date: 2026-05-03
- target: WithMate 4.0.0 SingleMate Design Gate
- status: repo-sync-required

## 判定

`repo-sync-required`

完全 SingleMate 化は、プロダクト責務、保存構造、prompt / provider 境界、Memory / Growth の責務を横断して変更するため、repo の canonical design docs へ同期する必要がある。

## 更新した文書

- `docs/plans/20260503-single-mate-4-roadmap/plan.md`
- `docs/design/product-direction.md`
- `docs/design/single-mate-architecture.md`
- `docs/design/mate-storage-schema.md`
- `docs/design/mate-growth-engine.md`
- `docs/design/mate-memory-summary.md`
- `docs/design/provider-instruction-sync.md`
- `docs/design/prompt-composition.md`
- `docs/design/memory-architecture.md`
- `docs/design/database-schema.md`
- `docs/design/documentation-map.md`
- `docs/design/character-storage.md`
- `docs/design/character-management-ui.md`

## 更新理由

- `product-direction.md` は WithMate の上位方針であり、4.0.0 の SingleMate 決定を反映する必要がある
- `single-mate-architecture.md` は Mate Profile、Growth、UI、storage boundary の新しい正本として追加した
- `mate-storage-schema.md` は `withmate-v4.db`、Mate singleton、Growth ledger、provider instruction target の schema 正本として追加した
- `mate-growth-engine.md` は Growth Candidate を app 内で完結させる service boundary、policy gate、忘却 / 訂正 / provider projection 境界を固定するため追加した
- `mate-memory-summary.md` は ChatGPT Pro などで Memory / Growth 設計を追加検討するための単一 Markdown summary として追加した
- `provider-instruction-sync.md` は Mate Profile から provider native instruction file へ同期する新しい主経路を定義するため追加した
- `prompt-composition.md` は Mate 定義全文の毎 turn prompt 合成をやめる方針と衝突しないように更新した
- `memory-architecture.md` は旧 Memory runtime ではなく Growth として再設計する方針を反映した
- `database-schema.md` は current 3.x storage と 4.0.0 future Mate Profile storage の境界を明記した
- `character-storage.md` と `character-management-ui.md` は 3.x supporting / legacy detail として扱う注記を追加した
- 後方互換を切り捨て、Mate Profile storage / API を完全に単一化する判断を plan / design に反映した
- Mate Profile metadata は SQLite に保存し、`profile.json` を作らない判断を反映した
- Mate 未作成時は Mate 作成と Settings 以外の全機能を block する判断を反映した
- 初回 Mate 作成は `name` だけで完了でき、詳細 persona を持たない最小状態から始める判断を反映した
- 初回作成時は必要な Mate Profile Markdown files をすべて作成するが、中身は空でよい判断を反映した
- Mate avatar / icon は任意であり、未設定時は Mate name と theme color の placeholder を正式な表示として扱う判断を反映した
- `avatar.png` はユーザーが画像を指定した場合だけ作成し、provider instruction projection には avatar / image 情報を含めない判断を反映した
- provider instruction sync の設定 UI は既存 Settings に追加し、既存 provider / skill root 設定と同じ流儀に寄せる判断を反映した
- Memory / Growth は project 単位保存ではなく、Memory ID に紐づく tag relation で `tag_type` / `tag_value` を無制限に付与して扱う判断を反映した
- Profile Item tag は source Memory tags から継承または render 時に派生させ、project digest は project tag 付き item から作る projection とする判断を反映した
- Git 管理下 workspace は Git 情報から project tag を作り、Git 非管理 workspace には project tag を付与しない判断を反映した
- Growth Review UI は日常的な承認 queue ではなく、検索、最近覚えたこと、忘却、無効化に絞った最小管理面とする判断を反映した
- provider instruction sync の MVP 範囲を current supported provider に限定する判断を反映した
- Growth Candidate を 4.0.0 から実装し、毎回のユーザー承認ではなく自律反映 + 後から修正 / 忘却する方針を反映した
- Memory Candidate 生成は通常 turn response に含めず、app internal background execution として行う判断を反映した
- Memory Candidate 生成は同一 provider thread に hidden turn を積まず、familiar-ai の post-response pipeline を参考に別 background session / utility call として実行する判断を反映した
- Memory Candidate 生成は `{ memories: MemoryCandidate[] }` の配列 wrapper を返す判断を反映した
- Memory Candidate に `retention = auto | force | ignore` を持たせ、`force` は保存 threshold 通過扱いだが policy gate を迂回しない判断を反映した
- Memory Candidate 生成は軽量 model / reasoning effort / timeout を設定で制御し、turn ごとの background 実行を既定候補にする判断を反映した
- Memory Candidate LLM response は UI に表示せず、Zod などの schema validation と policy gate を通ったものだけ DB に保存する判断を反映した
- MCP を 4.0.0 MVP の必須要件にせず、Mate Growth Engine を app internal service として設計する判断を反映した
- Growth の保存可否と provider instruction projection 可否を分け、`projection_allowed = false` を provider instruction file に出さない判断を反映した
- Growth forget / redaction が profile、revision、evidence、project digest、provider projection へ伝播する必要を反映した
- `core.md` への自律 Growth 反映を 4.0.0 MVP では行わない判断を反映した
- 前回 consolidation 以降に一定件数以上の pending Memory が増えた時を主 trigger にする判断を反映した
- 反復、重要度、最近性、時間経過による弱化、矛盾訂正を human-like memory mechanics として反映した
- SQL Memory retrieval MCP は profile 更新主体ではなく read-only retrieval interface として将来追加する判断を反映した
- Growth Event から Markdown へ直接書かず、Profile Operation / Profile Item / Markdown Render を挟む判断を反映した
- Profile Update Skill は Markdown 全文ではなく structured operation を返す判断を反映した
- Growth evidence に source role / source kind / trust level を持たせ、assistant / tool / file 由来を user preference として auto apply しない判断を反映した
- PostPolicyGate と projection linter 相当の apply 直前検査を設計へ反映した
- 忘却 redaction の負荷を下げるため、4.0.0 MVP では `changes.patch` を保存しない判断を反映した
- Profile Item schema/API の最終案として、category、claim value normalization、revision links、source links、HMAC tombstone を反映した
- Growth apply transaction の検討事項として、DB active revision 正本、idempotency key、provider sync read snapshot、forget redaction completion を反映した
- forget 後は provider instruction target を `redaction_required` にでき、redaction 完了まで session 起動を制御する判断を反映した
- Growth background execution の provider structured output / Zod validation 差分と、Codex / Copilot 共通 token usage 正規化方針を反映した

## 未同期の可能性が残る領域

- `README.md`
- `docs/design/desktop-ui.md`
- `docs/design/window-architecture.md`
- `docs/design/session-launch-ui.md`
- `docs/design/settings-ui.md`
- `docs/design/provider-adapter.md`

これらは実装 Phase 1-4 の着手時に、UI / provider / Settings の実装変更と同じ task で更新する。
