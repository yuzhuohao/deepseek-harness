/**
 * Sidebar entry injection — plain-DOM button inserted after the shell's
 * New Session button. dsh's sidebar shell exposes no slot an external
 * plugin can register into (`sidebar.workspaces` / `sidebar.settings` are
 * single-occupant and already taken), so the entry row is injected
 * directly into the sidebar DOM. The injection self-heals: a
 * MutationObserver watches the sidebar root and re-inserts the row
 * whenever a React re-render displaces it (same frame, before paint, no
 * flicker).
 *
 * The row is plain DOM (no React tree) so it can never disturb the
 * shell's reconciliation; the view it toggles is a separate React root
 * mounted in the center column (see view-mount.tsx).
 *
 * Adapted from dsh-task-board's shared sidebar-entry-core pattern.
 */

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-workflow-entry]'

/** Inline icon (matches the shell's 16px nav-icon look). */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="4" height="3" rx="0.5"/><rect x="10" y="3" width="4" height="3" rx="0.5"/><rect x="6" y="10" width="4" height="3" rx="0.5"/><path d="M4 6v2h8V6M8 8v2"/></svg>'

/** Per-entry configuration for the shared mountSidebarEntry. */
export interface SidebarEntryOptions {
  /** CSS module class names for the row and its two spans. */
  css: Record<string, string>
  /** Localized row label (aria-label + visible text). */
  label(): string
  /** Click action (toggle the owning panel). */
  onToggle(): void
  /** Optional active-state bridge; highlights the row while the panel is open. */
  active?: {
    subscribe(listener: () => void): () => void
    isOpen(): boolean
  }
  /** Optional badge counter; shows a count on the row when > 0. */
  badge?: {
    subscribe(listener: () => void): () => void
    count(): number
  }
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(options: SidebarEntryOptions): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute('data-dsh-workflow-entry', '')
  entry.setAttribute('data-dsh-plugin', 'workflow-designer')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.className = options.css['entry'] ?? ''
  entry.setAttribute('aria-label', options.label())
  entry.innerHTML = '<span class="' + (options.css['entryIcon'] ?? '') + '">' + ICON
    + '</span><span class="' + (options.css['entryLabel'] ?? '') + '">' + options.label() + '</span>'
    + '<span class="' + (options.css['entryBadge'] ?? '') + '" data-count="0" hidden></span>'
  entry.addEventListener('click', options.onToggle)
  return entry
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    root.insertBefore(entry, base.nextElementSibling)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and
 * self-healing on later React re-renders.
 * @param options - the row's copy/action/active-state configuration.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(options: SidebarEntryOptions): () => void {
  if (typeof document !== 'undefined' && document.querySelector(ENTRY_SELECTOR) !== null) {
    return () => {}
  }
  const entry = createEntry(options)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry)
    }
  })

  const unsubscribeActive = options.active === undefined ? undefined : (() => {
    const syncActive = (): void => {
      if (options.active!.isOpen()) entry.dataset.active = 'true'
      else delete entry.dataset.active
    }
    const unsubscribe = options.active.subscribe(syncActive)
    syncActive()
    return unsubscribe
  })()

  const unsubscribeBadge = options.badge === undefined ? undefined : (() => {
    const syncBadge = (): void => {
      const count = options.badge!.count()
      const badgeEl = entry.querySelector<HTMLElement>('[data-count]')
      if (badgeEl === null) return
      if (count > 0) {
        badgeEl.textContent = String(count)
        badgeEl.removeAttribute('hidden')
      } else {
        badgeEl.setAttribute('hidden', '')
      }
    }
    const unsubscribe = options.badge.subscribe(syncBadge)
    syncBadge()
    return unsubscribe
  })()

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeActive?.()
    unsubscribeBadge?.()
    entry.remove()
  }
}
