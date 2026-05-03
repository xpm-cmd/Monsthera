// Phase 1 TextMate extractor fixture — TypeScript declarations.
// Plain test data; not meant to be a runnable program.

export function topLevelFn(x: number): number {
  return x + 1;
}

async function asyncWorker(): Promise<void> {
  await Promise.resolve();
}

function genericId<T>(value: T): T {
  return value;
}

export class WidgetService {
  field: number = 0;

  constructor(initial: number) {
    this.field = initial;
  }

  doSomething(amount: number): number {
    return this.field + amount;
  }
}

interface Widget {
  readonly id: string;
  readonly label: string;
}

type WidgetSummary = Pick<Widget, "id">;

enum WidgetStatus {
  Idle = "idle",
  Active = "active",
}

namespace WidgetUtilities {
  export function describe(w: Widget): string {
    return w.label;
  }
}
