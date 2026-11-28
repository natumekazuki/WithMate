import type { CharacterVisual } from "../../../src-shared/character/character-state.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";

/** 実行失敗を警告として表示し、理由があればその内容も提示する。 */
export function SessionRunFailure({ reason }: { reason: string }) {
  return (
    <div className="session-run-failure" role="alert">
      <strong>Failed</strong>
      {reason ? <p>{reason}</p> : null}
    </div>
  );
}

/** 本文のない実行失敗も、発話者のアバター付きの応答行として表示する。 */
export function SessionRunFailureRow({
  reason,
  character,
}: {
  reason: string;
  character: CharacterVisual;
}) {
  return (
    <article className="message-row assistant">
      <div className="message-avatar-stack">
        <CharacterAvatar
          character={character}
          size="small"
          className="message-avatar"
        />
      </div>
      <div className="message-card assistant">
        <div className="message-card-content">
          <SessionRunFailure reason={reason} />
        </div>
      </div>
    </article>
  );
}
