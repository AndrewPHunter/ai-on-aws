// Runs `work` over `items` with at most `size` running at once. Every item is attempted; `work` handles its
// own failures.

export async function runPool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isInteger(size) || size < 1) throw new Error('pool size must be a positive integer')
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}
