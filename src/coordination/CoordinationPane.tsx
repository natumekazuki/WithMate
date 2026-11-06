import { useEffect, useRef, useState } from "react";
import type {
  CoordinationRecord,
  CoordinationRequest,
  CoordinationSummary,
  CoordinationIdentity,
} from "../../src-shared/coordination/coordination-contract.js";
import type { OpenCoordinationRequest } from "../../src-shared/coordination/coordination-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { ButtonContent } from "../ui/button-content.js";
import { LoadError } from "../ui/load-error.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { MessageRichText } from "../ui/markdown/MessageRichText.js";
import { useCoordinationQuery } from "./use-coordination-query.js";
import { CoordinationAnswerDelivery } from "./CoordinationAnswerDelivery.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { coordinationIdentityKey, useCoordinationIdentities } from "./use-coordination-identities.js";

export function coordinationKindLabel(
  kind: CoordinationSummary["kind"],
): string {
  return {
    progress: "Progress",
    decision: "Decision",
    escalation: "Escalation",
    user_decision_required: "User Decision",
    blocker: "Blocker",
    result: "Result",
    correction: "Correction",
  }[kind];
}
function stateLabel(state: CoordinationSummary["state"]): string {
  return {
    open: "Open",
    resolved: "Resolved",
    withdrawn: "Withdrawn",
    corrected: "Corrected",
  }[state];
}
type Draft = {
  body: string;
  choices: string[];
  reason: string;
  pendingRequest?: CoordinationRequest;
  feedback?: string;
};

export function CoordinationPane({
  sessionId,
  active,
  navigation,
}: {
  sessionId: string;
  active: boolean;
  navigation: OpenCoordinationRequest | null;
}) {
  const [pendingOnly, setPendingOnly] = useState(true);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [originError, setOriginError] = useState<{ id: string; message: string } | null>(null);
  const operationInFlight = useRef(false);
  const draftKey = `${sessionId}:${selectedId ?? ""}`;
  const draft = drafts[draftKey] ?? { body: "", choices: [], reason: "" };
  const updateDraft = (change: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...draft, ...change },
    }));
  useEffect(() => {
    setOffset(0);
    setSelectedId(null);
  }, [sessionId]);
  useEffect(() => {
    if (!navigation) return;
    setPendingOnly(true);
    setOffset(0);
    setSelectedId(navigation.id ?? null);
  }, [navigation]);
  const list = useCoordinationQuery(
    {
      operation: "list",
      allCrews: true,
      mainSessionId: sessionId,
      userPending: pendingOnly,
      offset,
      limit: 30,
    },
    active && !selectedId,
  );
  const detail = useCoordinationQuery(
    selectedId ? { operation: "get", id: selectedId } : null,
    active,
  );
  const page = list.result && "items" in list.result ? list.result : null;
  const record =
    detail.result && "record" in detail.result ? detail.result.record : null;
  const initiatorTarget =
    detail.result && "record" in detail.result
      ? detail.result.initiatorTarget
      : undefined;
  const identities = useCoordinationIdentities(
    selectedId
      ? record ? [record.initiator, ...(record.respondent.kind === "user" ? [] : [record.respondent]), ...record.answers.flatMap((answer) => answer.actor.kind === "user" ? [] : [answer.actor])] : []
      : page?.items.map((item) => item.initiator) ?? [],
    active,
  );
  const identityRead = (identity: CoordinationIdentity) => identities.reads[coordinationIdentityKey(identity)];
  const identityTitle = (identity: CoordinationIdentity) => {
    const read = identityRead(identity);
    return read?.identity?.title ?? (read?.error ? "Session Identity Unavailable" : read ? "Session Unavailable" : "Loading Session");
  };
  const identityAvatar = (identity: CoordinationIdentity) => (
    <CharacterAvatar key={coordinationIdentityKey(identity)} character={identityRead(identity)?.identity?.character ?? { name: "?", iconPath: "" }} size="tiny" />
  );
  const openOrigin = async () => {
    if (!record || !initiatorTarget) return;
    const id = record.id;
    setOriginError(null);
    try {
      await getWithMateApi()!.openSession(
        initiatorTarget.kind === "main" ? initiatorTarget.sessionId : initiatorTarget.mainSessionId,
        initiatorTarget.kind === "auxiliary" ? initiatorTarget.sessionId : undefined,
      );
    } catch (error) {
      setOriginError({ id, message: error instanceof Error ? error.message : "Could not open the originating Session." });
    }
  };

  const mutate = async (request: CoordinationRequest) => {
    if (operationInFlight.current) return;
    const api = getWithMateApi();
    if (!api) return;
    const key = draftKey;
    operationInFlight.current = true;
    setBusyId(selectedId);
    setDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? draft),
        pendingRequest: request,
        feedback: undefined,
      },
    }));
    try {
      const result = await api.executeCoordination(request);
      if ("error" in result) {
        detail.markDeleted(result.error.message);
        setDrafts((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? draft),
            pendingRequest: undefined,
            feedback: undefined,
          },
        }));
        list.refresh();
        return;
      }
      const receipt = "record" in result ? result.receipt : undefined;
      setDrafts((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? draft),
          pendingRequest: undefined,
          feedback: receipt
            ? `Saved · Delivery ${receipt.state} · Receipt ${receipt.id}${receipt.turnId ? ` · Turn ${receipt.turnId}` : ""}`
            : "Saved",
        },
      }));
      detail.refresh();
      list.refresh();
    } catch (error) {
      // Keep both the text and exact operation for an explicit idempotent retry.
      setDrafts((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? draft),
          pendingRequest: request,
          feedback: `${error instanceof Error ? error.message : "The result could not be confirmed."} Refresh to check the saved state before retrying this operation.`,
        },
      }));
    } finally {
      operationInFlight.current = false;
      setBusyId(null);
    }
  };
  const buttonsDisabled =
    busyId !== null || Boolean(draft.pendingRequest) || Boolean(detail.error);
  const renderDetail = (item: CoordinationRecord) => (
    <>
      <div className="coordination-origin">
        <button type="button" className="coordination-detail-origin" disabled={!initiatorTarget} aria-label={`Open Origin: ${identityTitle(item.initiator)}`} onClick={() => void openOrigin()}>
          {identityAvatar(item.initiator)}
          <span><strong>{identityRead(item.initiator)?.identity?.character.name ?? "Session"}</strong><span className="coordination-session-title">{identityTitle(item.initiator)}</span></span>
        </button>
        {identityRead(item.initiator)?.error ? <LoadError message={identityRead(item.initiator)!.error!} onRetry={identities.refresh} /> : null}
        {originError?.id === item.id ? <LoadError message={originError.message} onRetry={() => void openOrigin()} /> : null}
      </div>
      <div className="coordination-event-meta">
        <span className={`coordination-kind coordination-kind-${item.kind}`}>{coordinationKindLabel(item.kind)}</span>
        <span className={`coordination-state coordination-state-${item.state}`}>{stateLabel(item.state)}</span>
        <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("en-US")}</time>
      </div>
      <p className="coordination-parties">
        Respondent:{" "}
        {item.respondent.kind === "user" ? "User" : identityTitle(item.respondent)}
      </p>
      <MessageRichText text={item.body} embeddedMedia="text" />
      {item.state === "withdrawn" ? (
        <div className="coordination-withdrawal" role="status">
          <strong>Withdrawn</strong>
          {item.withdrawalReason ? <p>{item.withdrawalReason}</p> : null}
        </div>
      ) : null}
      {item.answers.length ? (
        <section className="coordination-answers" aria-label="Saved answers">
          {item.answers.map((answer) => (
            <article key={answer.id}>
              <div className="coordination-detail-heading">
                <strong>Answer {answer.revision}</strong>
                <span>
                  {answer.actor.kind === "user"
                    ? "User"
                    : identityTitle(answer.actor)}
                </span>
              </div>
              <MessageRichText text={answer.body} embeddedMedia="text" />
              {answer.selectedChoices.length ? (
                <p>{answer.selectedChoices.join(" · ")}</p>
              ) : null}
              <CoordinationAnswerDelivery
                ownerSessionId={sessionId}
                target={initiatorTarget}
                receiptId={answer.receiptId}
              />
              {answer.consumedByOperationId ? (
                <p className="coordination-parties">
                  Consumed By Originating Session
                </p>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      {item.respondent.kind === "user" ? (
        <form
          className="coordination-answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            const body = draft.body.trim() || draft.choices.join("\n");
            if (buttonsDisabled || !body) return;
            void mutate({
              operation: "answer",
              id: item.id,
              operationId: crypto.randomUUID(),
              body,
              selectedChoices: draft.choices,
              expectedAnswerRevision: item.answerRevision,
              send: true,
            });
          }}
        >
          <fieldset disabled={buttonsDisabled}>
            <legend>{item.answerRevision ? "Change Answer" : "Answer"}</legend>
            {item.choices.map((choice) => (
              <label key={choice} className={`coordination-choice${draft.choices.includes(choice) ? " selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={draft.choices.includes(choice)}
                  onChange={(event) =>
                    updateDraft({
                      choices: event.target.checked
                        ? [...draft.choices, choice]
                        : draft.choices.filter((value) => value !== choice),
                    })
                  }
                />
                <span>{choice}</span>
              </label>
            ))}
            <textarea
              aria-label="Coordination answer"
              rows={5}
              value={draft.body}
              onChange={(event) => updateDraft({ body: event.target.value })}
            />
            <button
              type="submit"
              className="drawer-toggle compact secondary coordination-primary-action"
              disabled={!draft.body.trim() && !draft.choices.length}
              aria-busy={busyId === item.id}
            >
              <ButtonContent
                busy={busyId === item.id}
                busyLabel="Saving answer"
              >
                Save And Send Answer
              </ButtonContent>
            </button>
          </fieldset>
        </form>
      ) : null}
      <details className="coordination-actions">
        <summary>Resolution And Withdrawal</summary>
        <button
          type="button"
          className="drawer-toggle compact secondary"
          disabled={buttonsDisabled || item.state !== "open"}
          onClick={() =>
            void mutate({
              operation: "resolve",
              id: item.id,
              operationId: crypto.randomUUID(),
            })
          }
        >
          Resolve
        </button>
        <label>
          Withdrawal Reason
          <textarea
            rows={2}
            value={draft.reason}
            disabled={buttonsDisabled}
            onChange={(event) => updateDraft({ reason: event.target.value })}
          />
        </label>
        <button
          type="button"
          className="drawer-toggle compact secondary"
          disabled={buttonsDisabled || item.state === "withdrawn"}
          onClick={() =>
            void mutate({
              operation: "withdraw",
              id: item.id,
              operationId: crypto.randomUUID(),
              reason: draft.reason,
            })
          }
        >
          Withdraw
        </button>
      </details>
      <details>
        <summary>References And History</summary>
        <dl className="coordination-references">
          <dt>Coordination</dt>
          <dd>{item.id}</dd>
          <dt>Origin Turn</dt>
          <dd>{item.initiatorTurnId}</dd>
          {item.originReceiptId ? (
            <>
              <dt>Origin Receipt</dt>
              <dd>{item.originReceiptId}</dd>
            </>
          ) : null}
        </dl>
        <ol className="coordination-history">
          {item.history.map((entry) => (
            <li key={entry.operationId}>
              <strong>{entry.operation}</strong> ·{" "}
              {new Date(entry.at).toLocaleString("en-US")}
              {entry.body ? <p>{entry.body}</p> : null}
              {entry.receiptId ? <p>Receipt {entry.receiptId}</p> : null}
              {entry.correctionId ? (
                <button
                  type="button"
                  className="drawer-toggle compact secondary"
                  onClick={() => setSelectedId(entry.correctionId!)}
                >
                  Open Correction
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
  return (
    <div className="coordination-pane" hidden={!active}>
      <div className="coordination-toolbar">
        {selectedId ? (
          <button
            type="button"
            className="drawer-toggle compact secondary"
            onClick={() => setSelectedId(null)}
          >
            Back To List
          </button>
        ) : (
          <div className="coordination-filter-tabs" role="group" aria-label="Coordination filter">
            {([[true, "Needs Your Response"], [false, "All Records"]] as const).map(([pending, label]) => <button key={String(pending)} type="button" aria-pressed={pendingOnly === pending} className={pendingOnly === pending ? "active" : ""} onClick={() => { setPendingOnly(pending); setOffset(0); }}>{label}</button>)}
          </div>
        )}
        {!(selectedId ? detail.deleted : list.deleted) ? <button
          type="button"
          className="drawer-toggle compact secondary"
          onClick={() => { (selectedId ? detail.refresh : list.refresh)(); identities.refresh(); }}
        >
          Refresh
        </button> : null}
      </div>
      {(selectedId ? detail.loading : list.loading) ? (
        <LoadingIndicator label="Loading Coordination" />
      ) : null}
      {(selectedId ? detail.deleted : list.deleted) ? (
        <section
          className="coordination-deleted"
          role="status"
          aria-label="Deleted Coordination"
        >
          <strong>Deleted</strong>
          <p>{selectedId ? detail.error : list.error}</p>
          {draft.body || draft.choices.length ? (
            <label>
              Unsent Answer Draft
              <textarea
                readOnly
                aria-label="Unsent answer draft"
                value={[draft.body, ...draft.choices]
                  .filter(Boolean)
                  .join("\n")}
              />
            </label>
          ) : null}
        </section>
      ) : (selectedId ? detail.error : list.error) ? (
        <LoadError
          message={selectedId ? detail.error : list.error}
          onRetry={selectedId ? detail.refresh : list.refresh}
        />
      ) : null}
      {selectedId ? (
        detail.deleted ? null : record ? (
          renderDetail(record)
        ) : null
      ) : (
        <>
          <div className="coordination-list">
            {page?.items.map((item) => (
              <button
                type="button"
                className="coordination-list-row"
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                {identityAvatar(item.initiator)}
                <span className="coordination-event-copy">
                  <strong className="coordination-list-preview">{item.bodyPreview}</strong>
                  <span className="coordination-session-title">{identityRead(item.initiator)?.identity?.character.name ?? "Session"} · {identityTitle(item.initiator)}</span>
                  <span className="coordination-event-meta">
                    <span className={`coordination-kind coordination-kind-${item.kind}`}>{coordinationKindLabel(item.kind)}</span>
                    <span className={`coordination-state coordination-state-${item.state}`}>{stateLabel(item.state)}</span>
                    <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("en-US")}</time>
                  </span>
                </span>
              </button>
            ))}
          </div>
          {page && (offset > 0 || page.nextOffset !== null) ? (
            <nav
              className="coordination-toolbar"
              aria-label="Coordination pages"
            >
              <button
                type="button"
                className="drawer-toggle compact secondary"
                disabled={offset === 0 || list.loading}
                onClick={() => setOffset(Math.max(0, offset - 30))}
              >
                Previous
              </button>
              <span>
                {offset + 1}–{offset + page.items.length} / {page.total}
              </span>
              <button
                type="button"
                className="drawer-toggle compact secondary"
                disabled={page.nextOffset === null || list.loading}
                onClick={() => setOffset(page.nextOffset!)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      )}
      {draft.feedback && !detail.deleted ? (
        <p className="coordination-operation-feedback" role="status">
          {draft.feedback}
        </p>
      ) : null}
      {draft.pendingRequest && busyId === null && !detail.deleted ? (
        <div className="coordination-toolbar">
          <button
            className="drawer-toggle compact secondary"
            type="button"
            onClick={() => void mutate(draft.pendingRequest!)}
          >
            Retry Same Operation
          </button>
          <button
            type="button"
            className="drawer-toggle compact secondary"
            onClick={() => {
              detail.refresh();
              updateDraft({
                pendingRequest: undefined,
                feedback:
                  "Operation retained no longer. Check the saved answers before submitting a new operation.",
              });
            }}
          >
            Keep Draft And Check Saved State
          </button>
        </div>
      ) : null}
    </div>
  );
}
