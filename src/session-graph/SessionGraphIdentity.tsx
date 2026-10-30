import type { CSSProperties } from "react";
import type { SessionGraphIdentity } from "../../src-shared/session-graph/session-graph-contract.js";
import { CharacterAvatar } from "../ui/ui-utils.js";

export function SessionGraphIdentityView({ identity, actorRole, tooltipDetails, focusable = true }: {
  identity: SessionGraphIdentity;
  actorRole?: string;
  tooltipDetails?: string;
  focusable?: boolean;
}) {
  const name = identity.character?.name ?? identity.sessionTitle;
  const role = identity.role === "main" ? "Main" : "Auxiliary";
  const text = `${name} · ${role} · ${identity.sessionTitle}${actorRole ? ` · Role: ${actorRole}` : ""}`;
  return <span className="session-graph-identity" role="img" tabIndex={focusable ? 0 : undefined} aria-label={text}
    style={{ "--session-graph-character-main": identity.character?.theme?.main,
      "--session-graph-character-sub": identity.character?.theme?.sub } as CSSProperties}>
    <CharacterAvatar key={`${identity.sessionId}:${identity.character?.id ?? ""}:${identity.character?.icon ?? ""}`}
      character={{ name, iconPath: identity.character?.icon ?? "" }} size="small" />
    <span className="session-graph-actor-name">{name}</span>
    <span className="session-graph-identity-tooltip" role="tooltip">
      {text}{tooltipDetails ? <><br />{tooltipDetails}</> : null}
    </span>
  </span>;
}
