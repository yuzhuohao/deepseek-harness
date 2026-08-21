/**
 * Shared open/close state for the workflow surface. The sidebar entry
 * button writes it; the view mount reads it. Lives in the apply body —
 * one handle, threaded to both mount functions.
 *
 * `useSyncExternalStore` contract: `getSnapshot()` returns the same
 * reference until the fact moves, and `subscribe()` fires on every
 * mutation.
 */
export interface SurfaceSnapshot {
  readonly open: boolean
}

/** Public surface-state handle. */
export interface SurfaceStateInstance {
  subscribe(listener: () => void): () => void
  getSnapshot(): SurfaceSnapshot
  open(): void
  close(): void
  toggle(): void
}

/**
 * Create the surface state. Module-level handles are forbidden; the apply
 * body calls this and threads one handle to every mount function.
 */
export function createSurfaceState(): SurfaceStateInstance {
  let snapshot: SurfaceSnapshot = { open: false }
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot(): SurfaceSnapshot { return snapshot },
    open(): void {
      if (snapshot.open) return
      snapshot = { open: true }
      notify()
    },
    close(): void {
      if (!snapshot.open) return
      snapshot = { open: false }
      notify()
    },
    toggle(): void {
      if (snapshot.open) { snapshot = { open: false }; notify() }
      else { snapshot = { open: true }; notify() }
    },
  }
}
