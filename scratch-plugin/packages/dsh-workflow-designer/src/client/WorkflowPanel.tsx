/**
 * Panel body: header (返回会话 + actions + title) + always-on tab bar
 * (工作流 / 任务) + content area. The tab bar is permanently rendered
 * between header and content so switching tabs or drilling into a sub-view
 * never shifts layout — adapted from dsh-ssh's SshPanel pattern.
 *
 * @module @huawe/dsh-workflow-designer/client/WorkflowPanel
 */
import { useCallback, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowKey } from './locales.ts'
import type { TaskId, WorkflowDefinition, WorkflowId } from '../types.ts'
import type { WorkflowStoreInstance } from './store.ts'
import { WorkflowList } from './WorkflowList.tsx'
import { NewWorkflowDialog } from './NewWorkflowDialog.tsx'
import { EditorView } from './EditorView.tsx'
import { TaskList } from './TaskList.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { StartTaskDialog } from './StartTaskDialog.tsx'
import css from './panel.module.css'

/** The panel's internal view state. */
type PanelView =
  | { kind: 'list' }
  | { kind: 'editor'; workflowId: WorkflowId }
  | { kind: 'startTask'; workflowId: WorkflowId }
  | { kind: 'tasks' }
  | { kind: 'task'; taskId: TaskId }

/** Full panel props. */
export interface WorkflowPanelProps {
  t: TranslateNS<'workflow'>
  store: WorkflowStoreInstance
  workspaces: IWorkspaces
  sessions: ISessions
  onClose(): void
}

/** Tab definitions. */
const TABS = [
  { id: 'workflows', label: 'tabs.workflows' as const },
  { id: 'tasks', label: 'tabs.tasks' as const },
] as const

/** Which top-level tab a view belongs to. */
function tabOf(view: PanelView): 'workflows' | 'tasks' {
  return view.kind === 'tasks' || view.kind === 'task' ? 'tasks' : 'workflows'
}

/** The title for the current view. */
function titleOf(t: TranslateNS<'workflow'>, view: PanelView, store: WorkflowStoreInstance): string {
  switch (view.kind) {
    case 'list': return t('panel.title')
    case 'editor': return t('editor.title', { name: nameOf(store, view.workflowId) })
    case 'startTask': return t('task.start.formTitle', { name: nameOf(store, view.workflowId) })
    case 'tasks': return t('task.list.title')
    case 'task': return t('task.detail.title')
  }
}

/**
 * Render the panel shell + tab bar + content.
 * @param props - copy, store, workspaces handle, and close callback.
 * @returns the panel element tree.
 */
export function WorkflowPanel({ t, store, workspaces, sessions, onClose }: WorkflowPanelProps): ReactElement {
  const [view, setView] = useState<PanelView>({ kind: 'list' })
  const [editorDirty, setEditorDirty] = useState(false)
  const [showNewDialog, setShowNewDialog] = useState(false)

  const activeTab = tabOf(view)

  const handleNew = useCallback(() => setShowNewDialog(true), [])
  const handleCreated = useCallback((id: WorkflowId) => {
    setShowNewDialog(false)
    setView({ kind: 'editor', workflowId: id })
    setEditorDirty(false)
  }, [])
  const handleOpen = useCallback((workflow: WorkflowDefinition) => {
    setView({ kind: 'editor', workflowId: workflow.id })
    setEditorDirty(false)
  }, [])
  const handleDirty = useCallback((dirty: boolean) => setEditorDirty(dirty), [])
  const handleTaskStarted = useCallback((taskId: TaskId) => {
    setView({ kind: 'task', taskId })
    setEditorDirty(false)
  }, [])
  const handleOpenTask = useCallback((task: { id: TaskId }) => {
    setView({ kind: 'task', taskId: task.id })
  }, [])

  const handleTabClick = (tab: 'workflows' | 'tasks'): void => {
    setView(tab === 'workflows' ? { kind: 'list' } : { kind: 'tasks' })
    setEditorDirty(false)
  }

  const title = titleOf(t, view, store)

  return (
    <div className={css.panel} role="dialog" aria-modal="false" aria-label={t('panel.title')}>
      <header className={css.header}>
        <div className={css.headerRow}>
          <button type="button" className={css.closeButton} onClick={onClose}>
            <span aria-hidden="true">‹</span>
            <span>{t('panel.close')}</span>
          </button>
          <div className={css.headerActions}>
            {view.kind === 'editor' && (
              <>
                <button
                  type="button"
                  className={css.button}
                  onClick={() => setView({ kind: 'startTask', workflowId: view.workflowId })}
                  disabled={editorDirty}
                  title={editorDirty ? t('task.start.unsaved') : undefined}
                >
                  {t('task.start')}
                </button>
                <button
                  type="button"
                  className={css.button}
                  onClick={() => { setView({ kind: 'list' }); setEditorDirty(false) }}
                >
                  {t('action.back')}
                </button>
              </>
            )}
            {view.kind === 'startTask' && (
              <button
                type="button"
                className={css.button}
                onClick={() => { setView({ kind: 'editor', workflowId: view.workflowId }); setEditorDirty(false) }}
              >
                {t('action.back')}
              </button>
            )}
            {view.kind === 'task' && (
              <button type="button" className={css.button} onClick={() => setView({ kind: 'tasks' })}>
                {t('task.detail.back')}
              </button>
            )}
          </div>
          <h2 className={css.title}>{title}</h2>
          {view.kind === 'list' && (
            <button type="button" className={css.primary} onClick={handleNew}>
              {t('action.new')}
            </button>
          )}
        </div>
        <nav className={css.tabBar} role="tablist">
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              data-active={activeTab === tab.id ? '' : undefined}
              className={css.tab}
              onClick={() => handleTabClick(tab.id)}
            >
              {t(tab.label)}
            </button>
          ))}
        </nav>
      </header>
      <div className={css.body}>
        {view.kind === 'list' && (
          <WorkflowList t={t} store={store} onOpen={handleOpen} />
        )}
        {view.kind === 'editor' && (
          <EditorView
            t={t}
            store={store}
            workflowId={view.workflowId}
            onDirty={handleDirty}
          />
        )}
        {view.kind === 'startTask' && (
          <StartTaskDialog
            t={t}
            store={store}
            workflow={workflowOf(store, view.workflowId)}
            onStarted={handleTaskStarted}
            onCancel={() => { setView({ kind: 'editor', workflowId: view.workflowId }) }}
          />
        )}
        {view.kind === 'tasks' && (
          <TaskList t={t} store={store} onOpen={handleOpenTask} />
        )}
        {view.kind === 'task' && (
          <TaskDetail t={t} store={store} taskId={view.taskId} sessions={sessions} onBack={() => setView({ kind: 'tasks' })} />
        )}
      </div>
      {showNewDialog && createPortal(
        (
          <div className={css.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowNewDialog(false) }}>
            <NewWorkflowDialog
              t={t}
              store={store}
              workspaces={workspaces}
              onCreated={handleCreated}
              onCancel={() => setShowNewDialog(false)}
            />
          </div>
        ),
        document.body,
      )}
    </div>
  )
}

/** Resolve the workflow name for the editor title (live snapshot read). */
function nameOf(store: WorkflowStoreInstance, id: WorkflowId): string {
  const snapshot = store.getSnapshot()
  const workflow = snapshot.workflows.find(item => item.id === id)
  return workflow?.name ?? ''
}

/** Resolve the workflow definition for the start-task dialog. */
function workflowOf(store: WorkflowStoreInstance, id: WorkflowId): WorkflowDefinition {
  const snapshot = store.getSnapshot()
  const workflow = snapshot.workflows.find(item => item.id === id)
  if (workflow === undefined) throw new Error(`workflow ${id} not found`)
  return workflow
}

/** Re-export for type-only consumers. */
export type { WorkflowKey }
