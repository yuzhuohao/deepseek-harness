/**
 * New-workflow modal: name + workspace picker + description. Plan §3 step 2–3
 * + §6.1: workspace is fixed at create time. The modal IS the form — the
 * backdrop click closes, the form submits. Adapted from dsh-task-board's
 * NewTaskModal pattern.
 *
 * @module @huawe/dsh-workflow-designer/client/NewWorkflowDialog
 */
import { useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type { WorkflowId, WorkspaceId } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import css from './panel.module.css'

/** New-workflow modal props. */
export interface NewWorkflowDialogProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  workspaces: IWorkspaces
  onCreated(id: WorkflowId): void
  onCancel(): void
}

/** Workspace option row. */
interface WorkspaceOption {
  id: string
  title: string
}

/**
 * Render the new-workflow modal form.
 * @param props - copy, store, workspaces handle, and callbacks.
 * @returns the modal form element tree.
 */
export function NewWorkflowDialog({ t, store, workspaces, onCreated, onCancel }: NewWorkflowDialogProps): ReactElement {
  const list = useSyncExternalStore(
    workspaces.list.subscribe,
    () => workspaces.list.getSnapshot(),
  )

  const options = useMemo<WorkspaceOption[]>(() => {
    return list.items.map(item => ({
      id: item.workspaceId,
      title: item.title !== '' ? item.title : item.workspaceId,
    }))
  }, [list.items])

  const defaultId = useMemo<string>(() => {
    if (list.recentWorkspaceId !== undefined && options.some(option => option.id === list.recentWorkspaceId)) {
      return list.recentWorkspaceId
    }
    return options.length > 0 ? options[0].id : ''
  }, [options, list.recentWorkspaceId])

  const [name, setName] = useState('')
  const [workspaceId, setWorkspaceId] = useState(defaultId)
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<{ name?: string; workspace?: string }>({})

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const nextErrors: { name?: string; workspace?: string } = {}
    if (name.trim() === '') nextErrors.name = t('new.error.name')
    if (workspaceId === '') nextErrors.workspace = t('new.error.workspace')
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    const id = store.actions.create({
      name: name.trim(),
      workspaceId: workspaceId as WorkspaceId,
      description: description.trim(),
    })
    onCreated(id)
  }

  return (
    <form
      className={css.modal}
      role="dialog"
      aria-modal="true"
      aria-label={t('new.title')}
      onSubmit={handleSubmit}
    >
      <h2 className={css.modalTitle}>{t('new.title')}</h2>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.name.label')}</span>
        <input
          className={css.input}
          placeholder={t('new.name.placeholder')}
          value={name}
          autoFocus
          onChange={event => { setName(event.target.value); setErrors({}) }}
        />
        {errors.name !== undefined && <p className={css.formError}>{errors.name}</p>}
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.workspace.label')}</span>
        {options.length === 0 ? (
          <p className={css.formError}>{t('new.workspace.empty')}</p>
        ) : (
          <select
            className={css.select}
            value={workspaceId}
            onChange={event => { setWorkspaceId(event.target.value); setErrors({}) }}
          >
            {options.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
        )}
        {errors.workspace !== undefined && <p className={css.formError}>{errors.workspace}</p>}
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.description.label')}</span>
        <textarea
          className={css.input}
          rows={3}
          placeholder={t('new.description.placeholder')}
          value={description}
          onChange={event => { setDescription(event.target.value) }}
        />
      </label>

      <footer className={css.modalFooter}>
        <button type="button" className={css.button} onClick={onCancel}>
          {t('new.cancel')}
        </button>
        <button type="submit" className={css.primary} disabled={options.length === 0}>
          {t('new.create')}
        </button>
      </footer>
    </form>
  )
}

/** Re-export for type-only consumers. */
export type { WorkflowKey }
