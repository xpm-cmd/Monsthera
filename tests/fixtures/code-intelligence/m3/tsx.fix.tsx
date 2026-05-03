// Phase 1 TextMate extractor fixture — TSX declarations.
// Plain test data; not meant to be a runnable program.

interface ButtonProps {
  readonly label: string;
  readonly onClick: () => void;
}

export function Button(props: ButtonProps) {
  return <button onClick={props.onClick}>{props.label}</button>;
}

export function useToggle(initial: boolean) {
  return { value: initial };
}

class Counter {
  count: number = 0;

  increment(): void {
    this.count = this.count + 1;
  }
}

type CounterRef = Counter | null;

enum Variant {
  Primary,
  Secondary,
}
