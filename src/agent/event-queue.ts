/**
 * A minimal push-based async queue: `push()` is called synchronously
 * from `emit()`, `next()` is awaited by an async generator. No external
 * dependency needed for this — it's ~30 lines and exactly the shape
 * `Agent.stream()` needs, matching "minimal dependencies as a
 * discipline."
 */
export class AsyncEventQueue<T> {
  private buffered: T[] = [];
  private waiting: Array<(result: IteratorResult<T, void>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffered.push(value);
    }
  }

  /** Signals no more values will be pushed. Any pending `next()` calls resolve as done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()!({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T, void>> {
    if (this.buffered.length > 0) {
      return Promise.resolve({ value: this.buffered.shift() as T, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}
