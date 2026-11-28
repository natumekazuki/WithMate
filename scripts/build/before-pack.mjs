import { tsImport } from "tsx/esm/api";

/** electron-builderのパッケージ化直前に、対象環境向けのネイティブ依存を準備する。 */
export default async function beforePack(context) {
  const { prepareNativePackaging } = await tsImport(
    "./prepare-native-dependencies.ts",
    import.meta.url,
  );
  await prepareNativePackaging(context);
}
