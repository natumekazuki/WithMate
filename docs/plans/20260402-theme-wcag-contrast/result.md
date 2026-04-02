# result

## 状態

- 完了

## まとめ

- character theme の foreground selection を WCAG AA の contrast ratio ベースへ置き換えた
- `src/theme-utils.ts` を正本にし、Home card / Character Editor / Session / Diff の theme helper から輝度閾値判定を撤去した
- muted text も background 合成後の contrast を考慮して alpha を決めるようにした

## 検証

- `npm run build`
- `node --import tsx scripts/tests/theme-utils.test.ts`
