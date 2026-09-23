import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

import { getWithMateApi } from "../app/renderer-withmate-api.js";

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
      errorMessage: error.message || "Could not render this window.",
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[${this.props.windowLabel}] render failed`, error, errorInfo);
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
      console.error(`[${this.props.windowLabel}] render failure logging failed`, reportError);
    }
  }

  private handleRetry = () => {
    this.setState((current) => ({
      errorMessage: null,
      resetNonce: current.resetNonce + 1,
    }));
  };

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

  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div className={`page-shell ${this.props.pageClassName} window-error-page`.trim()}>
          <section className="panel empty-session-card rise-1 window-error-card" role="alert">
            <span className="window-error-badge">Display Error</span>
            <h2>Could not display {this.props.windowLabel}</h2>
            <p>{this.state.errorMessage}</p>
            <div className="window-error-actions">
              <button type="button" onClick={this.handleRetry}>
                Retry
              </button>
              <button className="drawer-toggle secondary" type="button" onClick={this.handleReload}>
                Reload
              </button>
            </div>
          </section>
        </div>
      );
    }

    return <Fragment key={this.state.resetNonce}>{this.props.children}</Fragment>;
  }
}
