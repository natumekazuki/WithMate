/** 実行設定の変更を受け取る処理。保存を伴う場合は非同期でもよい。 */
export type RuntimeOptionChangeHandler<T> = (value: T) => void | Promise<void>;

/** 実行設定を Auxiliary と選択中 Session のどちらへ届けるかと、それぞれの更新先。 */
export type AuxiliaryAwareRuntimeOptionChangeHandlerConfig<T> = {
  shouldUseAuxiliary: boolean;
  onAuxiliaryChange: RuntimeOptionChangeHandler<T>;
  onSelectedSessionChange: RuntimeOptionChangeHandler<T>;
};

/** 設定変更を指定された側の更新口にだけ渡し、UI の呼び出し元には完了を待たせない。 */
export function buildAuxiliaryAwareRuntimeOptionChangeHandler<T>(
  config: AuxiliaryAwareRuntimeOptionChangeHandlerConfig<T>,
): (value: T) => void {
  return (value: T): void => {
    if (config.shouldUseAuxiliary) {
      void config.onAuxiliaryChange(value);
      return;
    }

    void config.onSelectedSessionChange(value);
  };
}
