/**
 * File-backed storage for workflow definitions + task records.
 *
 * Stores a single JSON document at `~/.dsh/workflow-designer/data.json`
 * with atomic writes (tmp → rename). In-memory cache + write-through;
 * subscribe/notify for SSE. Simplified from dsh-task-board's HostTaskLedger
 * (no file locking — single-process, no concurrent access).
 *
 * Plan §6.1 + §6.4 + §10: schema-versioned; mismatch rejects.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, fsyncSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { WorkflowAction } from './protocol.ts'
import { WORKFLOW_SCHEMA_VERSION } from './protocol.ts'

/** Resolve ~/.dsh (or $DSH_HOME). */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(tmpdir(), '.dsh')
}

/** The storage directory. */
const STORAGE_DIR = join(dshHome(), 'workflow-designer')

/** The main data file. */
const DATA_FILE = join(STORAGE_DIR, 'data.json')

/** The on-disk document shape. */
interface LedgerDocument {
  schemaVersion: number
  revision: number
  workflows: unknown[]
  tasks: unknown[]
  recentRequests: string[]
}

/** Empty initial document. */
const EMPTY_DOC: LedgerDocument = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  revision: 0,
  workflows: [],
  tasks: [],
  recentRequests: [],
}

/** Maximum recent-request cache (idempotency). */
const MAX_RECENT = 128

/** Public ledger handle. */
export interface WorkflowLedgerHandle {
  state(): LedgerDocument
  summary(): { revision: number }
  subscribe(listener: () => void): () => void
  applyAction(requestId: string, action: WorkflowAction): LedgerDocument
  /** Runner-facing: get a task + its workflow definition. */
  getTaskAndWorkflow(taskId: string): { task: Record<string, unknown>; workflow: Record<string, unknown> } | undefined
  /** Runner-facing: mark a stage run as running + record the session id. */
  setStageRunning(taskId: string, nodeId: string, sessionId: string): void
  /** Runner-facing: settle a stage run with the inspection result. */
  settleStageRun(taskId: string, nodeId: string, patch: Record<string, unknown>): void
  /** Runner-facing: update task status + currentNodeId. */
  setTaskStatus(taskId: string, status: string, currentNodeId?: string): void
  /** Runner-facing: settle a stage run as succeeded (human approved). */
  approveStageRun(taskId: string, nodeId: string): void
  /** Runner-facing: settle a stage run as failed + reset for retry with rejection comment. */
  rejectStageRun(taskId: string, nodeId: string, comment: string): void
  /** Runner-facing: reuse the existing session for a reject-retry. */
  rejectStageRunReuse(taskId: string, nodeId: string, comment: string): void
  /** Runner-facing: add paths to a task's forbiddenPaths (§5.2 step 1). */
  addForbiddenPaths(taskId: string, paths: string[]): void
  /** Runner-facing: patch a stage run's fields (e.g. add files) without changing status. */
  patchStageRun(taskId: string, nodeId: string, patch: Record<string, unknown>): void
  /** Runner-facing: reset a stage and all subsequent stages to pending (user retry). */
  retryFromStage(taskId: string, nodeId: string): void
  /** Runner-facing: mark all running/waiting tasks as interrupted. */
  reconcileInterrupted(): void
  dispose(): void
}

/** Create the file-backed ledger. */
export function createWorkflowLedger(): WorkflowLedgerHandle {
  let doc: LedgerDocument = readFromDisk()
  const listeners = new Set<() => void>()

  const notify = (): void => { for (const fn of listeners) fn() }

  return {
    state(): LedgerDocument {
      return { ...doc, workflows: [...doc.workflows], tasks: [...doc.tasks] }
    },
    summary(): { revision: number } {
      return { revision: doc.revision }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    applyAction(requestId: string, action: WorkflowAction): LedgerDocument {
      const fingerprint = hashRequest(requestId, action)
      if (doc.recentRequests.includes(fingerprint)) {
        return this.state()
      }
      doc = applyActionToDoc(doc, action)
      doc.recentRequests = [...doc.recentRequests, fingerprint].slice(-MAX_RECENT)
      doc.revision += 1
      writeToDisk(doc)
      notify()
      return this.state()
    },
    getTaskAndWorkflow(taskId: string): { task: Record<string, unknown>; workflow: Record<string, unknown> } | undefined {
      const task = doc.tasks.find(t => (t as Record<string, unknown>).id === taskId) as Record<string, unknown> | undefined
      if (task === undefined) return undefined
      const workflowId = task.workflowId as string
      const workflow = doc.workflows.find(w => (w as Record<string, unknown>).id === workflowId) as Record<string, unknown> | undefined
      if (workflow === undefined) return undefined
      return { task, workflow }
    },
    setStageRunning(taskId: string, nodeId: string, sessionId: string): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          return {
            ...task,
            stageRuns: stageRuns.map(sr => sr.nodeId === nodeId ? { ...sr, status: 'running', sessionId, startedAt: new Date().toISOString() } : sr),
          }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    settleStageRun(taskId: string, nodeId: string, patch: Record<string, unknown>): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          return {
            ...task,
            stageRuns: stageRuns.map(sr => sr.nodeId === nodeId ? { ...sr, ...patch, endedAt: new Date().toISOString() } : sr),
          }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    setTaskStatus(taskId: string, status: string, currentNodeId?: string): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const now = new Date().toISOString()
          const ended = status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted' ? now : task.endedAt
          return { ...task, status, ...(currentNodeId !== undefined ? { currentNodeId } : {}), endedAt: ended }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    approveStageRun(taskId: string, nodeId: string): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          return {
            ...task,
            stageRuns: stageRuns.map(sr => sr.nodeId === nodeId ? { ...sr, status: 'succeeded', humanReview: { decision: 'approved', comment: '' }, endedAt: new Date().toISOString() } : sr),
          }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    rejectStageRun(taskId: string, nodeId: string, comment: string): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          return {
            ...task,
            stageRuns: stageRuns.map(sr => {
              if (sr.nodeId !== nodeId) return sr
              const attempt = (sr.attempt as number) ?? 0
              return {
                ...sr,
                status: 'pending',
                attempt: attempt + 1,
                humanReview: { decision: 'rejected', comment },
                startedAt: undefined,
                endedAt: undefined,
                sessionId: undefined,
                structured: undefined,
              }
            }),
          }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    rejectStageRunReuse(taskId: string, nodeId: string, comment: string): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          return {
            ...task,
            status: 'running',
            stageRuns: stageRuns.map(sr => {
              if (sr.nodeId !== nodeId) return sr
              const attempt = (sr.attempt as number) ?? 0
              return {
                ...sr,
                status: 'running',
                attempt: attempt + 1,
                humanReview: { decision: 'rejected', comment },
                endedAt: undefined,
                structured: undefined,
                // sessionId is kept — the session is reused.
              }
            }),
          }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    addForbiddenPaths(taskId: string, paths: string[]): void {
      if (paths.length === 0) return
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const existing = (task.forbiddenPaths as string[]) ?? []
          const merged = [...new Set([...existing, ...paths])]
          return { ...task, forbiddenPaths: merged }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    patchStageRun(taskId: string, nodeId: string, patch: Record<string, unknown>): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          return {
            ...task,
            stageRuns: stageRuns.map(sr => sr.nodeId === nodeId ? { ...sr, ...patch } : sr),
          }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    retryFromStage(taskId: string, nodeId: string): void {
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.id !== taskId) return t
          const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
          // Find the index of the target stage
          const targetIndex = stageRuns.findIndex(sr => sr.nodeId === nodeId)
          if (targetIndex === -1) return task
          // Reset the target stage + all subsequent stages to pending
          const resetRuns = stageRuns.map((sr, i) => {
            if (i < targetIndex) return sr // keep prior stages as-is
            return {
              ...sr,
              status: 'pending',
              attempt: 0,
              startedAt: undefined,
              endedAt: undefined,
              sessionId: undefined,
              structured: undefined,
              humanReview: undefined,
              checkOutput: undefined,
            }
          })
          return { ...task, status: 'pending', currentNodeId: undefined, stageRuns: resetRuns }
        }),
      }
      doc.revision += 1
      writeToDisk(doc)
      notify()
    },
    reconcileInterrupted(): void {
      let changed = false
      doc = {
        ...doc,
        tasks: doc.tasks.map(t => {
          const task = t as Record<string, unknown>
          if (task.status === 'running' || task.status === 'waiting_human') {
            changed = true
            return { ...task, status: 'interrupted', endedAt: new Date().toISOString() }
          }
          return t
        }),
      }
      if (changed) {
        doc.revision += 1
        writeToDisk(doc)
        notify()
      }
    },
    dispose(): void {
      listeners.clear()
    },
  }
}

/** Read and validate the on-disk document; fall back to empty on missing/corrupt. */
function readFromDisk(): LedgerDocument {
  try {
    if (!existsSync(DATA_FILE)) return { ...EMPTY_DOC }
    const raw = readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_DOC }
    const obj = parsed as Record<string, unknown>
    if (obj.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
      // Wrong schema — start fresh (pre-release: no migration).
      return { ...EMPTY_DOC }
    }
    return {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: typeof obj.revision === 'number' ? obj.revision : 0,
      workflows: Array.isArray(obj.workflows) ? obj.workflows : [],
      tasks: Array.isArray(obj.tasks) ? obj.tasks : [],
      recentRequests: Array.isArray(obj.recentRequests) ? obj.recentRequests : [],
    }
  } catch {
    return { ...EMPTY_DOC }
  }
}

/** Atomically write the document to disk. */
function writeToDisk(doc: LedgerDocument): void {
  mkdirSync(STORAGE_DIR, { recursive: true })
  const tmp = join(STORAGE_DIR, `.data.tmp.${process.pid}.${Date.now()}`)
  const data = JSON.stringify(doc, undefined, 2)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, data)
    try { fsyncSync(fd) } catch { /* Windows: fsync on regular files is no-op */ }
  } finally {
    closeSync(fd)
  }
  try { renameSync(tmp, DATA_FILE) } catch {
    // Rename failed — best effort: write directly.
    try { writeFileSync(DATA_FILE, data, { encoding: 'utf8' }) } catch { /* give up */ }
    try { if (existsSync(tmp)) { /* leftover tmp */ } } catch { /* ignore */ }
  }
  // Best-effort directory fsync (POSIX only).
  try { fsyncSync(openSync(dirname(DATA_FILE), 'r')) } catch { /* Windows: ignore */ }
}

/** SHA-256 fingerprint of requestId + action for idempotency. */
function hashRequest(requestId: string, action: WorkflowAction): string {
  return createHash('sha256').update(JSON.stringify({ requestId, action })).digest('hex').slice(0, 32)
}

/** Apply one action to the document, returning a new document (no mutation). */
function applyActionToDoc(doc: LedgerDocument, action: WorkflowAction): LedgerDocument {
  const now = new Date().toISOString()
  switch (action.kind) {
    case 'create-workflow': {
      const stageId = `stage_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
      const workflow = {
        id: action.workflowId,
        name: action.name,
        description: action.description,
        workspaceId: action.workspaceId,
        stages: [{ id: stageId, title: '第一阶段', goal: '', completion: { kind: 'self-declare', doneWhen: '' }, taskInputs: [], skills: [], edges: [] }],
        entryStageId: stageId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        archived: false,
      }
      return { ...doc, workflows: [workflow, ...doc.workflows] }
    }
    case 'update-workflow': {
      return {
        ...doc,
        workflows: doc.workflows.map((w): unknown => {
          const wf = w as Record<string, unknown>
          if (wf.id !== action.workflowId) return w
          return { ...wf, ...action.patch, version: ((wf.version as number) ?? 0) + 1, updatedAt: now }
        }),
      }
    }
    case 'delete-workflow': {
      return {
        ...doc,
        workflows: doc.workflows.filter((w) => (w as Record<string, unknown>).id !== action.workflowId),
        tasks: doc.tasks.filter((t) => (t as Record<string, unknown>).workflowId !== action.workflowId),
      }
    }
    case 'archive-workflow': {
      return {
        ...doc,
        workflows: doc.workflows.map((w): unknown => {
          const wf = w as Record<string, unknown>
          return wf.id === action.workflowId ? { ...wf, archived: true, updatedAt: now } : w
        }),
      }
    }
    case 'set-stages': {
      return {
        ...doc,
        workflows: doc.workflows.map((w): unknown => {
          const wf = w as Record<string, unknown>
          if (wf.id !== action.workflowId) return w
          return { ...wf, stages: action.stages, version: ((wf.version as number) ?? 0) + 1, updatedAt: now }
        }),
      }
    }
    case 'create-task': {
      const workflow = doc.workflows.find((w) => (w as Record<string, unknown>).id === action.workflowId) as Record<string, unknown> | undefined
      if (workflow === undefined) return doc
      const taskId = action.taskId
      const stages = (workflow.stages as Array<Record<string, unknown>>) ?? []
      const task = {
        id: taskId,
        workflowId: action.workflowId,
        workflowName: workflow.name,
        taskInputs: action.taskInputs,
        status: 'pending',
        forbiddenPaths: [],
        definitionSnapshot: {
          workflowVersion: workflow.version,
          stages: stages.map(s => ({ id: s.id, title: s.title, goal: s.goal })),
        },
        stageRuns: stages.map(s => ({
          nodeId: s.id,
          stageTitle: s.title,
          status: 'pending',
          attempt: 0,
          startedAt: undefined,
          endedAt: undefined,
          structured: undefined,
          humanReview: undefined,
        })),
        startedAt: now,
        endedAt: undefined,
      }
      return { ...doc, tasks: [task, ...doc.tasks] }
    }
    case 'cancel-task': {
      return {
        ...doc,
        tasks: doc.tasks.map((t): unknown => {
          const task = t as Record<string, unknown>
          return task.id === action.taskId
            ? { ...task, status: 'cancelled', endedAt: now }
            : t
        }),
      }
    }
    case 'delete-task': {
      return {
        ...doc,
        tasks: doc.tasks.filter((t) => (t as Record<string, unknown>).id !== action.taskId),
      }
    }
    case 'approve-stage':
    case 'reject-stage': {
      // These are handled by the service (not the ledger's applyAction),
      // because they trigger runner side effects. The service calls
      // ledger.approveStageRun / rejectStageRun directly. If they arrive
      // here via applyAction, treat as no-op (the service already handled).
      return doc
    }
    default: {
      // Unknown action kind — no-op.
      return doc
    }
  }
}
