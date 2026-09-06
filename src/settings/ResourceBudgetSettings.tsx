import { useEffect, useMemo, useRef, useState } from "react";

import {
  RESOURCE_BUDGET_DIMENSIONS,
  type ResourceBudget,
  type ResourceBudgetDimension,
  type ResourceBudgetPartialAmounts,
} from "../resource-budget.js";
import type { HomeSessionSummary } from "../session-state.js";
import { getWithMateApi } from "../renderer-withmate-api.js";

const SESSION_PAGE_LIMIT = 50;

const DIMENSION_LABELS: Readonly<Record<ResourceBudgetDimension, string>> = {
  concurrentTurns: "同時実行 Turn",
  queuedTurns: "queued Turn",
  totalTurns: "累積 Turn",
  retries: "自動 retry（Root 累計）",
  sessions: "Session 作成数",
  workItems: "WorkItem 作成数",
  delegations: "delegation 作成数",
  storageBytes: "保存容量（bytes）",
};

type HardLimitDraft = Record<ResourceBudgetDimension, string>;
type ResourceBudgetSaveIdentity = Readonly<{ fingerprint: string; idempotencyKey: string }>;

function toHardLimitDraft(budget: ResourceBudget): HardLimitDraft {
  return Object.fromEntries(
    RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, String(budget.dimensions[dimension].hardLimit)]),
  ) as HardLimitDraft;
}

function toLocalDateTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function createIdempotencyKey(): string {
  return `settings-resource-budget-${globalThis.crypto.randomUUID()}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Resource budget の操作に失敗しました。";
}

function isRevisionConflict(error: unknown): boolean {
  const message = formatError(error);
  return message.includes("BUDGET_REVISION_CONFLICT") || /budget revision changed/i.test(message);
}

function formatMeteredCost(budget: ResourceBudget): string {
  const entries = Object.entries(budget.meteredUsageSummary.monetaryCostByCurrency);
  return entries.length > 0
    ? entries.map(([currency, amount]) => `${amount.toLocaleString()} ${currency}`).join(", ")
    : "記録なし";
}

export function ResourceBudgetSettings() {
  const [sessions, setSessions] = useState<HomeSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [budget, setBudget] = useState<ResourceBudget | null>(null);
  const [hardLimitDraft, setHardLimitDraft] = useState<HardLimitDraft | null>(null);
  const [retryPerExecutionLimitDraft, setRetryPerExecutionLimitDraft] = useState("");
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [reloadSequence, setReloadSequence] = useState(0);
  const pendingSave = useRef<ResourceBudgetSaveIdentity | null>(null);

  const loadSessionPage = async (cursor: string | null) => {
    const api = getWithMateApi();
    if (!api) {
      setFeedback("Resource budget はデスクトップ版で設定できます。");
      setLoadingSessions(false);
      return;
    }

    setLoadingSessions(true);
    try {
      const page = await api.listSessionSummaryPage({
        scope: "recent",
        cursor,
        limit: SESSION_PAGE_LIMIT,
        searchText: "",
      });
      setSessions((current) => {
        const merged = cursor ? [...current, ...page.entries] : page.entries;
        return Array.from(new Map(merged.map((entry) => [entry.id, entry])).values());
      });
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setSelectedSessionId((current) => current || page.entries[0]?.id || "");
      setFeedback("");
    } catch (error) {
      setFeedback(formatError(error));
    } finally {
      setLoadingSessions(false);
    }
  };

  useEffect(() => {
    void loadSessionPage(null);
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setBudget(null);
      setHardLimitDraft(null);
      setRetryPerExecutionLimitDraft("");
      setDeadlineDraft("");
      return;
    }

    let active = true;
    const loadBudget = async () => {
      const api = getWithMateApi();
      if (!api) return;
      setLoadingBudget(true);
      setFeedback("");
      try {
        const selectedBudget = await api.getResourceBudget({ sessionId: selectedSessionId });
        const rootBudget = selectedBudget && selectedBudget.accountKind !== "root"
          ? await api.getResourceBudget({ sessionId: selectedBudget.rootSessionId })
          : selectedBudget;
        if (!active) return;
        setBudget(rootBudget);
        setHardLimitDraft(rootBudget ? toHardLimitDraft(rootBudget) : null);
        setRetryPerExecutionLimitDraft(rootBudget ? String(rootBudget.retryPerExecutionLimit) : "");
        setDeadlineDraft(rootBudget ? toLocalDateTime(rootBudget.deadlineAt) : "");
        if (!rootBudget) {
          setFeedback("選択した Session の Resource budget がありません。");
        }
      } catch (error) {
        if (active) {
          setBudget(null);
          setHardLimitDraft(null);
          setRetryPerExecutionLimitDraft("");
          setDeadlineDraft("");
          setFeedback(formatError(error));
        }
      } finally {
        if (active) setLoadingBudget(false);
      }
    };
    void loadBudget();
    return () => {
      active = false;
    };
  }, [reloadSequence, selectedSessionId]);

  const isDirty = useMemo(() => {
    if (!budget || !hardLimitDraft) return false;
    if (toLocalDateTime(budget.deadlineAt) !== deadlineDraft) return true;
    if (String(budget.retryPerExecutionLimit) !== retryPerExecutionLimitDraft) return true;
    return RESOURCE_BUDGET_DIMENSIONS.some(
      (dimension) => hardLimitDraft[dimension] !== String(budget.dimensions[dimension].hardLimit),
    );
  }, [budget, deadlineDraft, hardLimitDraft, retryPerExecutionLimitDraft]);

  const save = async () => {
    if (!budget || !hardLimitDraft) return;
    const api = getWithMateApi();
    if (!api) return;

    const hardLimits: Partial<Record<ResourceBudgetDimension, number>> = {};
    for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
      const parsed = Number(hardLimitDraft[dimension]);
      const current = budget.dimensions[dimension].hardLimit;
      if (!Number.isSafeInteger(parsed) || parsed < current) {
        setFeedback(`${DIMENSION_LABELS[dimension]}は現在の上限 ${current.toLocaleString()} 以上の整数を入力してください。`);
        return;
      }
      if (parsed !== current) hardLimits[dimension] = parsed;
    }
    const retryPerExecutionLimit = Number(retryPerExecutionLimitDraft);
    if (!Number.isSafeInteger(retryPerExecutionLimit)
      || retryPerExecutionLimit < budget.retryPerExecutionLimit) {
      setFeedback(
        `失敗した実行ごとの retry 上限は現在値 ${budget.retryPerExecutionLimit.toLocaleString()} 以上の整数を入力してください。`,
      );
      return;
    }
    const changedRetryPerExecutionLimit = retryPerExecutionLimit !== budget.retryPerExecutionLimit;

    const changedDeadline = deadlineDraft !== toLocalDateTime(budget.deadlineAt);
    const deadlineAt = new Date(deadlineDraft);
    if (changedDeadline && (!deadlineDraft || !Number.isFinite(deadlineAt.getTime()))) {
      setFeedback("有効期限を入力してください。");
      return;
    }
    if (changedDeadline && deadlineAt.getTime() < Date.parse(budget.deadlineAt)) {
      setFeedback("有効期限は現在の期限以降を入力してください。");
      return;
    }
    if (changedDeadline && deadlineAt.getTime() <= Date.now()) {
      setFeedback("期限切れの Root を再開するには、現在より後の有効期限を入力してください。");
      return;
    }

    if (Object.keys(hardLimits).length === 0 && !changedDeadline && !changedRetryPerExecutionLimit) return;

    const fingerprint = JSON.stringify({
      accountId: budget.accountId,
      expectedRevision: budget.revision,
      hardLimits,
      deadlineAt: changedDeadline ? deadlineAt.toISOString() : undefined,
      retryPerExecutionLimit: changedRetryPerExecutionLimit ? retryPerExecutionLimit : undefined,
    });
    const saveIdentity = pendingSave.current?.fingerprint === fingerprint
      ? pendingSave.current
      : { fingerprint, idempotencyKey: createIdempotencyKey() };
    pendingSave.current = saveIdentity;
    const { idempotencyKey } = saveIdentity;

    setSaving(true);
    setFeedback("");
    try {
      const updated = await api.configureResourceBudget({
        sessionId: budget.rootSessionId,
        accountId: budget.accountId,
        expectedRevision: budget.revision,
        ...(Object.keys(hardLimits).length > 0
          ? { hardLimits: hardLimits as ResourceBudgetPartialAmounts }
          : {}),
        ...(changedDeadline ? { deadlineAt: deadlineAt.toISOString() } : {}),
        ...(changedRetryPerExecutionLimit ? { retryPerExecutionLimit } : {}),
        idempotencyKey,
      });
      pendingSave.current = null;
      setBudget(updated);
      setHardLimitDraft(toHardLimitDraft(updated));
      setRetryPerExecutionLimitDraft(String(updated.retryPerExecutionLimit));
      setDeadlineDraft(toLocalDateTime(updated.deadlineAt));
      setFeedback("Resource budget を保存しました。");
    } catch (error) {
      setFeedback(isRevisionConflict(error)
        ? "Resource budget が更新されています。最新の状態を再読み込みしてから、変更内容を確認してください。"
        : formatError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section-card">
      <div className="settings-field">
        <strong>Resource Budget</strong>
        <p className="settings-help">
          Root の hard limit、実行ごとの retry 上限、期限を延長できます。累積消費や過去の実行結果は変更されません。token・費用は計測のみです。
          同じ Root 配下の Session が候補へ複数表示される場合があります。
        </p>
        <label className="settings-provider-input">
          <span>対象 Root（Session から選択）</span>
          <select
            value={selectedSessionId}
            onChange={(event) => {
              pendingSave.current = null;
              setSelectedSessionId(event.target.value);
            }}
            disabled={loadingSessions || loadingBudget || saving || sessions.length === 0}
          >
            {sessions.length === 0 ? <option value="">Session がありません</option> : null}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.taskTitle || "名称未設定"} ({session.id})
              </option>
            ))}
          </select>
        </label>
        {hasMore ? (
          <div className="settings-actions">
            <button
              className="launch-toggle"
              type="button"
              disabled={loadingSessions || loadingBudget || saving || !nextCursor}
              onClick={() => void loadSessionPage(nextCursor)}
            >
              Session 候補をさらに読み込む
            </button>
          </div>
        ) : null}

        <div className="settings-actions">
          <button
            className="launch-toggle"
            type="button"
            disabled={!selectedSessionId || loadingSessions || loadingBudget || saving}
            onClick={() => {
              pendingSave.current = null;
              setFeedback("");
              setReloadSequence((current) => current + 1);
            }}
          >
            最新の Resource budget を再読み込み
          </button>
        </div>

        {loadingBudget ? <p className="settings-note">Resource budget を読み込んでいます。</p> : null}
        {budget && hardLimitDraft && !loadingBudget ? (
          <>
            <div className="settings-diagnostics-grid">
              {RESOURCE_BUDGET_DIMENSIONS.map((dimension) => {
                const state = budget.dimensions[dimension];
                return (
                  <div key={dimension} className="settings-diagnostics-item">
                    <span>{DIMENSION_LABELS[dimension]}</span>
                    <strong>{state.measurement === "unknown" ? "使用量不明" : `${state.committed.toLocaleString()} committed`}</strong>
                    <small>
                      {state.measurement === "unknown" ? `記録済み ${state.committed.toLocaleString()} / ` : ""}
                      reserved {state.reserved.toLocaleString()} / 子への配分 {state.allocatedToChildren.toLocaleString()} / 利用可能 {state.available.toLocaleString()}
                      {state.unknownSince ? ` / unknown since ${new Date(state.unknownSince).toLocaleString()}` : ""}
                    </small>
                  </div>
                );
              })}
              <div className="settings-diagnostics-item settings-diagnostics-wide">
                <span>token・費用（計測のみ）</span>
                <strong>
                  tokens {budget.meteredUsageSummary.knownTokens.toLocaleString()} / provider usage {budget.meteredUsageSummary.knownProviderUsage.toLocaleString()}
                </strong>
                <small>
                  費用 {formatMeteredCost(budget)} / unknown records {
                    Object.values(budget.meteredUsageSummary.unknownRecords).reduce((total, count) => total + count, 0).toLocaleString()
                  }
                  {budget.meteredUsageTruncated ? " / 明細は一部省略" : ""}
                </small>
              </div>
            </div>
            <div className="settings-provider-list">
              {RESOURCE_BUDGET_DIMENSIONS.map((dimension) => (
                <label key={dimension} className="settings-provider-input">
                  <span>{DIMENSION_LABELS[dimension]}の hard limit</span>
                  <input
                    type="number"
                    min={budget.dimensions[dimension].hardLimit}
                    step={1}
                    value={hardLimitDraft[dimension]}
                    onChange={(event) => {
                      pendingSave.current = null;
                      setHardLimitDraft((current) => current
                        ? { ...current, [dimension]: event.target.value }
                        : current);
                    }}
                    disabled={saving}
                  />
                </label>
              ))}
              <label className="settings-provider-input">
                <span>失敗した実行ごとの retry 上限</span>
                <input
                  type="number"
                  min={budget.retryPerExecutionLimit}
                  step={1}
                  value={retryPerExecutionLimitDraft}
                  onChange={(event) => {
                    pendingSave.current = null;
                    setRetryPerExecutionLimitDraft(event.target.value);
                  }}
                  disabled={saving}
                />
              </label>
              <label className="settings-provider-input">
                <span>有効期限</span>
                <input
                  type="datetime-local"
                  min={toLocalDateTime(budget.deadlineAt)}
                  value={deadlineDraft}
                  onChange={(event) => {
                    pendingSave.current = null;
                    setDeadlineDraft(event.target.value);
                  }}
                  disabled={saving}
                />
              </label>
            </div>
            <p className="settings-help">
              Root Session {budget.rootSessionId} / revision {budget.revision}
              {budget.revokedAt ? ` / revoked ${new Date(budget.revokedAt).toLocaleString()}` : ""}
            </p>
            <div className="settings-actions">
              <button className="launch-toggle" type="button" onClick={() => void save()} disabled={!isDirty || saving}>
                {saving ? "保存中..." : "Resource budget を保存"}
              </button>
            </div>
          </>
        ) : null}
        {feedback ? <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p> : null}
      </div>
    </section>
  );
}
