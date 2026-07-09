# Result

- status: done

## Summary

- `scripts/generate-app-icon.ts` を追加し、`build/icon.svg` `build/icon.png` `build/icon.ico` を deterministic に生成できるようにした
- `package.json` の packaging scripts と `electron-builder` icon 設定を更新し、`dist` 系コマンドで icon を自動再生成するようにした
- `docs/design/distribution-packaging.md` と `README.md` を current packaging 挙動へ同期した
- `npm run build` と `npm run dist:win` で Windows packaging まで確認した。macOS は設定のみで、実ビルド確認は macOS runner が必要

## Commits

- `d3f8e38` `feat(distribution): add app icon assets`
