import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";

// reserve only registers starting/controller state. The caller must release that
// reservation if validation fails, before beginning any provider preparation.
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
  // Deletion and settings guards now observe starting state. A deletion that
  // acquired ownership first has already completed before this read is issued.
  input.assertCurrent();
  const provider = await input.readProvider();
  await input.runExclusive(() => {
    input.assertCurrent();
    input.assertProviderAvailable(provider);
  });
  return reservation;
}
