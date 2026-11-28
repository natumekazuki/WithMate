import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  SessionFilePin,
  SessionFileRootResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** Session のファイルピンを読み取り、追加と解除を保存する Window API。 */
export type FilePinsApi = Pick<
  WithMateWindowApi,
  "listSessionFilePins" | "pinSessionFile" | "unpinSessionFile"
>;
const EMPTY_PINS: SessionFilePin[] = [];

/** 所有する Session とルート構成に対するピン一覧と、読み取り・更新の状態。 */
type PinsState = {
  ownerKey: string;
  pins: SessionFilePin[];
  status: "loading" | "ready" | "error";
  pending: boolean;
  error: string;
};

/** ピンの同一性はルートの種類とパス、ルート内の相対パスで比較する。 */
function samePin(left: SessionFilePin, right: SessionFilePin): boolean {
  return (
    left.rootKind === right.rootKind &&
    left.rootPath === right.rootPath &&
    left.relativePath === right.relativePath
  );
}

/** 所有元を固定してピンの読み取りを直列化し、準備済みの現在の一覧だけを変更対象にする。 */
export function useSessionFilePins(input: {
  api: FilePinsApi | null;
  sessionId: string | null;
  enabled: boolean;
  active?: boolean;
  refreshRevision?: number;
  rootsRevision: string;
}) {
  const {
    api,
    sessionId,
    enabled,
    rootsRevision,
    active = true,
    refreshRevision = 0,
  } = input;
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);
  const refreshingRef = useRef<string | null>(null);
  const queuedRef = useRef(false);
  const ownerKey = JSON.stringify([sessionId, rootsRevision, enabled]);
  const ownerRef = useRef(ownerKey);
  const sequenceRef = useRef(0);
  const mutationRef = useRef(false);
  const [state, setState] = useState<PinsState>({
    ownerKey,
    pins: [],
    status: "loading",
    pending: false,
    error: "",
  });
  useLayoutEffect(() => {
    ownerRef.current = ownerKey;
    mutationRef.current = false;
    refreshingRef.current = null;
    queuedRef.current = false;
    return () => {
      ownerRef.current = "";
    };
  }, [ownerKey]);

  const refresh = useCallback(async () => {
    if (
      !api ||
      !sessionId ||
      !enabled ||
      !activeRef.current ||
      mutationRef.current
    )
      return;
    if (refreshingRef.current === ownerKey) {
      queuedRef.current = true;
      return;
    }
    refreshingRef.current = ownerKey;
    do {
      queuedRef.current = false;
      const sequence = ++sequenceRef.current;
      setState((current) => ({
        ownerKey,
        pins: current.ownerKey === ownerKey ? current.pins : [],
        status: "loading",
        pending: false,
        error: "",
      }));
      try {
        const pins = await api.listSessionFilePins(sessionId);
        if (ownerRef.current !== ownerKey || sequenceRef.current !== sequence)
          return;
        setState({
          ownerKey,
          pins,
          status: "ready",
          pending: false,
          error: "",
        });
      } catch (error) {
        if (ownerRef.current !== ownerKey || sequenceRef.current !== sequence)
          return;
        setState((current) => ({
          ...current,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Pins could not be loaded.",
        }));
      }
    } while (
      ownerRef.current === ownerKey &&
      queuedRef.current &&
      activeRef.current
    );
    if (ownerRef.current === ownerKey) {
      refreshingRef.current = null;
      queuedRef.current = false;
    }
  }, [api, enabled, ownerKey, sessionId]);

  useEffect(() => {
    if (active) void refresh();
  }, [refresh, active, refreshRevision]);

  /** 追加・解除を重複実行せず、現在の一覧に結び付く保存結果だけを反映する。失敗時は再取得まで変更を止める。 */
  const changePin = async (
    target: SessionFileRootResourceRequest | SessionFilePin,
    remove: boolean,
  ): Promise<boolean> => {
    if (
      !api ||
      !sessionId ||
      !enabled ||
      mutationRef.current ||
      state.ownerKey !== ownerKey ||
      state.status !== "ready"
    )
      return false;
    mutationRef.current = true;
    const sequence = ++sequenceRef.current;
    setState((current) => ({ ...current, pending: true, error: "" }));
    try {
      let saved: SessionFilePin | null = null;
      if (remove && "rootPath" in target) {
        await api.unpinSessionFile({
          sessionId,
          rootKind: target.rootKind,
          rootPath: target.rootPath,
          relativePath: target.relativePath,
        });
      } else if (!remove && "sessionId" in target) {
        saved = await api.pinSessionFile(target);
      } else {
        throw new Error("The pin target is invalid.");
      }
      if (ownerRef.current !== ownerKey || sequenceRef.current !== sequence)
        return false;
      const nextPin = saved;
      setState((current) => ({
        ...current,
        pins: nextPin
          ? [...current.pins.filter((pin) => !samePin(pin, nextPin)), nextPin]
          : current.pins.filter(
              (pin) => !("rootPath" in target && samePin(pin, target)),
            ),
        pending: false,
      }));
      return true;
    } catch (error) {
      if (ownerRef.current === ownerKey && sequenceRef.current === sequence) {
        // ストレージの失敗で書き込み結果が不明になる場合がある。次の変更前に読み直す。
        setState((current) => ({
          ...current,
          pending: false,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "The pin could not be saved.",
        }));
      }
      return false;
    } finally {
      if (ownerRef.current === ownerKey && sequenceRef.current === sequence)
        mutationRef.current = false;
    }
  };

  const current =
    state.ownerKey === ownerKey
      ? state
      : {
          ownerKey,
          pins: EMPTY_PINS,
          status: "loading" as const,
          pending: false,
          error: "",
        };
  return {
    ...current,
    refresh,
    changePin,
    canChange: enabled && current.status === "ready" && !current.pending,
  };
}
