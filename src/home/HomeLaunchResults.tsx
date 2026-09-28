import type { HomeLaunchResult } from "./home-launch-actions.js";

export function HomeLaunchResults({ results, onDismiss }: {
  results: readonly HomeLaunchResult[];
  onDismiss: (result: HomeLaunchResult) => void;
}) {
  return results.map((result, index) => (
    <div className="home-session-list-feedback" key={index}>
      <p className="settings-feedback" role="status" aria-live="polite">
        <strong>{result.title}</strong>{": "}{result.message}
      </p>
      <button
        className="launch-toggle home-session-retry-button"
        type="button"
        aria-label={`Dismiss result for ${result.title}`}
        onClick={() => onDismiss(result)}
      >
        Dismiss
      </button>
    </div>
  ));
}
