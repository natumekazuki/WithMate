/** IntersectionObserver のないテスト環境に代替を設置し、交差通知の制御と元のグローバル定義への復元を提供する。 */
export function installIntersectionObserver(autoIntersect = true) {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "IntersectionObserver",
  );
  const observers: TestIntersectionObserver[] = [];
  /** 監視対象と交差コールバックだけを管理し、レイアウト計算なしで交差を再現する。 */
  class TestIntersectionObserver {
    private targets = new Set<Element>();
    /** インスタンスを返却する一覧に登録し、テストが交差を直接起こせるようにする。 */
    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    /** 要素を監視対象へ加え、自動通知が有効なら取り消されていない要素だけを次のマイクロタスクで通知する。 */
    observe(target: Element) {
      this.targets.add(target);
      if (autoIntersect)
        queueMicrotask(() => {
          if (this.targets.has(target)) this.notify([target], true);
        });
    }
    /** 指定要素の監視を取り消し、保留中の自動通知や後続の手動通知から外す。 */
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    /** すべての監視を解除し、同じインスタンスから新たな交差通知を出さない。 */
    disconnect() {
      this.targets.clear();
    }
    /** 現在監視している全要素に、指定された交差状態を通知する。 */
    intersect(isIntersecting: boolean) {
      this.notify([...this.targets], isIntersecting);
    }
    /** 対象が存在する場合だけ、要素と交差状態をエントリーにして監視コールバックへ渡す。 */
    private notify(targets: Element[], isIntersecting: boolean) {
      if (!targets.length) return;
      this.callback(
        targets.map(
          (target) => ({ target, isIntersecting }) as IntersectionObserverEntry,
        ),
        this as unknown as IntersectionObserver,
      );
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: TestIntersectionObserver,
  });
  return {
    observers,
    /** 設置前のプロパティ定義を復元し、もともと存在しなければ代替をグローバルから削除する。 */
    restore() {
      if (previous)
        Object.defineProperty(globalThis, "IntersectionObserver", previous);
      else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    },
  };
}
