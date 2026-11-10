import { useEffect, useRef, useState } from "react";
import type {
  CoordinationRecord,
  CoordinationRequest,
  CoordinationSummary,
  CoordinationIdentity,
  CoordinationAnswer,
} from "../../src-shared/coordination/coordination-contract.js";
import type { OpenCoordinationRequest } from "../../src-shared/coordination/coordination-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { ButtonContent } from "../ui/button-content.js";
import { LoadError } from "../ui/load-error.js";
import { MessageRichText } from "../ui/markdown/MessageRichText.js";
import { useCoordinationQuery } from "./use-coordination-query.js";
import { CoordinationAnswerDelivery, receiptStateLabel } from "./CoordinationAnswerDelivery.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { coordinationIdentityKey, useCoordinationIdentities } from "./use-coordination-identities.js";

function stateLabel(state: CoordinationSummary["state"]): string {
  return {
    open: "Open",
    resolved: "Resolved",
    withdrawn: "Withdrawn",
    corrected: "Corrected",
  }[state];
}
function responseLabel(item: CoordinationSummary): string | null {
  if (item.state === "open" && item.respondent.kind === "user") {
    return item.answerRevision ? "Reply Recorded" : null;
  }
  return item.state === "open" ? null : stateLabel(item.state);
}
type Draft = {
  body: string;
  choices: string[];
  reason: string;
  pendingRequest?: CoordinationRequest;
  feedback?: string;
  editing?: boolean;
  confirmedAnswer?: CoordinationAnswer;
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
  const actionsTriggerRef = useRef<HTMLElement>(null);
  const operationInFlight = useRef(false);
  const draftKey = `${sessionId}:${selectedId ?? ""}`;
  const draft = drafts[draftKey] ?? { body: "", choices: [], reason: "" };
  const updateDraft = (change: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...draft, feedback: undefined, ...change },
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
  const fetchedRecord =
    detail.result && "record" in detail.result ? detail.result.record : null;
  const confirmedAnswer = draft.confirmedAnswer;
  const record = fetchedRecord && confirmedAnswer && confirmedAnswer.revision > fetchedRecord.answerRevision
    ? { ...fetchedRecord, answerRevision: confirmedAnswer.revision, answers: [...fetchedRecord.answers, confirmedAnswer] }
    : fetchedRecord;
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
  const identityName = (identity: CoordinationIdentity) => identityRead(identity)?.identity?.character.name ?? "Session";
  const identityAvatar = (identity: CoordinationIdentity) => (
    <CharacterAvatar key={coordinationIdentityKey(identity)} character={identityRead(identity)?.identity?.character ?? { name: "?", iconPath: "" }} size="tiny" />
  );
  const identityKind = (identity: CoordinationIdentity) => (
    <span className="coordination-session-kind" role="img"
      aria-label={identity.kind === "main" ? "Main" : "Auxiliary"}
      title={identity.kind === "main" ? "Main" : "Auxiliary"}>
      <ComposerIcon name={identity.kind} />
    </span>
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
      const confirmed = request.operation === "answer" && "record" in result
        ? result.record.answers.find((answer) => answer.id === request.operationId)
        : undefined;
      setDrafts((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? draft),
          pendingRequest: undefined,
          ...(confirmed ? { confirmedAnswer: confirmed, editing: false } : {}),
          feedback: confirmed ? undefined : receipt ? `Saved · Delivery ${receiptStateLabel(receipt.state)}` : "Saved",
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
  const renderAnswer = (answer: CoordinationAnswer, historical = false, onEdit?: () => void) => (
    <article key={answer.id}>
      <div className="coordination-detail-heading">
        <strong>{answer.actor.kind === "user" ? "Your Answer" : identityTitle(answer.actor)}</strong>
        {historical ? <span>Revision {answer.revision}</span> : onEdit ? <button type="button" className="drawer-toggle compact secondary coordination-edit-answer" aria-label="Change Answer" title="Change Answer" onClick={onEdit}><ComposerIcon name="edit" /></button> : null}
      </div>
      <MessageRichText text={answer.body} embeddedMedia="text" />
      {answer.selectedChoices.length && answer.body !== answer.selectedChoices.join("\n") ? <p>{answer.selectedChoices.join(" · ")}</p> : null}
      {!historical ? <CoordinationAnswerDelivery
        ownerSessionId={sessionId}
        target={initiatorTarget}
        receiptId={answer.receiptId}
        consumed={Boolean(answer.consumedByOperationId)}
        active={active}
      /> : null}
    </article>
  );
  const renderDetail = (item: CoordinationRecord) => {
    const latestUserAnswer = [...item.answers].reverse().find((answer) => answer.actor.kind === "user");
    const showEditor = item.respondent.kind === "user" && (!latestUserAnswer || draft.editing || Boolean(draft.pendingRequest));
    const history = item.history.filter((entry) => entry.operation !== "create");
    const editAnswer = latestUserAnswer && item.respondent.kind === "user" && !showEditor ? () => updateDraft({
      editing: true,
      ...(draft.editing === undefined ? {
        body: latestUserAnswer.body === latestUserAnswer.selectedChoices.join("\n") ? "" : latestUserAnswer.body,
        choices: latestUserAnswer.selectedChoices,
      } : {}),
    }) : undefined;
    return (
    <>
      <div className="coordination-origin">
        <div className="coordination-origin-heading">
          <button type="button" className="coordination-detail-origin" disabled={!initiatorTarget} aria-label={`Open Origin: ${identityName(item.initiator)} · ${identityTitle(item.initiator)} (${item.initiator.kind === "main" ? "Main" : "Auxiliary"})`} onClick={() => void openOrigin()}>
            {identityAvatar(item.initiator)}
            <span className="coordination-session-identity">
              {identityKind(item.initiator)}
              <span className="coordination-session-title" title={identityTitle(item.initiator)}>{identityTitle(item.initiator)}</span>
            </span>
          </button>
          <details key={item.id} className="coordination-actions" onKeyDown={(event) => {
            if (event.key !== "Escape" || !event.currentTarget.open) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            actionsTriggerRef.current?.focus();
          }}>
            <summary ref={actionsTriggerRef} className="drawer-toggle compact secondary coordination-actions-trigger" aria-label="Consultation Actions" title="Consultation Actions"><span aria-hidden="true">⋯</span></summary>
            <div className="coordination-actions-menu">
              <button type="button" className="drawer-toggle compact secondary" disabled={buttonsDisabled || item.state !== "open"} onClick={() => void mutate({ operation: "resolve", id: item.id, operationId: crypto.randomUUID() })}>Resolve</button>
              <label>Withdrawal Reason<textarea rows={2} value={draft.reason} disabled={buttonsDisabled} onChange={(event) => updateDraft({ reason: event.target.value })} /></label>
              <button type="button" className="drawer-toggle compact secondary" disabled={buttonsDisabled || item.state === "withdrawn"} onClick={() => void mutate({ operation: "withdraw", id: item.id, operationId: crypto.randomUUID(), reason: draft.reason })}>Withdraw</button>
            </div>
          </details>
        </div>
        {identityRead(item.initiator)?.error ? <LoadError message={identityRead(item.initiator)!.error!} onRetry={identities.refresh} /> : null}
        {originError?.id === item.id ? <LoadError message={originError.message} onRetry={() => void openOrigin()} /> : null}
      </div>
      {item.state !== "open" && item.state !== "withdrawn" ? <p className="coordination-response-state">{stateLabel(item.state)}</p> : null}
      {item.respondent.kind !== "user" ? <p className="coordination-parties">Assigned To: {identityTitle(item.respondent)}</p> : null}
      <section className="coordination-body" aria-label="Consultation"><MessageRichText text={item.body} embeddedMedia="text" /></section>
      {item.state === "withdrawn" ? (
        <div className="coordination-withdrawal" role="status">
          <strong>Withdrawn</strong>
          {item.withdrawalReason ? <p>{item.withdrawalReason}</p> : null}
        </div>
      ) : null}
      {item.answers.length ? (
        <section className="coordination-answers" aria-label="Saved answers">
          {renderAnswer(item.answers[item.answers.length - 1], false, editAnswer)}
        </section>
      ) : null}
      {showEditor ? (
        <form
          className="coordination-answer-form"
          onFocus={() => { if (!draft.editing) updateDraft({ editing: true }); }}
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
          <fieldset disabled={buttonsDisabled} aria-label={latestUserAnswer ? "Change Your Answer" : "Your Answer"}>
            {item.choices.map((choice) => (
              <label key={choice} className={`coordination-choice${draft.choices.includes(choice) ? " selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={draft.choices.includes(choice)}
                  onChange={(event) =>
                    updateDraft({
                      editing: true,
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
              rows={3}
              value={draft.body}
              onChange={(event) => updateDraft({ body: event.target.value, editing: true })}
            />
            <div className="coordination-answer-actions">
              {latestUserAnswer ? <button type="button" className="drawer-toggle compact secondary" onClick={() => updateDraft({ editing: false })}>Cancel</button> : null}
              <button
              type="submit"
              className="drawer-toggle composer-icon-button coordination-primary-action"
              aria-label="Save And Send Answer"
              title="Save And Send Answer"
              disabled={!draft.body.trim() && !draft.choices.length}
              aria-busy={busyId === item.id}
            >
              <ButtonContent
                busy={busyId === item.id}
                busyLabel="Saving answer"
              >
                <ComposerIcon name="send" />
              </ButtonContent>
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}
      {draft.feedback ? <p className="coordination-operation-feedback" role="status">{draft.feedback}</p> : null}
      {draft.pendingRequest && busyId === null ? (
        <div className="coordination-recovery">
          <button className="drawer-toggle compact secondary" type="button" onClick={() => void mutate(draft.pendingRequest!)}>Retry Same Operation</button>
          <button type="button" className="drawer-toggle compact secondary" onClick={() => {
            detail.refresh();
            updateDraft({ pendingRequest: undefined, feedback: "Operation retained no longer. Check the saved answers before submitting a new operation." });
          }}>Keep Draft And Check Saved State</button>
        </div>
      ) : null}
      {history.length || item.answers.length > 1 ? <details className="artifact-fold">
        <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>History</strong></span></summary>
        {item.answers.slice(0, -1).map((answer) => renderAnswer(answer, true))}
        <ol className="coordination-history">
          {history.map((entry) => (
            <li key={entry.operationId}>
              <strong>{({ create: "Created", deliver: "Sent", escalate: "Escalated", answer: "Answered", resolve: "Resolved", consume: "Answer Used", withdraw: "Withdrawn", correct: "Corrected" } as Record<string, string>)[entry.operation] ?? entry.operation}</strong> ·{" "}
              {new Date(entry.at).toLocaleString("en-US")}
              {entry.body && entry.operation !== "answer" && entry.operation !== "create" ? <p>{entry.body}</p> : null}
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
      </details> : null}
    </>
    );
  };
  return (
    <div className="coordination-pane" hidden={!active} aria-busy={(selectedId ? detail.loading : list.loading) || undefined}>
      <div className="coordination-toolbar coordination-navigation">
        {selectedId ? (
          <button
            type="button"
            className="drawer-toggle compact secondary coordination-toolbar-icon"
            title="Back To List" aria-label="Back To List"
            onClick={() => setSelectedId(null)}
          >
            <span aria-hidden="true">‹</span>
          </button>
        ) : (
          <div className="coordination-filter-tabs" role="group" aria-label="Coordination filter">
            {([[true, "For You", "Open Consultations For You"], [false, "All", "All Records"]] as const).map(([pending, label, accessibleLabel]) => <button key={String(pending)} type="button" aria-label={accessibleLabel} title={accessibleLabel} aria-pressed={pendingOnly === pending} className={`drawer-toggle compact secondary${pendingOnly === pending ? " active" : ""}`} onClick={() => { setPendingOnly(pending); setOffset(0); }}>{label}</button>)}
          </div>
        )}
        {!(selectedId ? detail.deleted : list.deleted) ? <button
          type="button"
          className="drawer-toggle compact secondary coordination-toolbar-icon"
          title="Refresh Coordination" aria-label="Refresh Coordination"
          disabled={selectedId ? detail.loading : list.loading}
          aria-busy={selectedId ? detail.loading : list.loading}
          onClick={() => { (selectedId ? detail.refresh : list.refresh)(); identities.refresh(); }}
        >
          <ButtonContent busy={selectedId ? detail.loading : list.loading} busyLabel="Refreshing Coordination"><span aria-hidden="true">↻</span></ButtonContent>
        </button> : null}
      </div>
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
                  <span className="coordination-session-identity">
                    {identityKind(item.initiator)}
                    <span className="visually-hidden">{identityName(item.initiator)} · </span>
                    <span className="coordination-session-title" title={`${identityName(item.initiator)} · ${identityTitle(item.initiator)}`}>{identityTitle(item.initiator)}</span>
                    {responseLabel(item) ? item.state === "open" ? (
                      <span className="coordination-list-status" role="img" aria-label="Reply Recorded" title="Reply Recorded"><ComposerIcon name="submit" /></span>
                    ) : <span className="coordination-list-status">{responseLabel(item)}</span> : null}
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
    </div>
  );
}
