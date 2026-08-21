/**
 * Workflow view mounting.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the workflow view takes over the center
 * column at the DOM level: a container is appended inside the center column
 * (`[class*="centerCol"]`, the dsh AppFrame layout; also
 * `[data-pane="conversation"]` on older shells) as an extra trailing child
 * React never manages, and a stylesheet rule hides the conversation content
 * while the workflow view is active. Toggling is a data attribute on
 * `<html>` — no React involvement, so the conversation subtree underneath
 * stays mounted and stateful.
 *
 * Adapted from dsh-task-board's board-mount pattern.
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkflowStoreInstance } from './store.ts'
import type { SurfaceStateInstance } from './surface-state.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import css from './panel.module.css'

/** The injected view container (kept in the DOM, hidden when inactive). */
export const VIEW_SELECTOR = '[data-dsh-workflow-view]'

/** Center column selectors (current + legacy shell). */
const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'

/** This panel's activation attribute on <html>. */
const ACTIVE_ATTR = 'data-dsh-workflow-active'

/** Sibling panels' activation attributes, removed when this panel opens. */
const SIBLING_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']

/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'

/** This panel's name in the activation event stream. */
const PANEL_NAME = 'workflow'

/** Sidebar row selectors: clicking any of these closes the workflow view. */
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/** Props passed to the React panel. */
export interface ViewMountProps {
  surface: SurfaceStateInstance
  store: WorkflowStoreInstance
  workspaces: IWorkspaces
  sessions: ISessions
  t: TranslateNS<'workflow'>
}

/**
 * Mount the workflow React tree into the center column and bind its
 * visibility to the surface state.
 * @param props - surface state, store, workspaces handle, and translate function.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountWorkflowView(props: ViewMountProps): () => void {
  const { surface, store, workspaces, sessions, t } = props
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshWorkflowView = ''
    container.dataset.dshPlugin = 'workflow-designer'
    container.className = css.viewContainer
    column.appendChild(container)
    root = createRoot(container)
    root.render(createElement(WorkflowPanel, {
      t,
      store,
      workspaces,
      sessions,
      onClose: () => { surface.close() },
    }))
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (surface.getSnapshot().open) {
      // Single-occupant center column: opening this panel must evict sibling
      // panels (task-board / ssh), both their html attributes, otherwise the
      // panels' visibility rules fight and the second click appears dead.
      for (const attr of SIBLING_ACTIVE_ATTRS) {
        document.documentElement.removeAttribute(attr)
      }
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (detail !== undefined && detail !== PANEL_NAME && surface.getSnapshot().open) {
      surface.close()
    }
  }
  // Jump out on sidebar context clicks: clicking a session/workspace row
  // (including the already-current one, which produces no session-change
  // event) hands the center column back to the conversation. Capture phase,
  // so the panel closes before the shell processes the click.
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!surface.getSnapshot().open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) surface.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = surface.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
