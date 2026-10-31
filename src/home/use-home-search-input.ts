import { useCallback, useEffect, useRef, useState } from "react";

export function useHomeSearchInput() {
  const [inputText, setInputText] = useState("");
  const [searchText, setSearchText] = useState("");
  const inputTextRef = useRef("");
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelPending = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  const applyAfterInput = useCallback((value: string) => {
    cancelPending();
    if (value === "") {
      setSearchText("");
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setSearchText(value);
    }, 300);
  }, [cancelPending]);

  const onChangeInputText = useCallback((value: string) => {
    if (inputTextRef.current === value) return;
    inputTextRef.current = value;
    setInputText(value);
    if (!composingRef.current) applyAfterInput(value);
  }, [applyAfterInput]);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    cancelPending();
  }, [cancelPending]);

  const onCompositionEnd = useCallback((value: string) => {
    composingRef.current = false;
    inputTextRef.current = value;
    setInputText(value);
    applyAfterInput(value);
  }, [applyAfterInput]);

  return { inputText, searchText, onChangeInputText, onCompositionStart, onCompositionEnd };
}
