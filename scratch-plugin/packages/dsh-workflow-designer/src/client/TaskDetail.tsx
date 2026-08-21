/**
 * Task detail view: progress bar, stage timeline with goals + real-time
 * status + expandable details, task inputs, and cancel/delete actions.
 *
 * UX improvements over slice 3:
 * - Progress bar (X/N stages complete)
 * - Stage goal shown in each timeline item
 * - Animated spinner for running stages
 * - Live elapsed time for running stages
 * - Expandable detail (structured output, changedPaths, decisions, check output)
 *
 * @module @huawe/dsh-workflow-designer/client/TaskDetail
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type { StageRun, TaskId, TaskStatus } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import css from './panel.module.css'

/** Task detail props. */
export interface TaskDetailProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  taskId: TaskId
  sessions: ISessions
  onBack(): void
}

/** Status badge tone. */
function statusTone(status: TaskStatus | StageRun['status']): string {
  switch (status) {
    case 'pending': return 'pending'
    case 'running': return 'running'
    case 'waiting_human': return 'waiting'
    case 'succeeded': return 'succeeded'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    case 'skipped': return 'skipped'
    default: return 'pending'
  }
}

/** Format ISO timestamp. */
function formatTime(iso: string | undefined): string {
  if (iso === undefined) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

/** Format elapsed seconds as "Xm Ys" or "Xs". */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** Map stage-run status to locale key. */
function stageStatusKey(status: StageRun['status']): string {
  return `task.stage.${status}` as never
}

/** Map task status to locale key. */
function taskStatusKey(status: TaskStatus): string {
  return `task.status.${status}` as never
}

/** Find the session id for a running/waiting stage. */
function findOpenableSession(stageRuns: readonly StageRun[]): string | undefined {
  return stageRuns.find(sr => sr.status === 'running' || sr.status === 'waiting_human')?.sessionId
}

/** Live elapsed time display (updates every second). */
function ElapsedTime({ startedAt, isRunning }: { startedAt: string | undefined; isRunning: boolean }): ReactElement | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isRunning || startedAt === undefined) return
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [isRunning, startedAt])
  if (startedAt === undefined) return null
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000
  if (!isRunning && elapsed < 0) return null
  return <span className={css.elapsedTime}>{formatElapsed(Math.max(0, elapsed))}</span>
}

/**
 * Render the task detail with progress bar + enhanced timeline.
 */
export function TaskDetail({ t, store, taskId, sessions, onBack }: TaskDetailProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const task = state.tasks.find(item => item.id === taskId)
  const [rejectingNodeId, setRejectingNodeId] = useState<string | undefined>(undefined)
  const [rejectComment, setRejectComment] = useState('')
  const [expandedNodeId, setExpandedNodeId] = useState<string | undefined>(undefined)
  const [autoExpanded, setAutoExpanded] = useState(false)

  // Auto-expand waiting_human stages so the user can review the output.
  useEffect(() => {
    if (task !== undefined && !autoExpanded) {
      const waiting = task.stageRuns.find(sr => sr.status === 'waiting_human')
      if (waiting !== undefined) {
        setExpandedNodeId(waiting.nodeId)
        setAutoExpanded(true)
      }
    }
  }, [task, autoExpanded])

  if (task === undefined) {
    return (
      <div className={css.emptyState}>
        <div className={css.emptyTitle}>{t('task.list.empty')}</div>
      </div>
    )
  }

  const isActive = task.status === 'pending' || task.status === 'running' || task.status === 'waiting_human'
  const openableSessionId = findOpenableSession(task.stageRuns)

  // Progress calculation.
  const totalStages = task.stageRuns.length
  const doneStages = task.stageRuns.filter(sr => sr.status === 'succeeded' || sr.status === 'skipped').length
  const progressPct = totalStages > 0 ? Math.round((doneStages / totalStages) * 100) : 0

  // Match stage runs to goals via definitionSnapshot.
  const snapshotStages = task.definitionSnapshot?.stages ?? []

  const handleCancel = (): void => { store.actions.cancelTask(task.id) }
  const handleDelete = (): void => {
    if (window.confirm(t('task.list.deleteConfirm'))) { store.actions.deleteTask(task.id); onBack() }
  }
  const handleOpenSession = (): void => {
    if (openableSessionId !== undefined) sessions.open(openableSessionId as SessionId)
  }
  const handleApprove = (nodeId: string): void => { store.actions.approveStage(task.id, nodeId) }
  const handleReject = (nodeId: string): void => {
    store.actions.rejectStage(task.id, nodeId, rejectComment.trim())
    setRejectingNodeId(undefined); setRejectComment('')
  }
  const handleRetryFromStage = (nodeId: string): void => { store.actions.retryFromStage(task.id, nodeId) }
  const startReject = (nodeId: string): void => { setRejectingNodeId(nodeId); setRejectComment('') }

  const inputEntries = Object.entries(task.taskInputs)

  return (
    <>
      <div className={css.listHeader}>
        <button type="button" className={css.button} onClick={onBack}>
          {t('task.detail.back')}
        </button>
      </div>

      {/* Task header + progress bar */}
      <div className={css.detailSection}>
        <h3 className={css.detailTitle}>{task.workflowName}</h3>
        <div className={css.cardMeta}>
          <span className={css.statusBadge} data-status={statusTone(task.status)}>
            {t(taskStatusKey(task.status) as never)}
          </span>
          {openableSessionId !== undefined && (
            <button type="button" className={css.linkButton} onClick={handleOpenSession}>
              {t('task.detail.openSession')}
            </button>
          )}
        </div>
        <div className={css.cardMeta}>
          <span>{t('task.detail.startedAt')}: {formatTime(task.startedAt)}</span>
          {task.endedAt !== undefined && <span> · {t('task.detail.endedAt')}: {formatTime(task.endedAt)}</span>}
        </div>
        {/* Progress bar */}
        {totalStages > 0 && (
          <div className={css.progressBar}>
            <div className={css.progressFill} style={{ width: `${progressPct}%` }} data-status={task.status === 'failed' ? 'failed' : 'succeeded'} />
            <span className={css.progressLabel}>{doneStages}/{totalStages}</span>
          </div>
        )}
      </div>

      {task.status === 'pending' && (
        <div className={css.hostPendingBanner}>{t('task.detail.hostPending')}</div>
      )}

      {/* Task inputs */}
      {inputEntries.length > 0 && (
        <div className={css.detailSection}>
          <h4 className={css.detailHeading}>{t('task.detail.taskInputs')}</h4>
          <dl className={css.inputList}>
            {inputEntries.map(([key, value]) => (
              <div key={key} className={css.inputRow}>
                <dt className={css.inputKey}>{key}</dt>
                <dd className={css.inputValue}>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Stage timeline */}
      <div className={css.detailSection}>
        <h4 className={css.detailHeading}>{t('task.detail.stageTimeline')}</h4>
        <ol className={css.timeline}>
          {task.stageRuns.map((run, index) => {
            const snapshot = snapshotStages.find(s => s.id === run.nodeId)
            const goal = snapshot?.goal ?? ''
            const isRunning = run.status === 'running'
            const isExpanded = expandedNodeId === run.nodeId
            return (
              <li key={run.nodeId} className={css.timelineItem} data-status={run.status}>
                <div className={css.timelineDot} data-status={run.status}>
                  {isRunning && <span className={css.spinner} />}
                </div>
                <div className={css.timelineContent}>
                  {/* Title + status + elapsed */}
                  <div className={css.timelineTitle}>
                    {index + 1}. {run.stageTitle}
                  </div>
                  <div className={css.cardMeta}>
                    <span className={css.statusBadge} data-status={statusTone(run.status)}>
                      {t(stageStatusKey(run.status) as never)}
                    </span>
                    {isRunning && <ElapsedTime startedAt={run.startedAt} isRunning={true} />}
                    {run.attempt > 0 && <span> · {t('task.stage.attempt', { n: String(run.attempt) })}</span>}
                    {run.startedAt !== undefined && !isRunning && <span> · {formatTime(run.startedAt)}</span>}
                  </div>
                  {/* Stage goal */}
                  {goal !== '' && (
                    <p className={css.stageGoal}>{goal}</p>
                  )}
                  {/* Summary (if structured output exists) */}
                  {run.structured?.summary !== undefined && run.structured.summary !== '' && (
                    <p className={css.cardMeta}>{run.structured.summary}</p>
                  )}
                  {/* Human review */}
                  {run.humanReview !== undefined && (
                    <p className={css.cardMeta}>
                      {run.humanReview.decision === 'approved' ? '✓' : '✗'} {run.humanReview.comment}
                    </p>
                  )}
                  {/* Check output (collapsed by default, shown when expanded) */}
                  {isExpanded && run.checkOutput !== undefined && (
                    <div className={css.checkOutput}>
                      <div className={css.cardMeta}>
                        <span className={css.statusBadge} data-status={run.checkOutput.exitCode === 0 ? 'succeeded' : 'failed'}>
                          exit {run.checkOutput.exitCode}
                        </span>
                        {run.checkOutput.timedOut && <span> · timed out</span>}
                      </div>
                      {run.checkOutput.stdout.trim() !== '' && <pre className={css.checkPre}>{run.checkOutput.stdout}</pre>}
                      {run.checkOutput.stderr.trim() !== '' && <pre className={css.checkPre}>{run.checkOutput.stderr}</pre>}
                    </div>
                  )}
                  {/* Expanded: structured details */}
                  {isExpanded && run.structured !== undefined && (
                    <div className={css.structuredDetail}>
                      {Array.isArray(run.structured.changedPaths) && run.structured.changedPaths.length > 0 && (
                        <div className={css.structuredSection}>
                          <span className={css.structuredLabel}>{t('task.detail.changedPaths')}</span>
                          <ul className={css.structuredList}>
                            {run.structured.changedPaths.map((p, i) => <li key={i}>{p}</li>)}
                          </ul>
                        </div>
                      )}
                      {Array.isArray(run.structured.decisions) && run.structured.decisions.length > 0 && (
                        <div className={css.structuredSection}>
                          <span className={css.structuredLabel}>{t('task.detail.decisions')}</span>
                          <ul className={css.structuredList}>
                            {run.structured.decisions.map((d, i) => <li key={i}><strong>{d.key}</strong>: {d.value}</li>)}
                          </ul>
                        </div>
                      )}
                      {Array.isArray(run.structured.unresolved) && run.structured.unresolved.length > 0 && (
                        <div className={css.structuredSection}>
                          <span className={css.structuredLabel}>{t('task.detail.unresolved')}</span>
                          <ul className={css.structuredList}>
                            {run.structured.unresolved.map((u, i) => <li key={i}>{u}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Expanded: model output text */}
                  {isExpanded && run.output !== undefined && run.output.trim() !== '' && (
                    <div className={css.structuredDetail}>
                      <span className={css.structuredLabel}>{t('task.detail.modelOutput')}</span>
                      <pre className={css.outputPre}>{run.output}</pre>
                    </div>
                  )}
                  {/* Expanded: produced files */}
                  {isExpanded && run.files !== undefined && run.files.length > 0 && (
                    <div className={css.structuredDetail}>
                      <span className={css.structuredLabel}>{t('task.detail.files')}</span>
                      {run.files.map((f, fi) => (
                        <div key={fi} className={css.fileBlock}>
                          <div className={css.fileHeader}>
                            <span className={css.filePath}>{f.path}</span>
                            {f.truncated && <span className={css.fileTruncated}>{t('task.detail.fileTruncated')}</span>}
                          </div>
                          <pre className={css.outputPre}>{f.content}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Expand/collapse toggle */}
                  {(run.structured !== undefined || run.checkOutput !== undefined || (run.output !== undefined && run.output.trim() !== '') || (run.files !== undefined && run.files.length > 0)) && (
                    <button
                      type="button"
                      className={css.linkButton}
                      onClick={() => setExpandedNodeId(isExpanded ? undefined : run.nodeId)}
                    >
                      {isExpanded ? t('task.detail.hideDetails') : t('task.detail.showDetails')}
                    </button>
                  )}
                  {/* Waiting for human review */}
                  {run.status === 'waiting_human' && (
                    <div className={css.reviewActions}>
                      <button type="button" className={css.primary} onClick={() => handleApprove(run.nodeId)}>
                        {t('task.detail.approve')}
                      </button>
                      {rejectingNodeId !== run.nodeId ? (
                        <button type="button" className={css.danger} onClick={() => startReject(run.nodeId)}>
                          {t('task.detail.reject')}
                        </button>
                      ) : (
                        <div className={css.rejectForm}>
                          <textarea className={css.input} rows={2} placeholder={t('task.detail.rejectPlaceholder')}
                            value={rejectComment} onChange={e => setRejectComment(e.target.value)} />
                          <button type="button" className={css.danger} onClick={() => handleReject(run.nodeId)}>
                            {t('task.detail.reject')}
                          </button>
                          <button type="button" className={css.button} onClick={() => setRejectingNodeId(undefined)}>
                            {t('new.cancel')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Retry from here */}
                  {(run.status === 'succeeded' || run.status === 'failed' || run.status === 'skipped') && !isActive && (
                    <div className={css.reviewActions}>
                      <button type="button" className={css.button} onClick={() => handleRetryFromStage(run.nodeId)}>
                        {t('task.detail.retry')}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>

      {/* Footer actions */}
      <div className={css.formActions}>
        {isActive && (
          <button type="button" className={css.button} onClick={handleCancel}>
            {t('task.detail.cancel')}
          </button>
        )}
        {!isActive && (
          <button type="button" className={css.danger} onClick={handleDelete}>
            {t('task.detail.delete')}
          </button>
        )}
      </div>
    </>
  )
}

export type { WorkflowKey }
