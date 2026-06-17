export type RuntimeOptionChangeHandler<T> = (value: T) => void | Promise<void>;

export type AuxiliaryAwareRuntimeOptionChangeHandlerConfig<T> = {
  shouldUseAuxiliary: boolean;
  onAuxiliaryChange: RuntimeOptionChangeHandler<T>;
  onSelectedSessionChange: RuntimeOptionChangeHandler<T>;
};

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
