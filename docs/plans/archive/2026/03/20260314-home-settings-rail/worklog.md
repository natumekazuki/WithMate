# Worklog

## Timeline

### 0001

- 日時: 2026-03-14
- チェックポイント: Home の `Settings` を重ね置きから rail 配置へ切り替える
- 実施内容: `HomeApp.tsx` を右カラム `home-side-column` 構成へ変更し、`styles.css` で `home-floating-actions` を削除、`home-settings-rail` を追加した。design docs も更新した
- 検証: `npm run typecheck`, `npm run build`
- メモ: モバイル幅では `Settings` ボタン自体は既存の幅ルールに従って縦方向へ自然に伸びる
- 関連コミット: 

## Open Items

- なし
