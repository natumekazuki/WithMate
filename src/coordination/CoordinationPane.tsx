import { useEffect, useId, useRef, useState } from "react";
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
function responseLabel(item: CoordinationSummary | CoordinationRecord): string {
  if (item.state === "open" && item.respondent.kind === "user") {
    return item.answerRevision ? "Answer Saved" : "Needs Answer";
  }
  return stateLabel(item.state);
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
  const [detailsOpenId, setDetailsOpenId] = useState<string | null>(null);
  const detailsId = useId();
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);
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
      setDrafts((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? draft),
          pendingRequest: undefined,
          feedback: receipt
            ? `Saved · Delivery ${receiptStateLabel(receipt.state)}`
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
  const renderAnswer = (answer: CoordinationAnswer) => (
    <article key={answer.id}>
      <div className="coordination-detail-heading">
        <strong>{answer.actor.kind === "user" ? "Your Answer" : identityTitle(answer.actor)}</strong>
        <span>Revision {answer.revision}</span>
      </div>
      <MessageRichText text={answer.body} embeddedMedia="text" />
      {answer.selectedChoices.length ? <p>{answer.selectedChoices.join(" · ")}</p> : null}
      <CoordinationAnswerDelivery
        ownerSessionId={sessionId}
        target={initiatorTarget}
        receiptId={answer.receiptId}
      />
      {answer.consumedByOperationId ? <p className="coordination-parties">Consumed By Originating Session</p> : null}
    </article>
  );
  const renderDetail = (item: CoordinationRecord) => (
    <>
      <div className="coordination-origin" onKeyDown={(event) => {
        if (event.key !== "Escape" || detailsOpenId !== item.id) return;
        event.preventDefault();
        event.stopPropagation();
        setDetailsOpenId(null);
        detailsTriggerRef.current?.focus();
      }}>
        <div className="coordination-origin-heading">
          <button type="button" className="coordination-detail-origin" disabled={!initiatorTarget} aria-label={`Open Origin: ${identityTitle(item.initiator)} (${item.initiator.kind === "main" ? "Main" : "Auxiliary"})`} onClick={() => void openOrigin()}>
            {identityAvatar(item.initiator)}
            <span>
              <strong className="coordination-origin-name">{identityRead(item.initiator)?.identity?.character.name ?? "Session"}{identityKind(item.initiator)}</strong>
              <span className="coordination-session-title" title={identityTitle(item.initiator)}>{identityTitle(item.initiator)}</span>
            </span>
          </button>
          <button ref={detailsTriggerRef} type="button" className="artifact-toggle artifact-toggle-icon coordination-info-toggle"
            aria-label="Consultation Details" title="Consultation Details"
            aria-expanded={detailsOpenId === item.id} aria-controls={detailsId}
            onClick={() => setDetailsOpenId(detailsOpenId === item.id ? null : item.id)}>
            <span aria-hidden="true">i</span>
          </button>
        </div>
        <dl id={detailsId} className="coordination-record-metadata" hidden={detailsOpenId !== item.id}>
          <dt>Kind</dt><dd>{coordinationKindLabel(item.kind)}</dd>
          <dt>State</dt><dd>{stateLabel(item.state)}</dd>
          <dt>Updated</dt><dd><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("en-US")}</time></dd>
        </dl>
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
          {renderAnswer(item.answers[item.answers.length - 1])}
          {item.answers.length > 1 ? <details className="artifact-fold coordination-previous-answers">
            <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Previous Answers ({item.answers.length - 1})</strong></span></summary>
            {item.answers.slice(0, -1).map(renderAnswer)}
          </details> : null}
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
          <fieldset disabled={buttonsDisabled} aria-label={item.answerRevision ? "Change Your Answer" : "Your Answer"}>
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
              rows={3}
              value={draft.body}
              onChange={(event) => updateDraft({ body: event.target.value })}
            />
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
      <details className="artifact-fold coordination-actions">
        <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>Resolve Or Withdraw</strong></span></summary>
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
      {item.history.length ? <details className="artifact-fold">
        <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><strong>History</strong></span></summary>
        <ol className="coordination-history">
          {item.history.map((entry) => (
            <li key={entry.operationId}>
              <strong>{({ create: "Created", deliver: "Sent", escalate: "Escalated", answer: "Answered", resolve: "Resolved", consume: "Answer Used", withdraw: "Withdrawn", correct: "Corrected" } as Record<string, string>)[entry.operation] ?? entry.operation}</strong> ·{" "}
              {new Date(entry.at).toLocaleString("en-US")}
              {entry.body ? <p>{entry.body}</p> : null}
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
                    <span className="coordination-session-title" title={`${identityRead(item.initiator)?.identity?.character.name ?? "Session"} · ${identityTitle(item.initiator)}`}>{identityRead(item.initiator)?.identity?.character.name ?? "Session"} · {identityTitle(item.initiator)}</span>
                  </span>
                  <span className="coordination-list-status">{responseLabel(item)}</span>
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
