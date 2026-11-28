import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

import { getWithMateApi } from "../app/renderer-withmate-api.js";

/** 描画する子要素と、障害時の画面およびログに使うウィンドウ情報。 */
type WindowErrorBoundaryProps = {
  children: ReactNode;
  pageClassName: string;
  windowLabel: string;
};

/** 代替画面に出すエラーと、再試行時に子要素を作り直すためのキーを保持する。 */
type WindowErrorBoundaryState = {
  errorMessage: string | null;
  resetNonce: number;
};

/** 子要素の描画エラーをウィンドウ単位で受け止め、再描画とウィンドウ再読み込みを選べるようにする。 */
export class WindowErrorBoundary extends Component<
  WindowErrorBoundaryProps,
  WindowErrorBoundaryState
> {
  state: WindowErrorBoundaryState = {
    errorMessage: null,
    resetNonce: 0,
  };

  /** 描画エラーのメッセージを代替画面に渡し、空の場合は共通の案内を使う。 */
  static getDerivedStateFromError(
    error: Error,
  ): Pick<WindowErrorBoundaryState, "errorMessage"> {
    return {
      errorMessage: error.message || "Could not render this window.",
    };
  }

  /** ウィンドウ名とコンポーネントスタックを記録し、ログ送信で例外が出ても代替画面に波及させない。 */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[${this.props.windowLabel}] render failed`,
      error,
      errorInfo,
    );
    try {
      getWithMateApi()?.reportRendererLog({
        level: "error",
        kind: "renderer.render-failed",
        message: `${this.props.windowLabel} render failed`,
        url: window.location.href,
        data: {
          boundary: "window",
          windowLabel: this.props.windowLabel,
          componentStack: errorInfo.componentStack,
        },
        error: {
          name: error.name,
          message: error.message || "render failed",
          stack: error.stack,
        },
      });
    } catch (reportError) {
      console.error(
        `[${this.props.windowLabel}] render failure logging failed`,
        reportError,
      );
    }
  }

  /** エラー表示を解除し、子要素を新しいキーでマウントし直す。 */
  private handleRetry = () => {
    this.setState((current) => ({
      errorMessage: null,
      resetNonce: current.resetNonce + 1,
    }));
  };

  /** 再読み込み要求をログに通知してから、現在のウィンドウを再読み込みする。 */
  private handleReload = () => {
    getWithMateApi()?.reportRendererLog({
      level: "warn",
      kind: "renderer.reload-requested",
      message: `${this.props.windowLabel} reload requested from error boundary`,
      url: window.location.href,
      data: { boundary: "window", windowLabel: this.props.windowLabel },
    });
    window.location.reload();
  };

  /** 描画失敗中は復旧操作のある代替画面を、それ以外は現在のキーで子要素を描画する。 */
  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div
          className={`page-shell ${this.props.pageClassName} window-error-page`.trim()}
        >
          <section
            className="panel empty-session-card rise-1 window-error-card"
            role="alert"
          >
            <span className="window-error-badge">Display Error</span>
            <h2>Could not display {this.props.windowLabel}</h2>
            <p>{this.state.errorMessage}</p>
            <div className="window-error-actions">
              <button type="button" onClick={this.handleRetry}>
                Retry
              </button>
              <button
                className="drawer-toggle secondary"
                type="button"
                onClick={this.handleReload}
              >
                Reload
              </button>
            </div>
          </section>
        </div>
      );
    }

    return (
      <Fragment key={this.state.resetNonce}>{this.props.children}</Fragment>
    );
  }
}
