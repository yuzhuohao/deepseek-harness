/**
 * Workflow designer — browser half. Registers the `workflow` locale
 * namespace and mounts two DOM-injected surfaces:
 *
 *  - sidebar entry: a plain-DOM button injected after the shell's New
 *    Session button (mountSidebarEntry). Self-heals on React re-renders.
 *  - workflow view: a React root appended inside the center column
 *    (mountWorkflowView). Visibility toggles via a data attribute on
 *    `<html>`; the conversation subtree stays mounted underneath.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into,
 * and the `conversation` slot is single-occupant (ui-conversation), so
 * both surfaces are DOM-injected rather than slot-registered. This matches
 * the dsh-task-board plugin's pattern.
 *
 * Slice 1: localStorage MVP persistence (Host KV arrives in slice 3).
 *
 * @module @huawe/dsh-workflow-designer/client
 */
import type { ClientContext, ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { NS, en, zh, type WorkflowKey } from './locales.ts'
import { createSurfaceState, type SurfaceStateInstance } from './surface-state.ts'
import { createWorkflowStore, type WorkflowStoreInstance } from './store.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { mountWorkflowView } from './view-mount.tsx'
import css from './panel.module.css'

export type { WorkflowKey } from './locales.ts'
export type { WorkflowDefinition, Stage, CompletionRule, WorkflowId, StageId, WorkspaceId, WorkflowStoreState } from '../types.ts'
export type { WorkflowStoreInstance, WorkflowStoreActions } from './store.ts'
export type { SurfaceStateInstance, SurfaceSnapshot } from './surface-state.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Stage-workflow surface copy. */
    workflow: WorkflowKey
  }
}

/** Required services: locale (for dictionary registration + bind), workspaces (for the new-workflow form). */
export const inject = ['locale', 'workspaces']

/** Stable data attribute values for the DOM-injected surfaces. */
const PLUGIN_NAME = 'workflow-designer'

/**
 * Mount the workflow-designer surfaces: register dictionaries, create the
 * store + surface state, then mount the sidebar entry + the center-column
 * view. Both mounts are DOM-injected (no ctx.slots.register).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workflow-designer: dictionaries')

  const t = ctx.locale.bind(NS) as TranslateNS<'workflow'>
  const store: WorkflowStoreInstance = createWorkflowStore()
  const surface: SurfaceStateInstance = createSurfaceState()

  // Read the browser-runtime workspaces handle for the new-workflow form.
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  const sessions = ctx.get('sessions') as unknown as ISessions

  const disposers: Array<() => void> = []

  disposers.push(mountSidebarEntry({
    css: {
      entry: css['entry'] ?? '',
      entryIcon: css['entryIcon'] ?? '',
      entryLabel: css['entryLabel'] ?? '',
      entryBadge: css['entryBadge'] ?? '',
    },
    label: () => t('entry.label'),
    onToggle: () => { surface.toggle() },
    active: {
      subscribe: (listener) => surface.subscribe(listener),
      isOpen: () => surface.getSnapshot().open,
    },
    badge: {
      subscribe: (listener) => store.subscribe(listener),
      count: () => {
        const snapshot = store.getSnapshot()
        return snapshot.tasks.filter(task => task.status === 'running' || task.status === 'waiting_human').length
      },
    },
  }))

  disposers.push(mountWorkflowView({ surface, store, workspaces, sessions, t }))

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'workflow-designer: surface mounts')

  // Touch PLUGIN_NAME so the constant is used (future telemetry hook).
  void PLUGIN_NAME
}
