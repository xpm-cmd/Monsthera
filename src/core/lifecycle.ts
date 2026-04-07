/** Resource that can be cleaned up */
export interface Disposable {
  dispose(): Promise<void>;
}

/** Stack of disposable resources — disposed in LIFO order */
export class DisposableStack {
  private readonly resources: Disposable[] = [];

  /** Register a disposable resource */
  use<T extends Disposable>(resource: T): T {
    this.resources.push(resource);
    return resource;
  }

  /** Register a cleanup function as disposable */
  defer(fn: () => Promise<void> | void): void {
    this.resources.push({ dispose: async () => { await fn(); } });
  }

  /** Dispose all resources in reverse order */
  async dispose(): Promise<void> {
    const errors: Error[] = [];
    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.dispose();
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    this.resources.length = 0;
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose ${errors.length} resource(s)`);
    }
  }

  get size(): number {
    return this.resources.length;
  }
}
