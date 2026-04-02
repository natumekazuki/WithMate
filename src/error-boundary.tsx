import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type WindowErrorBoundaryProps = {
  children: ReactNode;
  pageClassName: string;
  windowLabel: string;
};

type WindowErrorBoundaryState = {
  errorMessage: string | null;
  resetNonce: number;
};

export class WindowErrorBoundary extends Component<WindowErrorBoundaryProps, WindowErrorBoundaryState> {
  state: WindowErrorBoundaryState = {
    errorMessage: null,
    resetNonce: 0,
  };

  static getDerivedStateFromError(error: Error): Pick<WindowErrorBoundaryState, "errorMessage"> {
    return {
      errorMessage: error.message || "描画に失敗したよ。",
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[${this.props.windowLabel}] render failed`, error, errorInfo);
  }

  private handleRetry = () => {
    this.setState((current) => ({
      errorMessage: null,
      resetNonce: current.resetNonce + 1,
    }));
  };

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div className={`page-shell ${this.props.pageClassName} window-error-page`.trim()}>
          <section className="panel empty-session-card rise-1 window-error-card" role="alert">
            <span className="window-error-badge">描画エラー</span>
            <h2>{this.props.windowLabel} を表示できませんでした</h2>
            <p>{this.state.errorMessage}</p>
            <div className="window-error-actions">
              <button type="button" onClick={this.handleRetry}>
                再試行
              </button>
              <button className="drawer-toggle secondary" type="button" onClick={this.handleReload}>
                再読み込み
              </button>
            </div>
          </section>
        </div>
      );
    }

    return <Fragment key={this.state.resetNonce}>{this.props.children}</Fragment>;
  }
}
