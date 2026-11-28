import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getWithMateApi,
  isDesktopRuntime,
} from "../app/renderer-withmate-api.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import { PreviewWheelZoomStepContext } from "../settings/preview-zoom-settings-context.js";
import { LoadError } from "../ui/load-error.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import {
  SessionDiffPreview,
  SessionFilePreview,
} from "./SessionFilePreview.js";
import { projectFileRootDiffAvailability } from "./file-preview-utils.js";
import type {
  FileRootGitHistoryComparisonSelector,
  FileRootGitHistoryDiffRequest,
  FileRootGitDiffScope,
  SessionFilePreviewWindowPayload,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  areSessionFileResourcesEqual,
  getSessionFileResourceDisplayPath,
  isFileRootGitHistoryComparisonDiffRequest,
  isSessionFileGitCommitResource,
  isSessionFileRootResource,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

/** ファイルを開いたウィンドウ内で表示する作業差分の範囲、パッチ、描画世代。 */
type DiffState = {
  scope: FileRootGitDiffScope;
  patch: string;
  revision: number;
};

/** トークンに対応する表示内容の取得中・取得完了・利用不可・エラーを区別する。 */
type PayloadLoadState = "loading" | "ready" | "unavailable" | "error";

/** URL のプレビュートークンを取り出し、未指定は空文字列として扱う。 */
function getToken(): string {
  return new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
}

/** 履歴比較を選択したときの参照を、短縮コミット ID または人が読める名前で表す。 */
function formatHistoryDiffSelector(
  selector: FileRootGitHistoryComparisonSelector,
): string {
  if (selector.kind === "head") {
    return "HEAD";
  }
  if (selector.kind === "commit") {
    return `Commit ${selector.objectId.slice(0, 7)}`;
  }
  return selector.name;
}

/** ファイルの履歴差分ならパス、全体の差分なら対象コミットまたは比較元と比較先をタイトルにする。 */
function formatHistoryDiffTitle(
  request: FileRootGitHistoryDiffRequest,
): string {
  if (isFileRootGitHistoryComparisonDiffRequest(request)) {
    return (
      request.relativePath ??
      `${formatHistoryDiffSelector(request.comparison.base)} → ${formatHistoryDiffSelector(request.comparison.target)}`
    );
  }
  return request.relativePath ?? `Commit ${request.commitId.slice(0, 7)}`;
}

/** 固定された履歴比較の方式とコミットを示し、単一コミットの差分には比較の補足を付けない。 */
function formatHistoryDiffContext(
  request: FileRootGitHistoryDiffRequest,
): string | undefined {
  if (!isFileRootGitHistoryComparisonDiffRequest(request)) {
    return undefined;
  }
  const mergeBase = request.comparison.mergeBaseCommitId
    ? ` · Merge Base ${request.comparison.mergeBaseCommitId.slice(0, 7)}`
    : "";
  return `${request.comparison.mode === "branch" ? "Branch Changes" : "Direct Comparison"} · ${request.comparison.baseCommitId.slice(0, 7)} → ${request.comparison.targetCommitId.slice(0, 7)}${mergeBase}`;
}

/** ナビゲーション通知が同じリソースまたは同じ履歴差分の要求を指すかを判定する。 */
function areFilePreviewPayloadsEqual(
  left: SessionFilePreviewWindowPayload,
  right: SessionFilePreviewWindowPayload,
): boolean {
  if ("historyDiff" in left || "historyDiff" in right) {
    return (
      "historyDiff" in left &&
      "historyDiff" in right &&
      JSON.stringify(left.historyDiff.request) ===
        JSON.stringify(right.historyDiff.request)
    );
  }
  return areSessionFileResourcesEqual(left.resource, right.resource);
}

/** 専用ウィンドウの本文を取得するまで、操作できる内容の代わりに進捗と仮の外枠を表示する。 */
function FilePreviewWindowLoading({ label }: { label: string }) {
  return (
    <main className="file-preview-window-page" aria-busy="true">
      <section
        className="session-file-preview file-preview-window-loading"
        role="status"
        aria-live="polite"
        aria-label={label}
      >
        <header className="session-file-preview-header" aria-hidden="true">
          <span className="file-preview-loading-title" />
          <span className="file-preview-loading-actions" />
        </header>
        <div className="file-preview-loading-content" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}

/** トークンで指定された対象を別ウィンドウに表示し、同じ対象の本文と差分の切り替えを扱う。 */
export default function FilePreviewApp() {
  const api = getWithMateApi();
  const [payload, setPayload] =
    useState<SessionFilePreviewWindowPayload | null>(null);
  const [payloadLoadState, setPayloadLoadState] = useState<PayloadLoadState>(
    () => (api && getToken() ? "loading" : "unavailable"),
  );
  const [payloadLoadMessage, setPayloadLoadMessage] = useState("");
  const [diffScopes, setDiffScopes] = useState<FileRootGitDiffScope[]>([]);
  const [diffAvailabilityMessage, setDiffAvailabilityMessage] = useState("");
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [diffLoadingScope, setDiffLoadingScope] =
    useState<FileRootGitDiffScope | null>(null);
  const [navigationMessage, setNavigationMessage] = useState("");
  const diffRequestRevisionRef = useRef(0);
  const [wheelZoomStep, setWheelZoomStep] = useState<number | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [settingsReadRevision, setSettingsReadRevision] = useState(0);

  useEffect(
    () =>
      startAppSettingsSubscription({
        api,
        loadInitial: true,
        /** 最新のプレビュー用ズーム刻みを取り込み、設定取得の失敗を解除する。 */
        applyAppSettings: (settings) => {
          setWheelZoomStep(settings.previewWheelZoomStep);
          setSettingsError("");
        },
        /** 初回設定の取得失敗を、ファイル本文の取得失敗とは別の再試行対象として記録する。 */
        onInitialLoadError: (error) => {
          setSettingsError(
            error instanceof Error
              ? error.message
              : "Could not load preview settings.",
          );
        },
      }),
    [api, settingsReadRevision],
  );

  useEffect(() => {
    let active = true;
    const token = getToken();
    if (!api || !token) {
      setPayload(null);
      setPayloadLoadMessage("");
      setPayloadLoadState("unavailable");
      return () => {
        active = false;
      };
    }
    setPayloadLoadMessage("");
    setPayloadLoadState("loading");
    void api
      .getSessionFilePreviewWindowPayload(token)
      .then((nextPayload) => {
        if (active) {
          setPayload(nextPayload);
          setPayloadLoadState("ready");
        }
      })
      .catch((error) => {
        if (active) {
          setPayloadLoadState("error");
          setPayloadLoadMessage(
            error instanceof Error
              ? error.message
              : "File preview could not be loaded.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.subscribeSessionFilePreviewNavigation((nextPayload) => {
      setPayload((current) =>
        current && areFilePreviewPayloadsEqual(current, nextPayload)
          ? nextPayload
          : current,
      );
    });
  }, [api]);

  useEffect(() => {
    if (payload) {
      document.title = payload.windowTitle;
    }
  }, [payload]);

  useEffect(() => {
    let active = true;
    setDiffAvailabilityMessage("");
    if (
      !api ||
      !payload ||
      "historyDiff" in payload ||
      !isSessionFileRootResource(payload.resource)
    ) {
      setDiffScopes([]);
      return () => {
        active = false;
      };
    }
    const resource = payload.resource;
    void api
      .listFileRootChanges({
        sessionId: resource.sessionId,
        rootId: resource.rootId,
      })
      .then((result) => {
        if (active) {
          const availability = projectFileRootDiffAvailability(
            result,
            resource.relativePath,
          );
          setDiffScopes(availability.scopes);
          setDiffAvailabilityMessage(availability.message);
        }
      })
      .catch((error) => {
        if (active) {
          setDiffScopes([]);
          setDiffAvailabilityMessage(
            error instanceof Error && error.message
              ? error.message
              : "Git diff availability could not be loaded.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [api, payload]);

  const loadDiff = useCallback(
    async (scope: FileRootGitDiffScope): Promise<string | null> => {
      if (
        !api ||
        !payload ||
        "historyDiff" in payload ||
        !isSessionFileRootResource(payload.resource)
      ) {
        return "Git diff is not available for this file.";
      }
      const revision = diffRequestRevisionRef.current + 1;
      diffRequestRevisionRef.current = revision;
      setDiffLoadingScope(scope);
      try {
        const result = await api.getFileRootDiff({
          ...payload.resource,
          scope,
        });
        if (diffRequestRevisionRef.current !== revision) {
          return null;
        }
        if (result.status !== "ok") {
          return result.message;
        }
        setDiffState((current) => ({
          scope,
          patch: result.patch,
          revision: (current?.revision ?? 0) + 1,
        }));
        return null;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : "Git diff could not be loaded.";
      } finally {
        if (diffRequestRevisionRef.current === revision) {
          setDiffLoadingScope(null);
        }
      }
    },
    [api, payload],
  );

  const showPreview = useCallback(() => {
    diffRequestRevisionRef.current += 1;
    setDiffLoadingScope(null);
    setDiffState(null);
    setNavigationMessage("");
    setPayload((current) =>
      current && !("historyDiff" in current) && current.view?.kind === "diff"
        ? { ...current, view: { kind: "preview" } }
        : current,
    );
  }, []);

  useEffect(() => {
    if (!payload || "historyDiff" in payload) {
      setDiffState(null);
      setDiffLoadingScope(null);
      setNavigationMessage("");
      return;
    }
    const view = payload.view ?? { kind: "preview" as const };
    if (view.kind === "diff") {
      let active = true;
      setDiffState(null);
      setNavigationMessage("");
      void loadDiff(view.scope).then((message) => {
        if (active) {
          setNavigationMessage(message ?? "");
        }
      });
      return () => {
        active = false;
      };
    } else {
      showPreview();
    }
  }, [loadDiff, payload, showPreview]);

  const previewResource = useMemo(
    () =>
      !payload || "historyDiff" in payload
        ? null
        : isSessionFileGitCommitResource(payload.resource)
          ? payload.resource
          : {
              sessionId: payload.resource.sessionId,
              absolutePath: payload.displayPath,
            },
    [payload],
  );

  if (!isDesktopRuntime()) {
    return (
      <main className="file-preview-window-page">
        <p>File preview must be opened from the desktop app.</p>
      </main>
    );
  }
  if (payloadLoadState === "loading") {
    return <FilePreviewWindowLoading label="Loading file preview" />;
  }
  if (payloadLoadState === "error") {
    return (
      <main className="file-preview-window-page">
        <section className="panel empty-session-card" role="alert">
          <h2>File preview could not be loaded</h2>
          <p>
            {payloadLoadMessage ||
              "Try opening the file again from the originating Session."}
          </p>
        </section>
      </main>
    );
  }
  if (payloadLoadState === "unavailable" || !api || !payload) {
    return (
      <main className="file-preview-window-page">
        <section className="panel empty-session-card">
          <h2>File preview is unavailable</h2>
          <p>Open the file again from the originating Session.</p>
        </section>
      </main>
    );
  }
  if ("historyDiff" in payload) {
    return (
      <main className="file-preview-window-page">
        <SessionDiffPreview
          title={formatHistoryDiffTitle(payload.historyDiff.request)}
          contextLabel={formatHistoryDiffContext(payload.historyDiff.request)}
          previewRevision={1}
          patch={payload.historyDiff.patch}
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
        />
      </main>
    );
  }
  if (payload.view?.kind === "diff" && !diffState && !navigationMessage) {
    const loadingScope = payload.view.scope;
    return (
      <main className="file-preview-window-page">
        <SessionDiffPreview
          title={getSessionFileResourceDisplayPath(payload.resource)}
          previewRevision={0}
          patch=""
          loading
          backNavigation={{ label: "Back To Preview", onBack: showPreview }}
          onCopyText={(text) => void navigator.clipboard.writeText(text)}
          onOpenPreview={async () => {
            showPreview();
            return null;
          }}
          onReload={() => loadDiff(loadingScope)}
          reloadPending={diffLoadingScope !== null}
        />
      </main>
    );
  }

  return (
    <PreviewWheelZoomStepContext.Provider value={wheelZoomStep}>
      <main className="file-preview-window-page with-preview-settings">
        {settingsError ? (
          <LoadError
            className="file-preview-settings-feedback"
            message={settingsError}
            onRetry={() => {
              setSettingsError("");
              setSettingsReadRevision((current) => current + 1);
            }}
          />
        ) : wheelZoomStep === null ? (
          <LoadingIndicator
            className="file-preview-settings-feedback"
            label="Loading preview settings"
          />
        ) : null}
        {diffState ? (
          <SessionDiffPreview
            title={getSessionFileResourceDisplayPath(payload.resource)}
            previewRevision={diffState.revision}
            patch={diffState.patch}
            backNavigation={{ label: "Back To Preview", onBack: showPreview }}
            onCopyText={(text) => void navigator.clipboard.writeText(text)}
            onOpenPreview={async () => {
              showPreview();
              return null;
            }}
            onReload={() => loadDiff(diffState.scope)}
            reloadPending={diffLoadingScope !== null}
          />
        ) : (
          <SessionFilePreview
            api={api}
            request={previewResource!}
            onCopyText={(text) => void navigator.clipboard.writeText(text)}
            diffScopes={diffScopes}
            diffAvailabilityMessage={[
              diffAvailabilityMessage,
              navigationMessage,
            ]
              .filter(Boolean)
              .join(" ")}
            onOpenDiff={loadDiff}
            diffLoadingScope={diffLoadingScope}
          />
        )}
      </main>
    </PreviewWheelZoomStepContext.Provider>
  );
}
