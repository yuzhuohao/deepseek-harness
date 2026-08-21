/**
 * Task list view: active + history tabs, status badges, per-workflow
 * filter. Plan §4 + §7: the task list is a top-level panel view (peer of
 * the workflow list); slice 2 shows all tasks stored in localStorage
 * (real execution arrives in slice 3).
 *
 * @module @huawe/dsh-workflow-designer/client/TaskList
 */
import { useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type { TaskRecord, TaskStatus } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import css from './panel.module.css'

/** Task list props. */
export interface TaskListProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  onOpen(task: TaskRecord): void
}

/** Active statuses (showed in the "Active" tab). */
const ACTIVE_STATUSES = new Set<TaskStatus>(['pending', 'running', 'waiting_human'])

/** Status badge tone (maps to CSS data-status attribute). */
function statusTone(status: TaskStatus): string {
  switch (status) {
    case 'pending': return 'pending'
    case 'running': return 'running'
    case 'waiting_human': return 'waiting'
    case 'succeeded': return 'succeeded'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
  }
}

/** Format an ISO timestamp for display. */
function formatTime(iso: string | undefined): string {
  if (iso === undefined) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/**
 * Render the task list.
 * @param props - copy, store, and open callback.
 * @returns the list element tree.
 */
export function TaskList({ t, store, onOpen }: TaskListProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [workflowFilter, setWorkflowFilter] = useState<string>('')

  const workflows = useMemo(() => {
    const seen = new Map<string, string>()
    for (const task of state.tasks) {
      if (!seen.has(task.workflowId)) seen.set(task.workflowId, task.workflowName)
    }
    return Array.from(seen.entries())
  }, [state.tasks])

  const filtered = useMemo(() => {
    return state.tasks.filter(task => {
      if (workflowFilter !== '' && task.workflowId !== workflowFilter) return false
      const isActive = ACTIVE_STATUSES.has(task.status)
      return tab === 'active' ? isActive : !isActive
    })
  }, [state.tasks, tab, workflowFilter])

  const handleCancel = (taskId: string): void => { store.actions.cancelTask(taskId as never) }
  const handleDelete = (taskId: string): void => {
    if (window.confirm(t('task.list.deleteConfirm'))) store.actions.deleteTask(taskId as never)
  }

  if (state.tasks.length === 0) {
    return (
      <div className={css.emptyState}>
        <div className={css.emptyTitle}>{t('task.list.empty')}</div>
      </div>
    )
  }

  return (
    <>
      <div className={css.listHeader}>
        <div className={css.tabGroup}>
          <button
            type="button"
            className={tab === 'active' ? css.tabActive : css.tab}
            onClick={() => setTab('active')}
          >
            {t('task.list.active')}
          </button>
          <button
            type="button"
            className={tab === 'history' ? css.tabActive : css.tab}
            onClick={() => setTab('history')}
          >
            {t('task.list.history')}
          </button>
        </div>
        {workflows.length > 1 && (
          <select
            className={css.select}
            value={workflowFilter}
            onChange={event => setWorkflowFilter(event.target.value)}
          >
            <option value="">{t('list.filter.workspace')}</option>
            {workspaces(workflows)}
          </select>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className={css.emptyState}>
          <div className={css.emptyTitle}>{t('task.list.empty')}</div>
        </div>
      ) : (
        <div className={css.cards}>
          {filtered.map(task => (
            <article key={task.id} className={css.card}>
              <h3 className={css.cardName}>{task.workflowName}</h3>
              <div className={css.cardMeta}>
                <span className={css.statusBadge} data-status={statusTone(task.status)}>
                  {t(`task.status.${task.status}` as never)}
                </span>
                {' · '}
                <span>{formatTime(task.startedAt)}</span>
              </div>
              <div className={css.cardMeta}>
                <span>{t('task.detail.stageTimeline')}: {task.stageRuns.length}</span>
              </div>
              <div className={css.cardActions}>
                <button type="button" className={css.primary} onClick={() => onOpen(task)}>
                  {t('task.list.open')}
                </button>
                {ACTIVE_STATUSES.has(task.status) && (
                  <button type="button" className={css.button} onClick={() => handleCancel(task.id)}>
                    {t('task.list.cancel')}
                  </button>
                )}
                {!ACTIVE_STATUSES.has(task.status) && (
                  <button type="button" className={css.danger} onClick={() => handleDelete(task.id)}>
                    {t('task.list.delete')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  )
}

/** Helper: render workspace filter options. */
function workspaces(entries: [string, string][]): ReactElement[] {
  return entries.map(([id, name]) => <option key={id} value={id}>{name}</option>)
}

/** Re-export for type-only consumers. */
export type { WorkflowKey }
