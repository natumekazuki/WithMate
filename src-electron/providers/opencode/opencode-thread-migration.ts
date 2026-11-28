import path from "node:path";
import {
  isSessionNotFoundError,
  type OpenCodeClient,
  type SessionInfo,
} from "@opencode/client";
import type { RunSessionTurnInput } from "../provider-runtime.js";

/** 履歴を読み書きできる WithMate の所有者。移行では未指定の所有者を扱わない。 */
type RuntimeOwner = NonNullable<RunSessionTurnInput["runtimeOwner"]>;

/** ネイティブ側の所有者メタデータを、スキーマ・種別・ID・世代すべてで照合する。 */
export function sameOpenCodeOwner(
  actual: unknown,
  expected: RuntimeOwner,
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const owner = actual as Record<string, unknown>;
  return (
    owner.schema === 1 &&
    owner.kind === expected.kind &&
    owner.id === expected.id &&
    owner.incarnationId === expected.incarnationId
  );
}

/** 指定 ID と親・作業場所・所有者のいずれかが異なるスレッドを、移行対象として扱わない。 */
function assertIdentity(
  info: SessionInfo,
  id: string,
  parentID: string | undefined,
  workspacePath: string,
  owner: RuntimeOwner,
): void {
  if (
    info.id !== id ||
    info.parentID !== parentID ||
    path.resolve(info.location.directory) !== path.resolve(workspacePath) ||
    !sameOpenCodeOwner(info.metadata?.withmateOwner, owner)
  ) {
    throw new Error(
      "OpenCode migration thread owner, parent or workspace does not match this Session",
    );
  }
}

/** 呼び出し元は、確定済みの履歴を転送する前にルートの受信箱を確認する。 */
export async function migrateOpenCodeThread(input: {
  source: OpenCodeClient;
  target: OpenCodeClient;
  rootID: string;
  workspacePath: string;
  runtimeOwner: RuntimeOwner;
  signal?: AbortSignal;
}): Promise<SessionInfo> {
  const { source, target, rootID, workspacePath, runtimeOwner, signal } = input;
  const options = { signal };
  /** 家系を列挙する途中やインポートの境界で、中断済みならそれ以上の処理を止める。 */
  const checkCanceled = () => signal?.throwIfAborted();
  checkCanceled();
  const root = await source.session.get({ sessionID: rootID }, options);
  assertIdentity(root, rootID, undefined, workspacePath, runtimeOwner);
  const family = [root];
  const ids = new Set([rootID]);
  for (let index = 0; index < family.length; index++) {
    const parent = family[index]!;
    checkCanceled();
    if (
      index > 0 &&
      (await source.session.inbox.list({ sessionID: parent.id }, options))
        .length
    ) {
      throw new Error("OpenCode migration requires an empty source inbox");
    }
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      checkCanceled();
      // archived を省略すると、アーカイブ済みとアクティブの両方の子 Session が含まれる。
      const page = await source.session.list(
        { parentID: parent.id, limit: 100, cursor },
        options,
      );
      for (const child of page.data) {
        assertIdentity(child, child.id, parent.id, workspacePath, runtimeOwner);
        if (ids.has(child.id))
          throw new Error("OpenCode migration child identity is repeated");
        ids.add(child.id);
        family.push(child);
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("OpenCode migration child cursor did not advance");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  const active = await source.session.active(options);
  if (family.some((info) => Object.hasOwn(active, info.id))) {
    throw new Error("OpenCode migration source thread is still active");
  }

  let targetRoot: SessionInfo | undefined;
  for (const info of family) {
    checkCanceled();
    let existing: SessionInfo | undefined;
    try {
      existing = await target.session.get({ sessionID: info.id }, options);
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
    }
    if (!existing) {
      const data = await source.session.export({ sessionID: info.id }, options);
      assertIdentity(
        data.info,
        info.id,
        info.parentID,
        workspacePath,
        runtimeOwner,
      );
      checkCanceled();
      existing = await target.session.import(
        { ...data, location: { directory: workspacePath } },
        options,
      );
    }
    checkCanceled();
    assertIdentity(
      existing,
      info.id,
      info.parentID,
      workspacePath,
      runtimeOwner,
    );
    if (info.id === rootID) targetRoot = existing;
  }
  return targetRoot!;
}
