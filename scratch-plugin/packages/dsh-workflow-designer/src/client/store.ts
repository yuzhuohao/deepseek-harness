/**
 * Store: Host-backed with localStorage fallback.
 *
 * On creation, tries to fetch state from the Host
 * (GET /api/workflow-designer/state). If successful, all mutations are
 * POSTed to the Host and SSE keeps the cache in sync. If the Host is
 * unavailable, falls back to localStorage (the slice-1 behavior).
 *
 * Mutations are optimistic: the local cache is updated immediately, then
 * the POST is sent. On SSE revision change, the full state is re-fetched
 * to ensure consistency.
 *
 * IDs are generated client-side so create() can return them synchronously;
 * the Host action carries the same ID.
 *
 * @module @huawe/dsh-workflow-designer/client/store
 */
import type {
  AgentPresetOption,
  NewWorkflowInput,
  Stage,
  StageId,
  TaskId,
  TaskInputField,
  TaskRecord,
  TaskStatus,
  WorkflowDefinition,
  WorkflowId,
  WorkflowStoreState,
  WorkspaceId,
} from '../types.ts'
import { generateId } from '../types.ts'
import { fetchState, postAction, subscribeToEvents } from './host-api.ts'
import type { WorkflowAction } from '../protocol.ts'

/** LocalStorage key (fallback only). */
const STORAGE_KEY = 'dsh-workflow-designer:v2'

/** Initial empty state. */
const EMPTY_STATE: WorkflowStoreState = { workflows: [], tasks: [], presets: [] }

/** Public store instance. */
export interface WorkflowStoreInstance {
  subscribe(listener: () => void): () => void
  getSnapshot(): WorkflowStoreState
  readonly actions: WorkflowStoreActions
}

/** Mutation surface (same as slice 1 — components don't change). */
export interface WorkflowStoreActions {
  create(input: NewWorkflowInput): WorkflowId
  update(id: WorkflowId, patch: (current: WorkflowDefinition) => WorkflowDefinition): void
  archive(id: WorkflowId): void
  delete(id: WorkflowId): void
  setStages(id: WorkflowId, stages: Stage[]): void
  createTask(workflow: WorkflowDefinition, taskInputs: Record<string, string>): TaskId
  updateTaskStatus(taskId: TaskId, status: TaskStatus): void
  cancelTask(taskId: TaskId): void
  deleteTask(taskId: TaskId): void
  approveStage(taskId: TaskId, nodeId: string): void
  rejectStage(taskId: TaskId, nodeId: string, comment: string): void
  retryFromStage(taskId: TaskId, nodeId: string): void
}

/** Collect all task-input field declarations across a workflow's stages. */
export function collectTaskInputFields(workflow: WorkflowDefinition): TaskInputField[] {
  const seen = new Set<string>()
  const fields: TaskInputField[] = []
  for (const stage of workflow.stages) {
    for (const field of stage.taskInputs) {
      if (!seen.has(field.name)) {
        seen.add(field.name)
        fields.push(field)
      }
    }
  }
  return fields
}

/** Create the workflow store. */
export function createWorkflowStore(): WorkflowStoreInstance {
  let snapshot: WorkflowStoreState = readLocalStorage()
  let hostAvailable = false
  const listeners = new Set<() => void>()
  let lastRevision = -1

  const notify = (): void => { for (const fn of listeners) fn() }

  const setSnapshot = (next: WorkflowStoreState): void => {
    snapshot = next
    notify()
  }

  // Try Host on creation.
  void fetchState().then(state => {
    if (state !== undefined) {
      hostAvailable = true
      lastRevision = state.revision
        setSnapshot({ workflows: state.workflows as WorkflowDefinition[], tasks: state.tasks as TaskRecord[], presets: (state.presets ?? []) as AgentPresetOption[] })
      // Subscribe to SSE for live updates.
      subscribeToEvents(rev => {
        if (rev !== lastRevision) {
          lastRevision = rev
          void fetchState().then(s => {
            if (s !== undefined) {
              setSnapshot({ workflows: s.workflows as WorkflowDefinition[], tasks: s.tasks as TaskRecord[], presets: (s.presets ?? []) as AgentPresetOption[] })
            }
          })
        }
      })
    } else {
      // Host unavailable — keep localStorage state (already loaded).
    }
  })

  /** Send an action to the Host (fire-and-forget; SSE resyncs). */
  const sendToHost = (action: WorkflowAction): void => {
    if (!hostAvailable) return
    const requestId = generateId('req')
    void postAction(requestId, action).then(state => {
      if (state !== undefined) {
        lastRevision = state.revision
      setSnapshot({ workflows: state.workflows as WorkflowDefinition[], tasks: state.tasks as TaskRecord[], presets: (state.presets ?? []) as AgentPresetOption[] })
      }
    })
  }

  /** Write to localStorage (fallback). */
  const writeToLocal = (next: WorkflowStoreState): void => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* quota */ }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot(): WorkflowStoreState { return snapshot },

    actions: {
      create(input: NewWorkflowInput): WorkflowId {
        const id = generateId('wf') as WorkflowId
        const now = new Date().toISOString()
        const firstStage: Stage = {
          id: generateId('stage') as StageId,
          title: '第一阶段',
          goal: '',
          completion: { kind: 'self-declare', doneWhen: '' },
          taskInputs: [],
          skills: [],
          edges: [],
        }
        const wf: WorkflowDefinition = {
          id,
          name: input.name,
          description: input.description,
          workspaceId: input.workspaceId as WorkspaceId,
          stages: [firstStage],
          entryStageId: firstStage.id,
          version: 1,
          createdAt: now,
          updatedAt: now,
          archived: false,
        }
        // Optimistic update.
        const next: WorkflowStoreState = { workflows: [wf, ...snapshot.workflows], tasks: snapshot.tasks }
        setSnapshot(next)
        if (hostAvailable) {
          sendToHost({ kind: 'create-workflow', workflowId: id, name: input.name, workspaceId: input.workspaceId, description: input.description })
        } else {
          writeToLocal(next)
        }
        return id
      },

      update(id, patch) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows.map(w => w.id === id ? { ...patch(w), version: w.version + 1, updatedAt: new Date().toISOString() } : w),
          tasks: snapshot.tasks,
        }
        setSnapshot(next)
        if (!hostAvailable) writeToLocal(next)
      },

      archive(id) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows.map(w => w.id === id ? { ...w, archived: true, updatedAt: new Date().toISOString() } : w),
          tasks: snapshot.tasks,
        }
        setSnapshot(next)
        if (hostAvailable) sendToHost({ kind: 'archive-workflow', workflowId: id })
        else writeToLocal(next)
      },

      delete(id) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows.filter(w => w.id !== id),
          tasks: snapshot.tasks.filter(t => t.workflowId !== id),
        }
        setSnapshot(next)
        if (hostAvailable) sendToHost({ kind: 'delete-workflow', workflowId: id })
        else writeToLocal(next)
      },

      setStages(id, stages) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows.map(w => w.id === id ? { ...w, stages, version: w.version + 1, updatedAt: new Date().toISOString() } : w),
          tasks: snapshot.tasks,
        }
        setSnapshot(next)
        if (hostAvailable) sendToHost({ kind: 'set-stages', workflowId: id, stages })
        else writeToLocal(next)
      },

      createTask(workflow, taskInputs) {
        const taskId = generateId('task') as TaskId
        const now = new Date().toISOString()
        const stageRuns = workflow.stages.map(s => ({
          nodeId: s.id, stageTitle: s.title, status: 'pending' as const, attempt: 0,
          startedAt: undefined, endedAt: undefined, structured: undefined, humanReview: undefined,
        }))
        const task: TaskRecord = {
          id: taskId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          taskInputs,
          status: 'pending',
          forbiddenPaths: [],
          definitionSnapshot: {
            workflowVersion: workflow.version,
            stages: workflow.stages.map(s => ({ id: s.id, title: s.title, goal: s.goal })),
          },
          stageRuns,
          startedAt: now,
          endedAt: undefined,
        }
        const next: WorkflowStoreState = { workflows: snapshot.workflows, tasks: [task, ...snapshot.tasks] }
        setSnapshot(next)
        if (hostAvailable) sendToHost({ kind: 'create-task', taskId, workflowId: workflow.id, taskInputs })
        else writeToLocal(next)
        return taskId
      },

      updateTaskStatus(taskId, status) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows,
          tasks: snapshot.tasks.map(t => t.id === taskId ? {
            ...t,
            status,
            endedAt: status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted' ? new Date().toISOString() : t.endedAt,
          } : t),
        }
        setSnapshot(next)
        if (!hostAvailable) writeToLocal(next)
      },

      cancelTask(taskId) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows,
          tasks: snapshot.tasks.map(t => t.id === taskId ? { ...t, status: 'cancelled' as TaskStatus, endedAt: new Date().toISOString() } : t),
        }
        setSnapshot(next)
        if (hostAvailable) sendToHost({ kind: 'cancel-task', taskId })
        else writeToLocal(next)
      },

      deleteTask(taskId) {
        const next: WorkflowStoreState = {
          workflows: snapshot.workflows,
          tasks: snapshot.tasks.filter(t => t.id !== taskId),
        }
        setSnapshot(next)
        if (hostAvailable) sendToHost({ kind: 'delete-task', taskId })
        else writeToLocal(next)
      },

      approveStage(taskId, nodeId) {
        if (hostAvailable) sendToHost({ kind: 'approve-stage', taskId, nodeId })
        // Optimistic: the SSE will update the stage run status.
      },

      rejectStage(taskId, nodeId, comment) {
        if (hostAvailable) sendToHost({ kind: 'reject-stage', taskId, nodeId, comment })
      },

      retryFromStage(taskId, nodeId) {
        if (hostAvailable) sendToHost({ kind: 'retry-from-stage', taskId, nodeId })
      },
    },
  }
}

/** Read from localStorage (fallback). */
function readLocalStorage(): WorkflowStoreState {
  if (typeof localStorage === 'undefined') return EMPTY_STATE
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return EMPTY_STATE
  try {
    const parsed = JSON.parse(raw) as unknown
    const workflows = (parsed as { workflows?: unknown }).workflows
    const tasks = (parsed as { tasks?: unknown }).tasks
    if (!Array.isArray(workflows)) return EMPTY_STATE
    return {
      workflows: workflows as WorkflowDefinition[],
      tasks: Array.isArray(tasks) ? tasks as TaskRecord[] : [],
    }
  } catch {
    return EMPTY_STATE
  }
}
