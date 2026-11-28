import { useEffect, useState } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { ComposerControllerRegistry } from "../../chat/composer-controller.js";
import type { AuxiliaryDraftPersistence } from "../../chat/auxiliary/use-auxiliary-draft-persistence.js";

/** アプリ終了時などの保存完了要求を処理するために必要な補助下書きの永続化操作。 */
type SessionDraftFlushPersistence = Pick<
  AuxiliaryDraftPersistence,
  "waitForPendingSends" | "flushAll" | "pendingSessionIds"
>;

/** 保存完了要求で編集を凍結し、終了時は送信の完了も待つ。保存完了に失敗したときだけ凍結を解く。 */
export function useSessionDraftFlushLifecycle(input: {
  api: WithMateWindowApi | null;
  composerRegistry: ComposerControllerRegistry;
  persistence: SessionDraftFlushPersistence;
}): boolean {
  const { api, composerRegistry, persistence } = input;
  const [isComposerFrozen, setIsComposerFrozen] = useState(false);

  useEffect(() => {
    if (!api) {
      return;
    }

    const unsubscribeRequest = api.subscribeSessionDraftFlushRequest(
      (request) => {
        composerRegistry.freeze();
        setIsComposerFrozen(true);
        void (async () => {
          if (request.reason === "quit") {
            // 現在の保存キューが空になった後でも、送信失敗によって復元処理がキューに入ることがある。
            await persistence.waitForPendingSends();
          }
          await persistence.flushAll();
        })()
          .then(() => api.acknowledgeSessionDraftFlush(request.requestId, true))
          .catch(() =>
            api.acknowledgeSessionDraftFlush(request.requestId, false),
          );
      },
    );
    const unsubscribeRelease = api.subscribeSessionDraftFlushRelease(
      ({ success }) => {
        if (!success) {
          composerRegistry.unfreeze();
          setIsComposerFrozen(false);
          persistence.pendingSessionIds().forEach((sessionId) => {
            composerRegistry.setSaveState(
              { kind: "auxiliary", id: sessionId },
              "error",
              "Draft could not be saved. Retry.",
            );
          });
        }
      },
    );

    return () => {
      unsubscribeRequest();
      unsubscribeRelease();
    };
  }, [api, composerRegistry, persistence]);

  return isComposerFrozen;
}
