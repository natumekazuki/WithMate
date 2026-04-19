# Plan: Memory Management Query Optimization

- **Tier**: session plan
- **作成日**: 2026-04-19
- **ディレクトリ**: `docs/plans/archive/2026/04/20260419-memory-management-query-optimization/`

---

## 問題要約

`src/memory-management-view.ts` では search / domain / category / sort の条件変更のたびに
snapshot 全体に対して filter + sort + group 再構成を毎回実行している。
`src/HomeApp.tsx` の delete ハンドラーは delete 後に毎回 `getMemoryManagementSnapshot()` を
full refetch しており、件数増加につれて UI 応答が悪化する構造になっている。

本タスクは「renderer 側の query/filter/sort の再計算コスト削減」と
「delete 後の full refetch 回避」を第一段として実施する。
明示的な Reload は従来通り full snapshot 再取得のままとする。

---

## 実装スコープ

### IN スコープ

| 項目 | 内容 |
|------|------|
| 検索キー正規化 | `memory.content` / `memory.domain` などを小文字化・trim した正規化済みキーを snapshot 取得時に一度だけ生成し、filter ループで毎回 toLowerCase() する処理を削除する |
| domain 別 selector / 事前 sort 済み index | snapshot 取得直後に domain → entry のマップと sort 済み配列を作り、filter 条件が変わったときだけ更新する |
| delete 後の local mutation | delete 成功後に `getMemoryManagementSnapshot()` を再取得する代わりに、ローカルの snapshot state から該当 entry を取り除いて state を直接更新する |
| filter/sort の依存比較 | 前回と同じ条件で再描画が走った場合は再計算をスキップできる仕組みを入れる（useMemo / 条件早期リターン 等） |

### OUT スコープ

| 項目 | 除外理由 |
|------|----------|
| list virtualization | 件数が顕著に多い段階で効果を測定してから別 task で対応する |
| main プロセス側の IPC 契約変更 | renderer 内最適化に限定する。IPC 変更が必要な場合は別 plan へ切り出す |
| `Memory retrieval indexing` (main side) | roadmap 上の別 task (`opt/memory-retrieval-indexing`) に委譲 |
| docs/design / .ai_context 更新 | 公開仕様・永続化契約を変更しないため不要 |

---

## 対象ファイル

- `src/memory-management-view.ts` — filter / sort / group ロジックの最適化主対象
- `src/HomeApp.tsx` — delete ハンドラーの local mutation 対応

---

## 作業分解

### Checkpoint 1: `src/memory-management-view.ts` の filter/sort 最適化

1. snapshot 取得時に正規化済み検索キーを付与する処理を追加
2. domain 別エントリーマップ / 事前 sort 済み配列を snapshot 変化時のみ生成するよう変更
3. filter/sort 条件が前回と同一ならば再計算をスキップするガード条件を追加
4. 既存の filter/sort ループ内から毎回 toLowerCase() / trim() する処理を除去

### Checkpoint 2: `src/HomeApp.tsx` の delete 後 local mutation 対応

1. delete 成功コールバック内で `getMemoryManagementSnapshot()` を再取得している箇所を特定
2. 削除された entry ID をキーにローカル snapshot state から該当行を取り除く処理に差し替え
3. 明示的な Reload ボタンによる full refetch は変更しない

### Checkpoint 3: 動作確認

1. search / domain / category / sort フィルタが従来と同じ結果を返すことを手動確認
2. delete 後に対象エントリーが一覧から消えること（full refetch なし）を手動確認
3. Reload ボタンで最新 snapshot が再取得されることを手動確認
4. `npm run build` が通ることを確認

---

## 完了条件

- [x] filter/sort ロジックが snapshot 変化時または条件変化時にのみ再計算される
- [x] delete 後は full refetch を行わずにローカル state の mutation だけで一覧が更新される
- [x] 明示的な Reload は従来通り full snapshot 再取得で動作する
- [x] `npm test` 関連テスト 380 件全通過
- [x] 手動確認項目がすべてパスする（typecheck にて対象ファイルのエラーなしを確認）

---

## テスト/確認方針

- 自動テストがない場合はビルド成功 + 手動確認で代替する
- 確認項目は「Checkpoint 3」に列挙した 4 点とする
- 既存の自動テストがある場合は `npm test`（または相当コマンド）を実行してリグレッションがないことを確認する

---

## docs 更新要否判断

| 対象 | 要否 | 理由 |
|------|------|------|
| `docs/design/` | 不要 | renderer 内の計算最適化のみで設計仕様の変更なし |
| `.ai_context/` | 不要 | 公開仕様・IPC 契約・永続化契約に変更なし |
| `README.md` | 不要 | ユーザー向け機能・操作に変更なし |
| `docs/optimization-roadmap.md` | 不要（任意） | roadmap は実施状況管理ではなく判断材料として維持するため |

---

## 質問

質問なし。
