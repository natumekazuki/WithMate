import { tsImport } from "tsx/esm/api";

export default async function beforePack(context) {
  const { prepareNativePackaging } = await tsImport("./prepare-native-dependencies.ts", import.meta.url);
  await prepareNativePackaging(context);
}
