import { memo, useMemo, useRef } from "react";

import { SessionMessageColumn, type SessionMessageColumnProps } from "./conversation/session-message-column.js";

type Callback = (...args: any[]) => any;

function useStableOptionalCallback<T extends Callback>(callback: T | undefined): T | undefined {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const hasCallback = callback !== undefined;

  return useMemo(
    () => hasCallback
      ? ((...args: Parameters<T>) => callbackRef.current?.(...args)) as T
      : undefined,
    [hasCallback],
  );
}

const MemoizedSessionMessageColumn = memo(SessionMessageColumn);

export function StableSessionMessageColumn(props: SessionMessageColumnProps) {
  const onMessageListScroll = useStableOptionalCallback(props.onMessageListScroll);
  const onJumpToBottom = useStableOptionalCallback(props.onJumpToBottom);
  const onToggleMessageCollapse = useStableOptionalCallback(props.onToggleMessageCollapse);
  const onToggleAllMessageCollapse = useStableOptionalCallback(props.onToggleAllMessageCollapse);
  const onToggleMessageBookmark = useStableOptionalCallback(props.onToggleMessageBookmark);
  const onToggleArtifact = useStableOptionalCallback(props.onToggleArtifact);
  const onLoadArtifactDetail = useStableOptionalCallback(props.onLoadArtifactDetail);
  const onOpenDiff = useStableOptionalCallback(props.onOpenDiff);
  const onResolveLiveApproval = useStableOptionalCallback(props.onResolveLiveApproval);
  const onResolveLiveElicitation = useStableOptionalCallback(props.onResolveLiveElicitation);
  const onOpenPath = useStableOptionalCallback(props.onOpenPath);
  const getChangedFilesEmptyText = useStableOptionalCallback(props.getChangedFilesEmptyText);
  const onCopyMessageText = useStableOptionalCallback(props.onCopyMessageText);
  const onQuoteMessageText = useStableOptionalCallback(props.onQuoteMessageText);
  const onActivateGlossaryEntry = useStableOptionalCallback(props.onActivateGlossaryEntry);

  return (
    <MemoizedSessionMessageColumn
      {...props}
      onMessageListScroll={onMessageListScroll!}
      onJumpToBottom={onJumpToBottom}
      onToggleMessageCollapse={onToggleMessageCollapse}
      onToggleAllMessageCollapse={onToggleAllMessageCollapse}
      onToggleMessageBookmark={onToggleMessageBookmark}
      onToggleArtifact={onToggleArtifact!}
      onLoadArtifactDetail={onLoadArtifactDetail}
      onOpenDiff={onOpenDiff!}
      onResolveLiveApproval={onResolveLiveApproval!}
      onResolveLiveElicitation={onResolveLiveElicitation!}
      onOpenPath={onOpenPath}
      getChangedFilesEmptyText={getChangedFilesEmptyText!}
      onCopyMessageText={onCopyMessageText}
      onQuoteMessageText={onQuoteMessageText}
      onActivateGlossaryEntry={onActivateGlossaryEntry}
    />
  );
}
