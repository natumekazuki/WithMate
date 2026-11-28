import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";

// reserve は開始中の状態とコントローラーを登録するだけ。
// 検証に失敗した場合、呼び出し元はプロバイダーの準備を始める前に予約を解放する。
/** 排他区間で Turn を予約し、プロバイダーを読み取った後に現在性と利用可否を再確認して予約を返す。 */
export async function admitSessionTurn<T>(input: {
  runExclusive: RunProviderRuntimeOperationExclusive;
  assertCurrent: () => void;
  reserve: () => T | Promise<T>;
  readProvider: () => Promise<string>;
  assertProviderAvailable: (provider: string) => void;
}): Promise<T> {
  input.assertCurrent();
  const reservation = await input.runExclusive(() => {
    input.assertCurrent();
    return input.reserve();
  });
  // 削除と設定変更のガードはここから開始中の状態を検知できる。
  // 削除側が先に実行権を得た場合、その削除はこの読み取りの前に完了している。
  input.assertCurrent();
  const provider = await input.readProvider();
  await input.runExclusive(() => {
    input.assertCurrent();
    input.assertProviderAvailable(provider);
  });
  return reservation;
}
