import { useImperativeHandle, useLayoutEffect, type Ref } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import { useSessionGlossary } from "../../glossary/use-session-glossary.js";
import type { GlossaryAnnotationMatcher } from "../../glossary/glossary-annotation-projection.js";
import { SessionContextPane, type SessionContextPaneProps } from "../shell/session-context-pane.js";
import { useSessionContextPaneFeature, type SessionContextPaneFeatureInput } from "./use-session-context-pane-feature.js";
import { useActiveSessionLiveRun } from "./session-window-live-run-hooks.js";
import { useSessionTelemetry } from "./session-window-telemetry-hooks.js";

export type SessionContextFeatureHandle = { activateGlossaryEntry: (term: string) => void };

export function SessionContextFeature(props: Pick<SessionContextPaneFeatureInput,
  "activeRunSessionId" | "character" | "auditLogEntries" | "availableReasoningEfforts"
  | "renderedIsRunning" | "onShowContextRail"
> & {
  api: WithMateWindowApi | null;
  selectedSession: Session;
  displayedSession: Session;
  ref?: Ref<SessionContextFeatureHandle>;
  navigator: Pick<SessionContextPaneProps, "messageNavigatorEntries" | "messageNavigatorSessionId" | "onJumpToMessage" | "onMessageNavigatorActiveChange">;
  onAnnotationMatcherChange: (matcher: GlossaryAnnotationMatcher | undefined) => void;
  visible: boolean;
}) {
  const { selectedSessionLiveRun } = useActiveSessionLiveRun(props.api, props.selectedSession, props.activeRunSessionId, props.visible);
  const telemetry = useSessionTelemetry(props.visible ? props.api : null, props.displayedSession.provider, props.activeRunSessionId);
  const glossary = useSessionGlossary({
    api: props.api,
    selectedSession: {
      id: props.selectedSession.id,
      revision: props.selectedSession.updatedAt,
      workspaceLabel: props.selectedSession.workspaceLabel,
      branch: props.selectedSession.branch,
    },
    onActivatePane: () => context.showGlossary(),
  });
  const context = useSessionContextPaneFeature({
    ...props,
    ...telemetry,
    liveRun: selectedSessionLiveRun,
    glossaryPaneProps: glossary.paneProps,
  });
  useImperativeHandle(props.ref, () => ({ activateGlossaryEntry: glossary.actions.onActivateGlossaryEntry }), [glossary.actions.onActivateGlossaryEntry]);
  useLayoutEffect(() => {
    props.onAnnotationMatcherChange(glossary.annotationMatcher);
  }, [glossary.annotationMatcher, props.onAnnotationMatcherChange]);
  return props.visible ? <SessionContextPane {...context.rightPaneProps} {...props.navigator} /> : null;
}
