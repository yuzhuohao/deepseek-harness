/**
 * List view: search, workspace filter, and a card grid. Plan §4 + §7:
 * new/open/archive/delete; slice 1 omits the "last task" status badge
 * (no task runner yet — shows "no tasks started").
 *
 * @module @huawe/dsh-workflow-designer/client/WorkflowList
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type { WorkflowDefinition, WorkflowId } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import css from './panel.module.css'

/** List view props. */
export interface WorkflowListProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  onOpen(workflow: WorkflowDefinition): void
}

/**
 * Render the list view.
 * @param props - copy, store, and open callback.
 * @returns the list element tree.
 */
export function WorkflowList({ t, store, onOpen }: WorkflowListProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('')

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>()
    for (const workflow of state.workflows) {
      if (!seen.has(workflow.workspaceId)) seen.set(workflow.workspaceId, workflow.workspaceId)
    }
    return Array.from(seen.entries())
  }, [state.workflows])

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase()
    return state.workflows.filter(workflow => {
      if (workflow.archived) return false
      if (workspaceFilter !== '' && workflow.workspaceId !== workspaceFilter) return false
      if (lower !== '' && !workflow.name.toLowerCase().includes(lower)) return false
      return true
    })
  }, [state.workflows, query, workspaceFilter])

  const handleArchive = (id: WorkflowId): void => { store.actions.archive(id) }
  const handleDelete = (id: WorkflowId): void => {
    if (window.confirm(t('list.card.deleteConfirm'))) store.actions.delete(id)
  }

  if (state.workflows.length === 0) {
    return (
      <div className={css.emptyState}>
        <div className={css.emptyTitle}>{t('list.empty.title')}</div>
        <div>{t('list.empty.hint')}</div>
      </div>
    )
  }

  return (
    <>
      <div className={css.listHeader}>
        <input
          type="search"
          className={css.search}
          placeholder={t('list.search')}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        {workspaces.length > 1 && (
          <select
            className={css.select}
            value={workspaceFilter}
            onChange={event => setWorkspaceFilter(event.target.value)}
          >
            <option value="">{t('list.filter.workspace')}</option>
            {workspaces.map(([id]) => <option key={id} value={id}>{id}</option>)}
          </select>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className={css.emptyState}>
          <div className={css.emptyTitle}>{t('list.empty.title')}</div>
          <div>{t('list.empty.hint')}</div>
        </div>
      ) : (
        <div className={css.cards}>
          {filtered.map(workflow => (
            <article key={workflow.id} className={css.card}>
              <h3 className={css.cardName}>{workflow.name}</h3>
              <div className={css.cardMeta}>
                <span>{t('list.card.stages', { n: workflow.stages.length })}</span>
                {' · '}
                <span>{t('list.card.lastTask.none')}</span>
              </div>
              {workflow.description.trim() !== '' && (
                <p className={css.cardMeta}>{workflow.description}</p>
              )}
              <div className={css.cardActions}>
                <button type="button" className={css.primary} onClick={() => onOpen(workflow)}>
                  {t('list.card.open')}
                </button>
                <button type="button" className={css.button} onClick={() => handleArchive(workflow.id)}>
                  {t('list.card.archive')}
                </button>
                <button type="button" className={css.danger} onClick={() => handleDelete(workflow.id)}>
                  {t('list.card.delete')}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  )
}

/** Re-export for type-only consumers. */
export type { WorkflowKey }
