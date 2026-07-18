// Minimal binary-heap min-priority-queue used by Dijkstra's algorithm in route.ts.
// Kept generic/self-contained so it has no dependency on the routing types.

/**
 * Array-backed binary min-heap, ordered by `priority`. Supports O(log n) push/pop.
 * Does not support decrease-key directly - callers instead push a new (priority, value)
 * pair whenever a shorter distance is found, and treat stale/duplicate pops as no-ops
 * (the standard "lazy deletion" approach for Dijkstra with a binary heap).
 */
export class MinHeap<T> {
  private items: { priority: number; value: T }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, value: T): void {
    const items = this.items;
    items.push({ priority, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= items[i].priority) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): { priority: number; value: T } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < n && items[left].priority < items[smallest].priority) smallest = left;
        if (right < n && items[right].priority < items[smallest].priority) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}
