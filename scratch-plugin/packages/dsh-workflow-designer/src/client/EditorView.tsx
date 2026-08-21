/**
 * Linear stage editor. Plan §6.2 + §6.3: stages are a linear list for
 * slice 1 (no branches, no edges, no predicates — those land in slice 5).
 *
 * Each stage has: title, goal, completion rule (three options), and the
 * rule-specific subfields. The editor validates on save: every stage must
 * have a goal, and there must be a single entry stage (slice 1 = first
 * stage). Saves call `store.actions.setStages`; the panel marks dirty on
 * the first local edit and clears dirty on save.
 *
 * @module @huawe/dsh-workflow-designer/client/EditorView
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type {
  AgentPresetOption,
  CompletionRule,
  Stage,
  StageEdge,
  StageId,
  TaskInputField,
  WorkflowDefinition,
  WorkflowId,
} from '../types.ts'
import { generateId } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import css from './panel.module.css'

/** Editor view props. */
export interface EditorViewProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  workflowId: WorkflowId
  /** Notify the panel of unsaved-changes state. */
  onDirty(dirty: boolean): void
}
/** Local editable stage copy (carries the same fields as the durable Stage). */
type LocalStage = Stage

/**
 * Render the linear stage editor.
 * @param props - copy, store, workflow id, and dirty callback.
 * @returns the editor element tree.
 */
export function EditorView({ t, store, workflowId, onDirty }: EditorViewProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const workflow = useMemo<WorkflowDefinition | undefined>(() => {
    const wf = state.workflows.find(item => item.id === workflowId)
    if (wf === undefined) return undefined
    // Normalize: ensure all array fields exist (older data may lack edges/skills/taskInputs).
    return { ...wf, stages: wf.stages.map(s => ({ ...s, taskInputs: s.taskInputs ?? [], skills: s.skills ?? [], edges: s.edges ?? [] })) }
  }, [state.workflows, workflowId])

  const [stages, setStages] = useState<LocalStage[]>(workflow?.stages ?? [])
  const [errors, setErrors] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (workflow !== undefined && !dirty) setStages(workflow.stages)
  }, [workflow, dirty])

  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])

  if (workflow === undefined) {
    return (
      <div className={css.emptyState}>
        <div className={css.emptyTitle}>{t('list.empty.title')}</div>
      </div>
    )
  }

  const markDirty = (): void => { setDirty(true) }

  const handleAddStage = (): void => {
    const next: LocalStage = {
      id: generateId('stage') as StageId,
      title: `${t('editor.stage.title', { n: stages.length + 1 })}`,
      goal: '',
      completion: { kind: 'self-declare', doneWhen: '' },
      taskInputs: [],
      skills: [],
      edges: [],
    }
    setStages([...stages, next])
    markDirty()
  }

  const handleRemove = (id: StageId): void => {
    setStages(stages.filter(stage => stage.id !== id))
    markDirty()
  }

  const handleMove = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= stages.length) return
    const next = [...stages]
    const [moved] = next.splice(index, 1)
    if (moved === undefined) return
    next.splice(target, 0, moved)
    setStages(next)
    markDirty()
  }

  const handlePatch = (id: StageId, patch: (stage: LocalStage) => LocalStage): void => {
    setStages(stages.map(stage => stage.id === id ? patch(stage) : stage))
    markDirty()
  }

  const handleSave = (): void => {
    const newErrors: string[] = []
    if (stages.length === 0) {
      newErrors.push(t('editor.error.noStages'))
    }
    stages.forEach((stage, index) => {
      if (stage.goal.trim() === '') {
        newErrors.push(t('editor.error.emptyGoal', { n: index + 1 }))
      }
    })
    if (stages.length > 0 && workflow.entryStageId !== undefined
      && !stages.some(stage => stage.id === workflow.entryStageId)) {
      newErrors.push(t('editor.error.noEntry'))
    }
    setErrors(newErrors)
    if (newErrors.length > 0) return
    store.actions.setStages(workflowId, stages)
    setDirty(false)
  }

  return (
    <>
      <div className={css.listHeader}>
        <p className={css.subtitle}>{t('editor.subtitle')}</p>
        <div className={css.actions}>
          {dirty && <span className={css.warn}>{t('editor.unsaved')}</span>}
          {!dirty && stages.length > 0 && <span className={css.badge}>{t('editor.saved')}</span>}
          <button type="button" className={css.button} onClick={handleAddStage}>
            {t('editor.addStage')}
          </button>
          <button type="button" className={css.primary} onClick={handleSave} disabled={!dirty}>
            {t('editor.save')}
          </button>
        </div>
      </div>
      {errors.length > 0 && (
        <ul className={css.errorText}>
          {errors.map((error, index) => <li key={index}>{error}</li>)}
        </ul>
      )}
      {stages.length === 0 ? (
        <div className={css.emptyState}>
          <div className={css.emptyTitle}>{t('editor.empty.title')}</div>
          <div>{t('editor.empty.hint')}</div>
        </div>
      ) : (
        <div className={css.stages}>
          {stages.map((stage, index) => (
            <StageCard
              key={stage.id}
              stage={stage}
              index={index}
              total={stages.length}
              stages={stages}
              presets={state.presets ?? []}
              t={t}
              onRemove={() => handleRemove(stage.id)}
              onMoveUp={() => handleMove(index, -1)}
              onMoveDown={() => handleMove(index, 1)}
              onPatch={patch => handlePatch(stage.id, patch)}
            />
          ))}
        </div>
      )}
    </>
  )
}

/** One stage card. */
interface StageCardProps {
  stage: LocalStage
  index: number
  total: number
  stages: LocalStage[]
  presets: readonly AgentPresetOption[]
  t: TranslateNS<'workflow'>
  onRemove(): void
  onMoveUp(): void
  onMoveDown(): void
  onPatch(patch: (stage: LocalStage) => LocalStage): void
}

function StageCard({ stage, index, total, stages, presets, t, onRemove, onMoveUp, onMoveDown, onPatch }: StageCardProps): ReactElement {
  const setCompletion = (kind: CompletionRule['kind']): void => {
    let next: CompletionRule
    if (kind === 'self-declare') {
      next = { kind: 'self-declare', doneWhen: stage.completion.kind === 'self-declare' || stage.completion.kind === 'human-confirm' ? stage.completion.doneWhen : '' }
    } else if (kind === 'human-confirm') {
      next = { kind: 'human-confirm', doneWhen: stage.completion.kind === 'self-declare' || stage.completion.kind === 'human-confirm' ? stage.completion.doneWhen : '' }
    } else {
      next = { kind: 'auto-check', command: stage.completion.kind === 'auto-check' ? stage.completion.command : '' }
    }
    onPatch(s => ({ ...s, completion: next }))
  }

  return (
    <article className={css.stage}>
      <header className={css.stageHeader}>
        <h3 className={css.stageTitle}>{t('editor.stage.title', { n: index + 1 })}</h3>
        <div className={css.stageActions}>
          <button type="button" className={css.iconButton} onClick={onMoveUp} disabled={index === 0} title={t('editor.stage.moveUp')}>↑</button>
          <button type="button" className={css.iconButton} onClick={onMoveDown} disabled={index === total - 1} title={t('editor.stage.moveDown')}>↓</button>
          <button type="button" className={css.iconButton} onClick={onRemove} title={t('editor.stage.remove')}>×</button>
        </div>
      </header>
      <div className={css.formRow}>
        <label className={css.label} htmlFor={`stage-title-${stage.id}`}>{t('editor.stage.titleField')}</label>
        <input
          id={`stage-title-${stage.id}`}
          type="text"
          className={css.input}
          value={stage.title}
          onChange={event => onPatch(s => ({ ...s, title: event.target.value }))}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.label} htmlFor={`stage-goal-${stage.id}`}>{t('editor.stage.goal.label')}</label>
        <textarea
          id={`stage-goal-${stage.id}`}
          className={css.textarea}
          placeholder={t('editor.stage.goal.placeholder')}
          value={stage.goal}
          onChange={event => onPatch(s => ({ ...s, goal: event.target.value }))}
        />
      </div>
      <div className={css.completionRow}>
        <div className={css.formRow} style={{ flex: '0 0 auto', minWidth: '180px' }}>
          <label className={css.label} htmlFor={`stage-completion-${stage.id}`}>{t('editor.stage.completion.label')}</label>
          <select
            id={`stage-completion-${stage.id}`}
            className={css.select}
            value={stage.completion.kind}
            onChange={event => setCompletion(event.target.value as CompletionRule['kind'])}
          >
            <option value="self-declare">{t('editor.stage.completion.self-declare')}</option>
            <option value="human-confirm">{t('editor.stage.completion.human-confirm')}</option>
            <option value="auto-check">{t('editor.stage.completion.auto-check')}</option>
          </select>
        </div>
        <div className={css.formRow} style={{ flex: '0 0 auto', minWidth: '200px' }}>
          <label className={css.label} htmlFor={`stage-sandbox-${stage.id}`}>{t('editor.stage.sandbox')}</label>
          <select
            id={`stage-sandbox-${stage.id}`}
            className={css.select}
            value={stage.sandbox ?? 'workspace-write'}
            onChange={event => onPatch(s => ({ ...s, sandbox: event.target.value as Stage['sandbox'] }))}
          >
            <option value="workspace-write">{t('editor.stage.sandbox.workspace-write')}</option>
            <option value="read-only">{t('editor.stage.sandbox.read-only')}</option>
            <option value="danger-full-access">{t('editor.stage.sandbox.danger-full-access')}</option>
          </select>
        </div>
        <div className={css.formRow} style={{ flex: '0 0 auto', minWidth: '180px' }}>
          <label className={css.label} htmlFor={`stage-preset-${stage.id}`}>{t('editor.stage.preset')}</label>
          <select
            id={`stage-preset-${stage.id}`}
            className={css.select}
            value={stage.agentPreset ?? ''}
            onChange={event => onPatch(s => ({ ...s, agentPreset: event.target.value }))}
          >
            <option value="">{t('editor.stage.preset.default')}</option>
            {presets.map(preset => (
              <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
                {preset.name}{preset.isDefault ? ` (${t('editor.stage.preset.defaultTag')})` : ''}{preset.broken !== undefined ? ` — ${t('editor.stage.preset.broken')}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className={css.completionFields}>
        {(stage.completion.kind === 'self-declare' || stage.completion.kind === 'human-confirm') && (
          <div className={css.formRow}>
            <label className={css.label} htmlFor={`stage-done-${stage.id}`}>{t('editor.stage.completion.doneWhen')}</label>
            <input
              id={`stage-done-${stage.id}`}
              type="text"
              className={css.input}
              value={stage.completion.doneWhen}
              onChange={event => onPatch(s => ({
                ...s,
                completion: { kind: s.completion.kind, doneWhen: event.target.value } as CompletionRule,
              }))}
            />
          </div>
        )}
        {stage.completion.kind === 'auto-check' && (
          <>
            <div className={css.formRow}>
              <label className={css.label} htmlFor={`stage-cmd-${stage.id}`}>{t('editor.stage.completion.command')}</label>
              <input
                id={`stage-cmd-${stage.id}`}
                type="text"
                className={css.input}
                value={stage.completion.command}
                onChange={event => onPatch(s => ({
                  ...s,
                  completion: { kind: 'auto-check', command: event.target.value, expectedExitCode: 0 } as CompletionRule,
                }))}
              />
            </div>
            <div className={css.formRow}>
              <label className={css.label} htmlFor={`stage-exit-${stage.id}`}>{t('editor.stage.completion.expectedExitCode')}</label>
              <input
                id={`stage-exit-${stage.id}`}
                type="number"
                className={css.input}
                value={String(stage.completion.kind === 'auto-check' ? (stage.completion.expectedExitCode ?? 0) : 0)}
                onChange={event => onPatch(s => ({
                  ...s,
                  completion: {
                    kind: 'auto-check',
                    command: s.completion.kind === 'auto-check' ? s.completion.command : '',
                    expectedExitCode: Number(event.target.value) || 0,
                  } as CompletionRule,
                }))}
              />
            </div>
          </>
        )}
      </div>
      <div className={css.completionFields}>
        <div className={css.formRow}>
          <label className={css.label}>{t('editor.stage.taskInputs')}</label>
          {stage.taskInputs.length === 0 ? (
            <p className={css.cardMeta}>{t('task.detail.noTaskInputs')}</p>
          ) : (
            <div className={css.taskInputList}>
              {stage.taskInputs.map((field, fieldIndex) => (
                <div key={fieldIndex} className={css.taskInputRow}>
                  <input
                    type="text"
                    className={css.input}
                    placeholder={t('editor.stage.taskInputs.name')}
                    value={field.name}
                    onChange={event => onPatch(s => ({
                      ...s,
                      taskInputs: s.taskInputs.map((f, i) => i === fieldIndex ? { ...f, name: event.target.value } : f),
                    }))}
                  />
                  <input
                    type="text"
                    className={css.input}
                    placeholder={t('editor.stage.taskInputs.label')}
                    value={field.label}
                    onChange={event => onPatch(s => ({
                      ...s,
                      taskInputs: s.taskInputs.map((f, i) => i === fieldIndex ? { ...f, label: event.target.value } : f),
                    }))}
                  />
                  <label className={css.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={event => onPatch(s => ({
                        ...s,
                        taskInputs: s.taskInputs.map((f, i) => i === fieldIndex ? { ...f, required: event.target.checked } : f),
                      }))}
                    />
                    {t('editor.stage.taskInputs.required')}
                  </label>
                  <button
                    type="button"
                    className={css.iconButton}
                    title={t('editor.stage.taskInputs.remove')}
                    onClick={() => onPatch(s => ({
                      ...s,
                      taskInputs: s.taskInputs.filter((_, i) => i !== fieldIndex),
                    }))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className={css.button}
            onClick={() => onPatch(s => ({
              ...s,
              taskInputs: [...s.taskInputs, { name: '', label: '', required: false, defaultValue: '' } satisfies TaskInputField],
            }))}
          >
            {t('editor.stage.taskInputs.add')}
          </button>
        </div>
      </div>
      <div className={css.completionFields}>
        <div className={css.formRow}>
          <label className={css.label}>{t('editor.stage.skills')}</label>
          {stage.skills.length === 0 ? (
            <p className={css.cardMeta}>{t('editor.stage.skills.hint')}</p>
          ) : (
            <div className={css.skillList}>
              {stage.skills.map((skillName, skillIndex) => (
                <div key={skillIndex} className={css.skillRow}>
                  <input
                    type="text"
                    className={css.input}
                    placeholder={t('editor.stage.skills.placeholder')}
                    value={skillName}
                    onChange={event => onPatch(s => ({
                      ...s,
                      skills: s.skills.map((sn, i) => i === skillIndex ? event.target.value : sn),
                    }))}
                  />
                  <button
                    type="button"
                    className={css.iconButton}
                    title={t('editor.stage.skills.remove')}
                    onClick={() => onPatch(s => ({
                      ...s,
                      skills: s.skills.filter((_, i) => i !== skillIndex),
                    }))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className={css.button}
            onClick={() => onPatch(s => ({ ...s, skills: [...s.skills, ''] }))}
          >
            {t('editor.stage.skills.add')}
          </button>
        </div>
      </div>
      {stages.length > 1 && (
        <div className={css.completionFields}>
          <div className={css.formRow}>
            <label className={css.label}>{t('editor.stage.edges')}</label>
            {stage.edges.length === 0 ? (
              <p className={css.cardMeta}>{t('editor.stage.edges.linear')}</p>
            ) : (
              <div className={css.skillList}>
                {stage.edges.map((edge, edgeIndex) => (
                  <div key={edgeIndex} className={css.edgeRow}>
                    <select
                      className={css.select}
                      value={edge.to}
                      onChange={event => onPatch(s => ({
                        ...s,
                        edges: s.edges.map((e, i) => i === edgeIndex ? { ...e, to: event.target.value as StageId } : e),
                      }))}
                    >
                      <option value="">{t('editor.stage.edges.selectTarget')}</option>
                      {stages.filter((st: LocalStage) => st.id !== stage.id).map((st: LocalStage) => (
                        <option key={st.id} value={st.id}>{st.title}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className={css.input}
                      placeholder={t('editor.stage.edges.predicatePlaceholder')}
                      value={edge.predicate}
                      disabled={edge.isElse}
                      onChange={event => onPatch(s => ({
                        ...s,
                        edges: s.edges.map((e, i) => i === edgeIndex ? { ...e, predicate: event.target.value } : e),
                      }))}
                    />
                    <label className={css.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={edge.isElse}
                        onChange={event => onPatch(s => ({
                          ...s,
                          edges: s.edges.map((e, i) => i === edgeIndex ? { ...e, isElse: event.target.checked, predicate: event.target.checked ? '' : e.predicate } : e),
                        }))}
                      />
                      else
                    </label>
                    <button
                      type="button"
                      className={css.iconButton}
                      title={t('editor.stage.edges.remove')}
                      onClick={() => onPatch(s => ({ ...s, edges: s.edges.filter((_, i) => i !== edgeIndex) }))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className={css.button}
                      onClick={() => onPatch(s => ({ ...s, edges: [...s.edges, { to: '' as StageId, predicate: '', isElse: false } satisfies StageEdge] }))}
            >
              {t('editor.stage.edges.add')}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

/** Re-export for type-only consumers. */
export type { WorkflowKey }
