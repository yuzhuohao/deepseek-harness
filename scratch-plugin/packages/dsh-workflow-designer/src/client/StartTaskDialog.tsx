/**
 * Start-task dialog: collects task-input values before creating a task
 * record. Plan §3 step 5 + §6.4: the form fields come from the workflow
 * definition's stage-level `taskInputs` declarations (collected across
 * all stages). If no fields are declared, the user starts directly.
 *
 * @module @huawe/dsh-workflow-designer/client/StartTaskDialog
 */
import { useMemo, useState, type ReactElement } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type { TaskId, WorkflowDefinition } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import { collectTaskInputFields } from './store.ts'
import css from './panel.module.css'

/** Start-task dialog props. */
export interface StartTaskDialogProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  workflow: WorkflowDefinition
  onStarted(taskId: TaskId): void
  onCancel(): void
}

/**
 * Render the start-task form.
 * @param props - copy, store, workflow definition, and callbacks.
 * @returns the form element tree.
 */
export function StartTaskDialog({ t, store, workflow, onStarted, onCancel }: StartTaskDialogProps): ReactElement {
  const fields = useMemo(() => collectTaskInputFields(workflow), [workflow])
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of fields) {
      if (field.defaultValue !== '') initial[field.name] = field.defaultValue
    }
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    for (const field of fields) {
      if (field.required && (values[field.name] ?? '').trim() === '') {
        nextErrors[field.name] = t('task.input.required')
      }
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    const taskId = store.actions.createTask(workflow, values)
    onStarted(taskId)
  }

  return (
    <form className={css.form} onSubmit={handleSubmit}>
      <h3 className={css.detailTitle}>{t('task.start.formTitle', { name: workflow.name })}</h3>
      {fields.length === 0 ? (
        <p className={css.cardMeta}>{t('task.start.noInputs')}</p>
      ) : (
        fields.map(field => (
          <div key={field.name} className={css.formRow}>
            <label className={css.label} htmlFor={`task-input-${field.name}`}>
              {field.label !== '' ? field.label : field.name}
              {field.required ? ` (${t('task.input.required')})` : ` (${t('task.input.optional')})`}
            </label>
            <input
              id={`task-input-${field.name}`}
              type="text"
              className={css.input}
              value={values[field.name] ?? ''}
              onChange={event => setValues(prev => ({ ...prev, [field.name]: event.target.value }))}
            />
            {errors[field.name] !== undefined && (
              <p className={css.errorText}>{errors[field.name]}</p>
            )}
          </div>
        ))
      )}
      <div className={css.formActions}>
        <button type="button" className={css.button} onClick={onCancel}>
          {t('task.start.cancel')}
        </button>
        <button type="submit" className={css.primary}>
          {t('task.start.confirm')}
        </button>
      </div>
    </form>
  )
}

/** Re-export for type-only consumers. */
export type { WorkflowKey }
