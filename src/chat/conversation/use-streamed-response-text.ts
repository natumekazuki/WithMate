import { useLayoutEffect, useRef, useState } from "react";

const STREAM_PRESENTATION_INTERVAL_MS = 100;

export function useStreamedResponseText(owner: string, key: string | null, text: string, streaming: boolean, enabled: boolean) {
  const latest = useRef({ owner, key, text });
  latest.current = { owner, key, text: enabled ? text : "" };
  const [presented, setPresented] = useState({ owner, key, text: "" });
  const snapshot = useRef(presented);
  snapshot.current = presented;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const clear = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
    const publish = (value: typeof presented) => { snapshot.current = value; setPresented(value); };
    if (!enabled || !key || !streaming) {
      clear();
      const value = enabled ? text : "";
      if (snapshot.current.owner !== owner || snapshot.current.key !== key || snapshot.current.text !== value) publish({ owner, key, text: value });
      return;
    }
    if (snapshot.current.owner !== owner || snapshot.current.key !== key) {
      clear(); publish({ owner, key, text: "" });
    }
    if (snapshot.current.text !== text && timer.current === null) {
      // 差分が届いても予定時刻を維持する。更新間隔を上限内に保つ処理であり、デバウンスではない。
      timer.current = setTimeout(() => { timer.current = null; publish(latest.current); }, STREAM_PRESENTATION_INTERVAL_MS);
    }
  }, [owner, key, text, streaming, enabled]);
  useLayoutEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);
  if (!enabled) return "";
  if (!streaming) return text;
  return presented.owner === owner && presented.key === key ? presented.text : "";
}
