import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SENT_INSTRUCTION_BODY_BATCH_SIZE, type SentInstructionBody, type SentInstructionBodyKey, type SentInstructionCardRequest } from "../../../src-shared/session/session-execution-read.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

const bodyKey = (key: SentInstructionBodyKey | SentInstructionBody) => {
  const kind = "kind" in key ? key.kind : "receiptId" in key ? "receipt" : "steer";
  return `${kind}:${key.sequence}`;
};
export type SentBodyReader = (key: SentInstructionBodyKey, signal: AbortSignal) => Promise<SentInstructionBody | undefined>;

/** 同じタイミングで表示範囲に入ったカードをまとめて読み取る。本文のキャッシュはカードの外には持たない。 */
export function createSentBodyReader(owner: string, scope: SentInstructionCardRequest): SentBodyReader {
  type Pending = {
    key: SentInstructionBodyKey;
    signal: AbortSignal;
    resolve: (body: SentInstructionBody | undefined) => void;
    reject: (error: unknown) => void;
  };
  const pending: Pending[] = [];
  let running = false;
  const drain = async () => {
    while (pending.length) {
      const batch = pending.splice(0, SENT_INSTRUCTION_BODY_BATCH_SIZE).filter((request) => {
        if (!request.signal.aborted) return true;
        request.resolve(undefined);
        return false;
      });
      if (!batch.length) continue;
      try {
        const api = getWithMateApi();
        if (!api?.readSessionExecution) throw new Error("Saved outgoing messages are unavailable.");
        const answer = await api.readSessionExecution(owner, "read_sent_instruction_bodies", {
          target: scope.target, messageSeqs: scope.messageSeqs, liveTurnIds: scope.liveTurnIds,
          cards: [...new Map(batch.map(({ key }) => [bodyKey(key), key])).values()],
        });
        if (!answer.ok) throw new Error(answer.message);
        const bodies = new Map(answer.items.map((body) => [bodyKey(body), body]));
        for (const request of batch) {
          if (request.signal.aborted) request.resolve(undefined);
          else {
            const body = bodies.get(bodyKey(request.key));
            if (body) request.resolve(body);
            else request.reject(new Error("The saved outgoing message is no longer available."));
          }
        }
      } catch (error) {
        for (const request of batch) request.signal.aborted ? request.resolve(undefined) : request.reject(error);
      }
    }
    running = false;
  };
  return (key, signal) => new Promise((resolve, reject) => {
    pending.push({ key, signal, resolve, reject });
    if (!running) {
      running = true;
      queueMicrotask(() => void drain());
    }
  });
}

export type SentBodyRead = { key: SentInstructionBodyKey; read: SentBodyReader; revision: number; enabled: boolean };

const viewports = new WeakMap<Element | Document, {
  observer: IntersectionObserver;
  cards: Map<Element, (near: boolean) => void>;
}>();
const OVERSCAN_PX = 160;

function observeSentBody(node: HTMLElement, changed: (near: boolean) => void) {
  const root = node.closest(".session-message-list");
  const viewport = root ?? node.ownerDocument;
  let observations = viewports.get(viewport);
  if (!observations) {
    const cards = new Map<Element, (near: boolean) => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) cards.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: `-1px 0px ${OVERSCAN_PX}px 0px` });
    observations = { observer, cards };
    viewports.set(viewport, observations);
  }
  const { observer, cards } = observations;
  cards.set(node, changed);
  observer.observe(node);
  return () => {
    observer.unobserve(node);
    cards.delete(node);
    if (!cards.size) {
      observer.disconnect();
      viewports.delete(viewport);
    }
  };
}

/** 本文がなくても外枠から移動できる。本文はスクロール表示範囲に近いものだけを展開する。 */
export function SentInstructionBodyBoundary({ source, requested = false, render }: {
  source: SentBodyRead; requested?: boolean; render: (body: SentInstructionBody) => ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const height = useRef<number>(undefined);
  const [near, setNear] = useState(false);
  const [focused, setFocused] = useState(false);
  const loaded = useRef<{ body: SentInstructionBody; revision: number; read: SentBodyReader; key: SentInstructionBodyKey }>(undefined);
  const [, redraw] = useState(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const key = useMemo(() => source.key, [JSON.stringify(source.key)]);
  const active = source.enabled && (near || focused || requested);
  useEffect(() => {
    const node = element.current;
    if (!node || !source.enabled) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const stop = observeSentBody(node, setNear);
    return () => { stop(); setNear(false); };
  }, [source.enabled]);
  useLayoutEffect(() => {
    const node = element.current;
    if (active || !loaded.current || !node) return;
    const release = () => {
      const selection = node.ownerDocument.getSelection();
      if (source.enabled && selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(node)) return;
      node.ownerDocument.removeEventListener("selectionchange", release);
      height.current = node.getBoundingClientRect().height;
      loaded.current = undefined;
      redraw((value) => value + 1);
    };
    // 選択範囲が表示範囲の外に延びていても、コピーや引用はその範囲に対して行える。
    node.ownerDocument.addEventListener("selectionchange", release);
    release();
    return () => node.ownerDocument.removeEventListener("selectionchange", release);
  }, [active, source.enabled]);
  useEffect(() => {
    if (!active) { setError(""); return; }
    if (loaded.current?.revision === source.revision && loaded.current.read === source.read && loaded.current.key === key) return;
    const request = new AbortController();
    setError("");
    void source.read(key, request.signal).then((result) => {
      if (request.signal.aborted || !result) return;
      // 返信元への移動では、監視処理が範囲外への移動を通知する前に表示範囲が移ることがある。
      // 新しい位置より上で読み取り中だった本文は、そこで展開してはいけない。
      const node = element.current;
      const root = node?.closest(".session-message-list")?.getBoundingClientRect();
      const bounds = node?.getBoundingClientRect();
      if (!focused && !requested && root && root.height > 0 && bounds
        && (bounds.bottom <= root.top || bounds.top > root.bottom + OVERSCAN_PX)) {
        setNear(false);
        return;
      }
      loaded.current = { body: result, revision: source.revision, read: source.read, key };
      redraw((value) => value + 1);
    }, (failure) => {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not read the outgoing message.");
    });
    return () => request.abort();
  }, [active, focused, key, requested, source.read, source.revision, retry]);
  const body = loaded.current?.key === key ? loaded.current.body : undefined;
  return <div ref={element} className="sent-instruction-body" style={{ minHeight: body ? undefined : height.current || 24 }}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {body ? render(body) : active && !error ? <LoadingIndicator inline label="Loading outgoing message" /> : null}
    {error ? <p role="alert">{error} <button type="button" className="drawer-toggle compact secondary" onClick={() => setRetry((value) => value + 1)}>Retry Sent Message</button></p> : null}
  </div>;
}
