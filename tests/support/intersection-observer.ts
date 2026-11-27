export function installIntersectionObserver(autoIntersect = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const observers: TestIntersectionObserver[] = [];
  class TestIntersectionObserver {
    private targets = new Set<Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
      if (autoIntersect) queueMicrotask(() => { if (this.targets.has(target)) this.notify([target], true); });
    }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    intersect(isIntersecting: boolean) { this.notify([...this.targets], isIntersecting); }
    private notify(targets: Element[], isIntersecting: boolean) {
      if (!targets.length) return;
      this.callback(
        targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
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
