/**
 * Shared workflow-designer types. Kept browser-safe (no ctx, no host
 * services) so the Client half and a future Host half can both import them.
 * Slice 1 model is a simplified subset of Plan.md §6; fields marked with
 * `// Plan §6.x` point at the full baseline shape.
 */

/** Branded workflow id (opaque cross-boundary string). */
export type WorkflowId = string & { readonly __brand: 'WorkflowId' }

/** Branded stage id (opaque cross-boundary string). */
export type StageId = string & { readonly __brand: 'StageId' }

/** Branded workspace id (matches the host WorkspaceView.workspaceId brand). */
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }

/**
 * Completion rule for a stage. Plan §6.2: three options, mixed per stage.
 * Slice 1 stores the rule verbatim; enforcement arrives in slice 3+4.
 */
export type CompletionRule =
  | { kind: 'self-declare'; doneWhen: string }
  | { kind: 'human-confirm'; doneWhen: string }
  | { kind: 'auto-check'; command: string; expectedExitCode?: number }

/**
 * A condition predicate for branch edges. Plan §6.3: JSONPath left value +
 * comparison operator + value, combined with and/or.
 *
 * Syntax: `$.field operator value` (e.g. `$.status == "complete"`)
 *   - `$.status` — the structured submission's status field
 *   - `$.checks[0].exitCode` — first check's exit code
 *   - `$.decisions[?(@.key=="pkgmgr")].value` — a decision's value
 * Operators: `==`, `!=`, `in` (comma-separated list)
 * Combinators: `and`, `or`
 */
export type Predicate = string

/** An outgoing edge from a stage. Plan §6.3: linear (no predicate) or branch (with predicate + else). */
export interface StageEdge {
  /** Target stage id. */
  to: StageId
  /** Predicate expression (empty = unconditional). */
  predicate: Predicate
  /** True = this is the fallback `else` edge. */
  isElse: boolean
}

/**
 * A stage node. Slice 5 adds `edges` for branch support.
 */
export interface Stage {
  readonly id: StageId
  title: string
  goal: string
  completion: CompletionRule
  /** Plan §3 step 5 + §6.2: task-input fields this stage expects. */
  taskInputs: TaskInputField[]
  /** Skill names to inject into the stage subagent's prompt. */
  skills: string[]
  /** Plan §6.3: outgoing edges (empty = linear, advance to next stage in order). */
  edges: StageEdge[]
  /** Plan §6.2 onFailure. Defaults to 'stop'. */
  onFailure?: 'stop' | 'failEdge' | `retry:${number}`
  /** Plan §6.2 stage preset. Defaults to 'workspace-write'. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  /** Agent preset for this stage ('standard' | 'code' | 'cordis' | 'minimal'). Undefined = deployment default. */
  agentPreset?: string
  /** Plan §6.2. Slice 3 field. */
  maxTurns?: number
}

/**
 * A workflow definition. Plan §6.1: versioned, archived, workspace-bound.
 * Slice 1 stores the in-memory editable copy; KV schemaVersion arrives
 * with the Host half in slice 3.
 */
export interface WorkflowDefinition {
  readonly id: WorkflowId
  name: string
  description: string
  /** Plan §6.1: workspaceId is fixed at create time. */
  workspaceId: WorkspaceId
  stages: Stage[]
  entryStageId: StageId | undefined
  /** Plan §6.1: incremented on every save. */
  version: number
  createdAt: string
  updatedAt: string
  archived: boolean
}

/**
 * A new-workflow form payload. Plan §3 step 2–3.
 */
export interface NewWorkflowInput {
  name: string
  workspaceId: WorkspaceId
  description: string
}

/** Branded task id (opaque cross-boundary string). */
export type TaskId = string & { readonly __brand: 'TaskId' }

/** Plan §6.4 task status (closed union). */
export type TaskStatus =
  | 'pending'       // created, not yet spawned (slice 2: no execution backend)
  | 'running'       // orchestrator spawned a stage subagent
  | 'waiting_human' // stage submitted, awaiting human confirm/reject
  | 'succeeded'     // all terminal stages completed
  | 'failed'        // a stage failed and onFailure = stop
  | 'cancelled'     // user cancelled
  | 'interrupted'   // DSH process exited; not resumed

/** Plan §5.3: one stage-run record (per attempt). */
export interface StageRun {
  readonly nodeId: StageId
  stageTitle: string
  status: 'pending' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'skipped'
  attempt: number
  /** Host runner: the agent session id for this stage run. */
  sessionId?: string
  startedAt: string | undefined
  endedAt: string | undefined
  /** Plan §5.4: structured submission (filled when the stage completes). */
  structured: { status: string; summary: string; changedPaths?: string[]; decisions?: Array<{ key: string; value: string }>; unresolved?: string[] } | undefined
  /** The model's full output text (truncated to 10KB for storage). */
  output?: string
  /** Files produced/modified by this stage (content read from the workspace, each truncated to 8KB). */
  files?: Array<{ path: string; content: string; truncated: boolean }>
  /** Plan §5.3: human review decision. */
  humanReview: { decision: 'approved' | 'rejected'; comment: string } | undefined
  /** Auto-check output (filled by the orchestrator after running the check command). */
  checkOutput?: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
}

/**
 * Plan §6.4 task record. Slice 2 stores the task + a mock stage-run list
 * (all stages 'pending'); real execution arrives in slice 3.
 */
export interface TaskRecord {
  readonly id: TaskId
  workflowId: WorkflowId
  workflowName: string
  /** Plan §3 step 5: task input form values. */
  taskInputs: Record<string, string>
  status: TaskStatus
  /** Host runner: the node id of the currently executing stage. */
  currentNodeId?: string
  /** Plan §5.2: forbidden paths accumulated at task runtime (not a definition field). */
  forbiddenPaths: string[]
  /** Snapshot of the definition at start time (Plan §6.4). */
  definitionSnapshot: { workflowVersion: number; stages: { id: StageId; title: string; goal: string }[] }
  stageRuns: StageRun[]
  startedAt: string
  endedAt: string | undefined
}

/**
 * Plan §3 step 5 + §6.2: a task-input field declared on a stage.
 * The start-task form collects values for all declared fields across
 * reachable stages.
 */
export interface TaskInputField {
  name: string
  label: string
  required: boolean
  defaultValue: string
}

/** Slice 2 store snapshot (workflows + tasks). */
export interface WorkflowStoreState {
  workflows: readonly WorkflowDefinition[]
  tasks: readonly TaskRecord[]
  /** Agent presets (optional — only available when Host is connected). */
  presets?: readonly AgentPresetOption[]
}

/** One agent preset option. */
export interface AgentPresetOption {
  id: string
  name: string
  description: string
  isDefault: boolean
  broken?: string
}

/** Generate a fresh opaque id. */
export function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
}
