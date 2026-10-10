export function installIntersectionObserver(autoIntersect = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const observers: TestIntersectionObserver[] = [];
  class TestIntersectionObserver {
    private target: Element | null = null;
    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.target = target;
      if (autoIntersect) queueMicrotask(() => this.intersect(true));
    }
    disconnect() { this.target = null; }
    intersect(isIntersecting: boolean) {
      if (!this.target) return;
      this.callback(
        [{ target: this.target, isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true, value: TestIntersectionObserver,
  });
  return {
    observers,
    restore() {
      if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
      else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    },
  };
}
