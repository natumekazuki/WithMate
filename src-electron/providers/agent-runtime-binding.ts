import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RuntimeOwnerSelector } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import { getProviderAgentRuntimeBindingCapability } from "./provider-agent-runtime-binding.js";
import type { AgentRuntimeSourceRef } from "../../src-shared/agent-runtime/agent-runtime-source.js";

/** バインディングごとに許可するランタイム操作を識別する文字列。 */
export type AgentRuntimeOperation = string;

/** バインディングの発行時点で取得し、継続利用できるかの照合に使う権限情報。 */
export type AgentRuntimeAuthoritySnapshot = Readonly<Record<string, unknown>>;

/** プロバイダーへの実行権限を管理する記録。生の参照値ではなくハッシュと、有効な実行世代・操作範囲を保持する。 */
export type AgentRuntimeBindingRecord = {
  bindingId: string;
  bindingReferenceHash: string;
  actorSessionId: string;
  actorSource?: AgentRuntimeSourceRef;
  providerId: string;
  executionGeneration: string;
  authoritySnapshot: AgentRuntimeAuthoritySnapshot;
  operationGrants: readonly AgentRuntimeOperation[];
  createdAt: string;
  expiresAt: string | null;
};

/** 現在の実行に紐づく参照と接続情報をプロバイダーへ渡す形式。対応しないプロバイダーでは有効な参照を持たない。 */
export type ProviderAgentRuntimeBindingProjection = {
  bindingId: string;
  bindingReference: string;
  providerId: string;
  executionGeneration: string;
  transport: "env" | "unsupported";
  expiresAt: string | null;
  turnCapability?: string;
  runtimeOwner?: RuntimeOwnerSelector;
  managedMcp?: {
    glossaryUrl: string;
    sessionUrl?: string;
    token: string;
  };
};

/** 認証後に利用するバインディングの情報。生の参照値にはアクセスせず、照合に使ったハッシュを保持する。 */
export type ResolvedAgentRuntimeBinding = Omit<
  AgentRuntimeBindingRecord,
  "bindingReferenceHash"
> & {
  bindingIdHash: string;
};

/** 認証・認可の結果。参照の欠落、無効な参照、許可のない操作は別のエラーコードで返す。 */
export type AgentRuntimeBindingResolveResult =
  | { ok: true; binding: ResolvedAgentRuntimeBinding }
  | {
      ok: false;
      code:
        | "SESSION_BINDING_REQUIRED"
        | "SESSION_BINDING_INVALID"
        | "SESSION_BINDING_FORBIDDEN";
    };

/** 発行対象の実行主体・プロバイダー、および根拠となる権限情報、操作権限、有効期限。 */
export type IssueAgentRuntimeBindingInput = {
  actorSessionId: string;
  actorSource?: AgentRuntimeSourceRef;
  providerId: string;
  authoritySnapshot?: AgentRuntimeAuthoritySnapshot;
  operationGrants: readonly AgentRuntimeOperation[];
  now?: Date;
  expiresAt?: string | null;
};

/** 同じ実行主体・プロバイダーに対する有効な世代の切り替え。削除時の新しい世代は null。 */
export type AgentRuntimeBindingChange = {
  actorSessionId: string;
  providerId: string;
  previousExecutionGeneration: string | null;
  executionGeneration: string | null;
};

/** 有効なバインディングの内部状態。発行参照、権限の照合値、送出済み処理とも共有する失効状態を持つ。 */
type ActiveBinding = {
  record: AgentRuntimeBindingRecord;
  reference: string;
  authorityFingerprint: string;
  revocationState: SharedArrayBuffer;
};

/** 発行参照を、参照値そのものをキーに保持せず照合できる形式へ変換する。 */
function hashBindingReference(reference: string): string {
  return createHash("sha256").update(reference, "utf8").digest("base64url");
}

/** 実行主体とプロバイダーを別の要素として、唯一の実行枠を識別する内部キーを作る。 */
function bindingKey(actorSessionId: string, providerId: string): string {
  return `session\0${actorSessionId}\0${providerId}`;
}

/** 期限が設定されている場合に限り、その時刻に到達していれば失効と判定する。 */
function isExpired(record: AgentRuntimeBindingRecord, now: Date): boolean {
  return Boolean(
    record.expiresAt && Date.parse(record.expiresAt) <= now.getTime(),
  );
}

/** 有効期限を ISO 日時に揃える。未指定は期限なし、不正な値は例外で区別する。 */
function normalizeExpiresAt(
  expiresAt: string | null | undefined,
): string | null {
  if (expiresAt === null || expiresAt === undefined) {
    return null;
  }
  const normalizedInput = expiresAt.trim();
  const timestamp = Date.parse(normalizedInput);
  if (!normalizedInput || !Number.isFinite(timestamp)) {
    throw new Error(
      "Agent runtime binding expiresAt must be a valid date-time.",
    );
  }
  return new Date(timestamp).toISOString();
}

/** 並べ替え済みの操作権限を位置ごとに照合する。 */
function sameGrants(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((grant, index) => grant === right[index])
  );
}

/** 権限情報のオブジェクトだけをキー順に揃え、配列の順序を変えずに入れ子も処理する。 */
function stableAuthorityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableAuthorityValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableAuthorityValue(item)]),
    );
  }
  return value;
}

/** オブジェクトのプロパティ順に依存せず、権限情報を再利用判定で比較できる値を作る。 */
function authorityFingerprint(snapshot: AgentRuntimeAuthoritySnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(stableAuthorityValue(snapshot)), "utf8")
    .digest("base64url");
}

/** 実行主体・プロバイダーごとに一つの有効なバインディングを管理し、参照の認証と失効を扱う。 */
export class AgentRuntimeBindingRegistry {
  private readonly bindingsByKey = new Map<string, ActiveBinding>();
  private readonly keysByReferenceHash = new Map<string, string>();
  private readonly changeListeners = new Set<
    (change: AgentRuntimeBindingChange) => void
  >();

  /** 世代変更を受け取る処理を登録し、その登録を解除する関数を返す。 */
  subscribeChanges(
    listener: (change: AgentRuntimeBindingChange) => void,
  ): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** 権限・期限・実行主体が変わっていない有効なバインディングは再利用し、変更があれば古い参照を失効させる。 */
  issueOrReuse(
    input: IssueAgentRuntimeBindingInput,
  ): ProviderAgentRuntimeBindingProjection {
    const actorSessionId = input.actorSessionId.trim();
    const providerId = input.providerId.trim();
    if (!actorSessionId || !providerId) {
      throw new Error(
        "Agent runtime binding requires actor Session and provider IDs.",
      );
    }

    const expiresAt = normalizeExpiresAt(input.expiresAt);

    const transport =
      getProviderAgentRuntimeBindingCapability(providerId).transport;
    if (transport === "unsupported") {
      this.revokeProviderExecution(actorSessionId, providerId);
      return {
        bindingId: randomUUID(),
        bindingReference: "",
        providerId,
        executionGeneration: randomUUID(),
        transport: "unsupported",
        expiresAt,
      };
    }

    const key = bindingKey(actorSessionId, providerId);
    const now = input.now ?? new Date();
    const operationGrants = [...new Set(input.operationGrants)].sort();
    const authoritySnapshot = structuredClone(input.authoritySnapshot ?? {});
    const actorSource = input.actorSource
      ? structuredClone(input.actorSource)
      : undefined;
    if (actorSource && actorSource.sessionId !== actorSessionId)
      throw new Error("Binding source must identify its real actor Session.");
    const nextAuthorityFingerprint = authorityFingerprint({
      ...authoritySnapshot,
      actorSource: actorSource ?? null,
    });
    const existing = this.bindingsByKey.get(key);
    if (
      existing &&
      !isExpired(existing.record, now) &&
      sameGrants(existing.record.operationGrants, operationGrants) &&
      existing.authorityFingerprint === nextAuthorityFingerprint &&
      existing.record.expiresAt === expiresAt
    ) {
      return this.project(existing, transport);
    }
    const bindingReference = randomBytes(32).toString("base64url");
    const record: AgentRuntimeBindingRecord = {
      bindingId: randomUUID(),
      bindingReferenceHash: hashBindingReference(bindingReference),
      actorSessionId,
      ...(actorSource ? { actorSource } : {}),
      providerId,
      executionGeneration: randomUUID(),
      authoritySnapshot,
      operationGrants,
      createdAt: now.toISOString(),
      expiresAt,
    };
    const active = {
      record,
      reference: bindingReference,
      authorityFingerprint: nextAuthorityFingerprint,
      revocationState: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    };
    if (existing) {
      this.removeActiveBinding(key, existing);
    }
    this.bindingsByKey.set(key, active);
    this.keysByReferenceHash.set(record.bindingReferenceHash, key);
    this.emitChange({
      actorSessionId,
      providerId,
      previousExecutionGeneration: existing?.record.executionGeneration ?? null,
      executionGeneration: record.executionGeneration,
    });
    return this.project(active, transport);
  }

  /** 参照を認証したうえで、指定された操作が発行時の許可範囲にあることを確認する。 */
  resolve(
    bindingReference: string | null | undefined,
    operation: AgentRuntimeOperation,
    now = new Date(),
  ): AgentRuntimeBindingResolveResult {
    const result = this.resolveIdentity(bindingReference, now);
    if (!result.ok) return result;
    return result.binding.operationGrants.includes(operation)
      ? result
      : { ok: false, code: "SESSION_BINDING_FORBIDDEN" };
  }

  /** 参照のハッシュから実行枠を認証し、期限切れは失効させる。操作ごとの許可判定はここでは行わない。 */
  resolveIdentity(
    bindingReference: string | null | undefined,
    now = new Date(),
  ): AgentRuntimeBindingResolveResult {
    const reference = bindingReference?.trim();
    if (!reference) {
      return { ok: false, code: "SESSION_BINDING_REQUIRED" };
    }
    const referenceHash = hashBindingReference(reference);
    const key = this.keysByReferenceHash.get(referenceHash);
    const active = key ? this.bindingsByKey.get(key) : undefined;
    if (
      !key ||
      !active ||
      active.record.bindingReferenceHash !== referenceHash
    ) {
      return { ok: false, code: "SESSION_BINDING_INVALID" };
    }
    if (isExpired(active.record, now)) {
      this.revokeActiveBinding(key, active);
      return { ok: false, code: "SESSION_BINDING_INVALID" };
    }
    return {
      ok: true,
      binding: {
        bindingId: active.record.bindingId,
        bindingIdHash: active.record.bindingReferenceHash,
        actorSessionId: active.record.actorSessionId,
        ...(active.record.actorSource
          ? { actorSource: structuredClone(active.record.actorSource) }
          : {}),
        providerId: active.record.providerId,
        executionGeneration: active.record.executionGeneration,
        authoritySnapshot: structuredClone(active.record.authoritySnapshot),
        operationGrants: [...active.record.operationGrants],
        createdAt: active.record.createdAt,
        expiresAt: active.record.expiresAt,
      },
    };
  }

  /** 指定の実行主体とプロバイダーの組に対応するバインディングだけを取り消す。 */
  revokeProviderExecution(actorSessionId: string, providerId: string): void {
    const key = bindingKey(actorSessionId.trim(), providerId.trim());
    const active = this.bindingsByKey.get(key);
    if (active) {
      this.revokeActiveBinding(key, active);
    }
  }

  /** 指定 Session 自身と、そこを所属先とする Auxiliary のバインディングを失効させる。 */
  revokeSession(actorSessionId: string): void {
    for (const [key, active] of [...this.bindingsByKey.entries()]) {
      if (
        active.record.actorSessionId === actorSessionId ||
        (active.record.actorSource?.kind === "auxiliary" &&
          active.record.actorSource.parent.sessionId === actorSessionId)
      ) {
        this.revokeActiveBinding(key, active);
      }
    }
  }

  /** 指定のバインディング ID が有効なら、その一件だけを失効させる。 */
  revokeBinding(bindingId: string): void {
    for (const [key, active] of this.bindingsByKey) {
      if (active.record.bindingId === bindingId) {
        this.revokeActiveBinding(key, active);
        return;
      }
    }
  }

  /** 現在登録されているすべてのバインディングを失効させる。 */
  revokeAll(): void {
    for (const [key, active] of [...this.bindingsByKey.entries()]) {
      this.revokeActiveBinding(key, active);
    }
  }

  /** 期限切れの登録を失効させてから、残っている有効な件数を返す。 */
  getActiveBindingCount(now = new Date()): number {
    for (const [key, active] of [...this.bindingsByKey.entries()]) {
      if (isExpired(active.record, now)) {
        this.revokeActiveBinding(key, active);
      }
    }
    return this.bindingsByKey.size;
  }

  /** 指定された実行枠の現行世代を返す。未登録または期限切れの登録に有効な世代は返さない。 */
  getExecutionGeneration(
    actorSessionId: string,
    providerId: string,
    now = new Date(),
  ): string | null {
    const key = bindingKey(actorSessionId.trim(), providerId.trim());
    const active = this.bindingsByKey.get(key);
    if (!active) {
      return null;
    }
    if (isExpired(active.record, now)) {
      this.revokeActiveBinding(key, active);
      return null;
    }
    return active.record.executionGeneration;
  }

  /** 認証済みの特定のバインディングに対応する共有の失効状態を取得する。 */
  getBindingRevocationState(
    binding: ResolvedAgentRuntimeBinding,
  ): SharedArrayBuffer | null {
    const active = this.bindingsByKey.get(
      bindingKey(binding.actorSessionId, binding.providerId),
    );
    return active?.record.executionGeneration === binding.executionGeneration
      ? active.revocationState
      : null;
  }

  /** 環境変数経由でプロバイダーへ渡すための識別・参照・期限情報を組み立てる。 */
  private project(
    active: ActiveBinding,
    transport: "env",
  ): ProviderAgentRuntimeBindingProjection {
    return {
      bindingId: active.record.bindingId,
      bindingReference: active.reference,
      providerId: active.record.providerId,
      executionGeneration: active.record.executionGeneration,
      transport,
      expiresAt: active.record.expiresAt,
    };
  }

  /** 登録を無効化してから、該当実行の世代がなくなったことを監視側へ伝える。 */
  private revokeActiveBinding(key: string, active: ActiveBinding): void {
    this.removeActiveBinding(key, active);
    this.emitChange({
      actorSessionId: active.record.actorSessionId,
      providerId: active.record.providerId,
      previousExecutionGeneration: active.record.executionGeneration,
      executionGeneration: null,
    });
  }

  /** 共有の失効フラグを立て、実行枠と参照の照合用索引の両方から取り除く。 */
  private removeActiveBinding(key: string, active: ActiveBinding): void {
    // 起点の Turn が続いていても、送出済みの処理はバインディングの失効を検知できなければならない。
    Atomics.store(new Int32Array(active.revocationState), 0, 1);
    this.bindingsByKey.delete(key);
    this.keysByReferenceHash.delete(active.record.bindingReferenceHash);
  }

  /** 監視側に世代変更のコピーを渡す。監視側の例外で別の監視や実際の変更を止めない。 */
  private emitChange(change: AgentRuntimeBindingChange): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener({ ...change });
      } catch {
        // 表示反映のリスナーが失敗しても、バインディングの状態遷移は失敗させない。
      }
    }
  }
}
