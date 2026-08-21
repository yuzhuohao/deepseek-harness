/**
 * Workflow-designer Host service: owns the ledger + the task runner.
 *
 * Slice 3: task lifecycle (spawn → poll → advance).
 * Slice 4: human approve/reject, auto-check execution, onFailure retry.
 *
 * Stage progression:
 *   pending → spawn → running → inspect →
 *     self-declare: succeeded → advance
 *     human-confirm: waiting_human → approve(succeeded) / reject(retry)
 *     auto-check: run command → pass(succeeded) / fail(onFailure)
 *     blocked: waiting_human → approve / reject
 *     failed: onFailure(stop=task failed, retry:N=re-spawn)
 *
 * @module @huawe/dsh-workflow-designer/host-service
 */
import type { WorkflowLedgerHandle } from './host-ledger.ts'
import type { WorkflowAction, WorkflowHostState, WorkflowEventPayload } from './protocol.ts'
import { WORKFLOW_SCHEMA_VERSION } from './protocol.ts'
import type { WorkflowRunner, StageInspection, StageLaunchInput } from './host-runner.ts'
import { buildCompletionInstruction, runCheck } from './host-runner.ts'
import { evaluatePredicate, type PredicateContext } from './predicate-evaluator.ts'

/** Build the rejection prompt sent as a follow-up to the existing session. */
function buildRejectionPrompt(comment: string): string {
  const lines: string[] = []
  lines.push('你的交卷被人工驳回。请根据以下意见调整后重新完成本阶段。')
  lines.push('')
  lines.push('## 驳回意见')
  lines.push(comment.trim() === '' ? '（未提供具体意见）' : comment)
  lines.push('')
  lines.push('## 重要提醒')
  lines.push('请在完成调整后，在回复末尾输出 JSON 交卷块（与之前相同的格式）：')
  lines.push('```json')
  lines.push('{')
  lines.push('  "status": "complete" | "blocked" | "failed",')
  lines.push('  "summary": "一句话总结",')
  lines.push('  "changedPaths": [],')
  lines.push('  "decisions": [],')
  lines.push('  "unresolved": []')
  lines.push('}')
  lines.push('```')
  return lines.join('\n')
}

/** Polling interval for session inspection. */
const POLL_MS = 5_000

/** Public service handle. */
export interface WorkflowServiceHandle {
  start(): void
  dispose(): void
  snapshot(): WorkflowHostState
  eventPayload(): WorkflowEventPayload
  subscribe(listener: () => void): () => void
  apply(requestId: string, action: WorkflowAction): WorkflowHostState
}

/** Cached preset list (refreshed on start + connection reset). */
let cachedPresets: WorkflowHostState['presets'] = []

/** Fetch agent presets from the API. */
async function refreshPresets(runner: WorkflowRunner): Promise<void> {
  try {
    const presets = await runner.listAgentPresets()
    if (presets !== undefined) {
      cachedPresets = presets
    }
  } catch (error) {
    console.error('[workflow-designer] failed to fetch agent presets:', error)
  }
}

/** Create the Host service. */
export function createWorkflowService(ledger: WorkflowLedgerHandle, runner: WorkflowRunner): WorkflowServiceHandle {
  let disposed = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let pollInFlight = false
  const runningStages = new Map<string, { sessionId: string; nodeId: string; startedAt: number }>()

  return {
    start(): void {
      ledger.reconcileInterrupted()
      void startPendingTasks()
      void refreshPresets(runner)
      pollTimer = setInterval(() => { void poll() }, POLL_MS)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined }
      ledger.dispose()
    },

    snapshot(): WorkflowHostState {
      const s = ledger.state()
      return { schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: s.revision, workflows: s.workflows, tasks: s.tasks, presets: cachedPresets }
    },

    eventPayload(): WorkflowEventPayload {
      return { revision: ledger.summary().revision }
    },

    subscribe(listener: () => void): () => void {
      return ledger.subscribe(listener)
    },

    apply(requestId: string, action: WorkflowAction): WorkflowHostState {
      // Handle approve/reject as service-level operations (trigger runner side effects).
      if (action.kind === 'approve-stage') {
        ledger.approveStageRun(action.taskId, action.nodeId)
        runningStages.delete(action.taskId)
        void startStage(action.taskId)
      } else if (action.kind === 'reject-stage') {
        // Try to reuse the existing session — send a follow-up message.
        const tw = ledger.getTaskAndWorkflow(action.taskId)
        if (tw !== undefined) {
          const stageRuns = (tw.task.stageRuns as Array<Record<string, unknown>>) ?? []
          const run = stageRuns.find(sr => sr.nodeId === action.nodeId)
          const sessionId = run?.sessionId as string | undefined
          if (sessionId !== undefined) {
            // Mark as running (keeps sessionId); follow-up is async.
            ledger.rejectStageRunReuse(action.taskId, action.nodeId, action.comment)
            // Fire-and-forget: send follow-up, then track for polling.
            void sendRejectionFollowup(action.taskId, action.nodeId, sessionId, action.comment)
          } else {
            // No session ID — fall back to new session (e.g. after restart).
            ledger.rejectStageRun(action.taskId, action.nodeId, action.comment)
            runningStages.delete(action.taskId)
            void startStage(action.taskId)
          }
        }
      } else if (action.kind === 'retry-from-stage') {
        ledger.retryFromStage(action.taskId, action.nodeId)
        runningStages.delete(action.taskId)
        void startStage(action.taskId)
      } else {
        // Standard action → ledger.applyAction.
        ledger.applyAction(requestId, action)
        if (action.kind === 'create-task') {
          void startPendingTasks()
        }
      }
      const s = ledger.state()
      return { schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: s.revision, workflows: s.workflows, tasks: s.tasks, presets: cachedPresets }
    },
  }

  /** Send a rejection follow-up to an existing session and start tracking it. */
  async function sendRejectionFollowup(taskId: string, nodeId: string, sessionId: string, comment: string): Promise<void> {
    if (disposed) return
    const rejectionPrompt = buildRejectionPrompt(comment)
    try {
      await runner.sendFollowup(sessionId, rejectionPrompt)
      runningStages.set(taskId, { sessionId, nodeId, startedAt: Date.now() })
    } catch (error) {
      // Follow-up failed — fall back to creating a new session.
      console.error('[workflow-designer] follow-up failed, creating new session:', error)
      ledger.rejectStageRun(taskId, nodeId, comment)
      runningStages.delete(taskId)
      await startStage(taskId)
    }
  }

  /**
   * Post-stage-success: accumulate forbiddenPaths, check for violations,
   * evaluate branch edges to select the next stage, then advance.
   * Plan §5.2 (forbiddenPaths) + §6.3 (branch edges).
   */
  async function postStageSuccess(
    taskId: string,
    nodeId: string,
    tw: { task: Record<string, unknown>; workflow: Record<string, unknown> },
    structured: { status: string; summary: string; changedPaths?: string[]; decisions?: Array<{ key: string; value: string }>; unresolved?: string[] } | undefined,
  ): Promise<void> {
    const { task, workflow } = tw
    const stages = (workflow.stages as Array<Record<string, unknown>>) ?? []
    const stage = stages.find(s => s.id === nodeId)

    // §5.2 step 1: accumulate changedPaths into forbiddenPaths.
    const changedPaths = structured?.changedPaths ?? []
    if (changedPaths.length > 0) {
      ledger.addForbiddenPaths(taskId, changedPaths)
    }

    // Read the actual file contents from the workspace for display.
    if (changedPaths.length > 0) {
      const workspacePath = await runner.resolveWorkspacePath(workflow.workspaceId as string)
      if (workspacePath !== undefined) {
        const files = runner.readChangedFiles(workspacePath, changedPaths)
        if (files.length > 0) {
          ledger.patchStageRun(taskId, nodeId, { files })
        }
      }
    }

    // §5.2 step 4: check if this stage's changedPaths violated any existing forbiddenPaths.
    const existingForbidden = (task.forbiddenPaths as string[]) ?? []
    // The forbiddenPaths BEFORE this stage's changes (exclude the ones just added).
    const priorForbidden = existingForbidden.filter(p => !changedPaths.includes(p))
    const violations = changedPaths.filter(p => priorForbidden.some(fp => p === fp || p.startsWith(fp + '/') || fp.startsWith(p + '/')))
    if (violations.length > 0) {
      console.error(`[workflow-designer] forbidden path violation in stage ${nodeId}: ${violations.join(', ')}`)
      ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured })
      await handleFailure(taskId, nodeId, stage ?? {}, `forbidden path violation: ${violations.join(', ')}`)
      return
    }

    // §6.3: evaluate branch edges to select the next stage.
    const edges = (stage?.edges as Array<Record<string, unknown>>) ?? []
    if (edges.length === 0) {
      // No edges → linear: advance to next pending stage.
      await startStage(taskId)
      return
    }
    // Evaluate predicates to select the target edge.
    const ctx: PredicateContext = {
      structured: structured as Record<string, unknown> | undefined,
      checkOutput: undefined, // check output already consumed if auto-check
    }
    let selectedTarget: string | undefined
    let elseTarget: string | undefined
    for (const edge of edges) {
      const predicate = (edge.predicate as string) ?? ''
      const isElse = edge.isElse === true
      if (isElse) {
        elseTarget = edge.to as string
        continue
      }
      if (evaluatePredicate(predicate, ctx)) {
        selectedTarget = edge.to as string
        break
      }
    }
    const target = selectedTarget ?? elseTarget
    if (target === undefined) {
      // No matching edge and no else → task failed (Plan §6.3: "不匹配则失败").
      ledger.setTaskStatus(taskId, 'failed')
      return
    }
    // Mark all other pending stage runs as skipped (XOR merge).
    const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
    for (const sr of stageRuns) {
      if (sr.status === 'pending' && sr.nodeId !== target) {
        ledger.settleStageRun(taskId, sr.nodeId as string, { status: 'skipped', structured: undefined })
      }
    }
    await startStage(taskId)
  }

  /** Scan for pending tasks and launch their first stage. */
  async function startPendingTasks(): Promise<void> {
    if (disposed) return
    const state = ledger.state()
    for (const taskEntry of state.tasks) {
      const task = taskEntry as Record<string, unknown>
      if (task.status !== 'pending' && task.status !== 'running') continue
      const taskId = task.id as string
      if (runningStages.has(taskId)) continue
      // For 'running' tasks that lost their in-memory handle (e.g. after a restart
      // that didn't mark them interrupted), skip — reconcileInterrupted should
      // have caught them, but guard anyway.
      if (task.status === 'running') continue
      await startStage(taskId)
    }
  }

  /** Launch the first (or next) stage of a task. */
  async function startStage(taskId: string): Promise<void> {
    if (disposed) return
    const tw = ledger.getTaskAndWorkflow(taskId)
    if (tw === undefined) {
      ledger.setTaskStatus(taskId, 'failed')
      return
    }
    const { task, workflow } = tw
    const stageRuns = (task.stageRuns as Array<Record<string, unknown>>) ?? []
    const nextRun = stageRuns.find(sr => sr.status === 'pending')
    if (nextRun === undefined) {
      ledger.setTaskStatus(taskId, 'succeeded')
      return
    }
    const nodeId = nextRun.nodeId as string
    const stages = (workflow.stages as Array<Record<string, unknown>>) ?? []
    const stage = stages.find(s => s.id === nodeId)
    if (stage === undefined) {
      ledger.setTaskStatus(taskId, 'failed')
      return
    }
    // Build handoff from the previous stage's structured output.
    const runIndex = stageRuns.findIndex(sr => sr.nodeId === nodeId)
    const prevRun = runIndex > 0 ? stageRuns[runIndex - 1] : undefined
    const handoff = prevRun?.structured !== undefined
      ? '```json\n' + JSON.stringify(prevRun.structured, undefined, 2) + '\n```'
      : ''
    // Rejection comment + previous output (if re-spawned after reject).
    const rejectionComment = (nextRun.humanReview as { decision?: string; comment?: string } | undefined)?.decision === 'rejected'
      ? ((nextRun.humanReview as { comment?: string }).comment ?? '')
      : undefined
    const skills = (stage.skills as string[]) ?? []
    const taskInputs = (task.taskInputs as Record<string, string>) ?? {}
    // §5.2: inject forbiddenPaths into the prompt.
    const forbiddenPaths = (task.forbiddenPaths as string[]) ?? []
    const input: StageLaunchInput = {
      workspaceId: workflow.workspaceId as string,
      workflowName: workflow.name as string,
      stageTitle: stage.title as string,
      stageGoal: stage.goal as string,
      completionInstruction: buildCompletionInstruction(stage.completion),
      handoff,
      skills,
      taskInputs,
      rejectionComment,
      forbiddenPaths,
      sandbox: stage.sandbox as string | undefined,
      agentPreset: stage.agentPreset as string | undefined,
    }
    try {
      ledger.setTaskStatus(taskId, 'running', nodeId)
      const sessionId = await runner.launchStage(input)
      ledger.setStageRunning(taskId, nodeId, sessionId)
      runningStages.set(taskId, { sessionId, nodeId, startedAt: Date.now() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured: undefined })
      await handleFailure(taskId, nodeId, stage, message)
    }
  }

  /** Handle a stage failure — apply onFailure policy. */
  async function handleFailure(taskId: string, nodeId: string, stage: Record<string, unknown>, errorMessage: string): Promise<void> {
    const onFailure = (stage.onFailure as string | undefined) ?? 'stop'
    if (onFailure.startsWith('retry:')) {
      const maxRetry = parseInt(onFailure.slice(6), 10)
      const stageRuns = (ledger.getTaskAndWorkflow(taskId)?.task.stageRuns as Array<Record<string, unknown>>) ?? []
      const run = stageRuns.find(sr => sr.nodeId === nodeId)
      const attempt = (run?.attempt as number) ?? 0
      if (attempt < maxRetry) {
        // Reset to pending for retry — startStage will pick it up.
        ledger.rejectStageRun(taskId, nodeId, `自动重试：上一次执行失败 — ${errorMessage}`)
        await startStage(taskId)
        return
      }
    }
    // onFailure = 'stop' or retry exhausted → task fails.
    ledger.setTaskStatus(taskId, 'failed')
    console.error(`[workflow-designer] stage ${nodeId} failed for task ${taskId}: ${errorMessage}`)
  }

  /** Poll running sessions. */
  async function poll(): Promise<void> {
    if (disposed || pollInFlight) return
    pollInFlight = true
    try {
      const sessions = await runner.listSessions()
      for (const [taskId, info] of runningStages) {
        const inspection = await runner.inspect(info.sessionId, info.startedAt, sessions ?? undefined)
        await handleInspection(taskId, info.nodeId, inspection)
      }
    } catch (error) {
      console.error('[workflow-designer] poll error:', error)
    } finally {
      pollInFlight = false
    }
  }

  /** Handle a session inspection result. */
  async function handleInspection(taskId: string, nodeId: string, inspection: StageInspection): Promise<void> {
    switch (inspection.outcome) {
      case 'pending':
        return
      case 'succeeded': {
        const structured = inspection.structured
        const output = inspection.output !== undefined ? inspection.output.slice(0, 10240) : undefined
        // No structured output → enter waiting_human for human review.
        if (structured === undefined) {
          ledger.settleStageRun(taskId, nodeId, { status: 'waiting_human', structured: undefined, output })
          ledger.setTaskStatus(taskId, 'waiting_human')
          runningStages.delete(taskId)
          return
        }
        const status = structured.status
        if (status === 'complete') {
          // Check the stage's completion rule.
          const tw = ledger.getTaskAndWorkflow(taskId)
          if (tw === undefined) { ledger.setTaskStatus(taskId, 'failed'); runningStages.delete(taskId); return }
          const stages = (tw.workflow.stages as Array<Record<string, unknown>>) ?? []
          const stage = stages.find(s => s.id === nodeId)
          const completion = stage?.completion as Record<string, unknown> | undefined
          if (completion?.kind === 'auto-check') {
            await runAutoCheck(taskId, nodeId, tw, structured, output)
          } else if (completion?.kind === 'human-confirm') {
            ledger.settleStageRun(taskId, nodeId, { status: 'waiting_human', structured, output })
            ledger.setTaskStatus(taskId, 'waiting_human')
            runningStages.delete(taskId)
          } else {
            // self-declare → succeeded.
            ledger.settleStageRun(taskId, nodeId, { status: 'succeeded', structured, output })
            runningStages.delete(taskId)
            await postStageSuccess(taskId, nodeId, tw, structured)
          }
        } else if (status === 'blocked') {
          ledger.settleStageRun(taskId, nodeId, { status: 'waiting_human', structured, output })
          ledger.setTaskStatus(taskId, 'waiting_human')
          runningStages.delete(taskId)
        } else if (status === 'failed') {
          const tw = ledger.getTaskAndWorkflow(taskId)
          if (tw !== undefined) {
            const stages = (tw.workflow.stages as Array<Record<string, unknown>>) ?? []
            const stage = stages.find(s => s.id === nodeId) ?? {}
            ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured, output })
            await handleFailure(taskId, nodeId, stage, `stage submitted status=failed`)
          } else {
            ledger.setTaskStatus(taskId, 'failed')
          }
          runningStages.delete(taskId)
        } else {
          // Unknown status string → human review.
          ledger.settleStageRun(taskId, nodeId, { status: 'waiting_human', structured, output })
          ledger.setTaskStatus(taskId, 'waiting_human')
          runningStages.delete(taskId)
        }
        return
      }
      case 'failed': {
        const tw = ledger.getTaskAndWorkflow(taskId)
        if (tw !== undefined) {
          const stages = (tw.workflow.stages as Array<Record<string, unknown>>) ?? []
          const stage = stages.find(s => s.id === nodeId) ?? {}
          ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured: undefined })
          await handleFailure(taskId, nodeId, stage, inspection.error)
        } else {
          ledger.setTaskStatus(taskId, 'failed')
        }
        runningStages.delete(taskId)
        return
      }
      case 'cancelled': {
        ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured: undefined })
        ledger.setTaskStatus(taskId, 'failed')
        runningStages.delete(taskId)
        return
      }
    }
  }

  /** Run an auto-check command and settle the stage based on the result. */
  async function runAutoCheck(
    taskId: string,
    nodeId: string,
    tw: { task: Record<string, unknown>; workflow: Record<string, unknown> },
    structured: { status: string; summary: string } | undefined,
    output?: string,
  ): Promise<void> {
    const { workflow } = tw
    const stages = (workflow.stages as Array<Record<string, unknown>>) ?? []
    const stage = stages.find(s => s.id === nodeId)
    if (stage === undefined) { ledger.setTaskStatus(taskId, 'failed'); return }
    const completion = stage.completion as Record<string, unknown> | undefined
    if (completion === undefined) { ledger.setTaskStatus(taskId, 'failed'); return }
    const command = (completion.command as string) ?? ''
    const expectedExitCode = (completion.expectedExitCode as number) ?? 0
    const workspaceId = workflow.workspaceId as string
    // Resolve workspace path.
    const cwd = await runner.resolveWorkspacePath(workspaceId)
    if (cwd === undefined) {
      ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured })
      await handleFailure(taskId, nodeId, stage, 'auto-check: workspace path not found')
      return
    }
    // Run the check.
    const result = runCheck(command, cwd)
    const checkOutput = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }
    if (result.exitCode === expectedExitCode) {
      // Check passed.
      ledger.settleStageRun(taskId, nodeId, { status: 'succeeded', structured, checkOutput, output })
      runningStages.delete(taskId)
      await postStageSuccess(taskId, nodeId, { task: tw.task, workflow: tw.workflow }, structured)
    } else {
      // Check failed.
      ledger.settleStageRun(taskId, nodeId, { status: 'failed', structured, checkOutput })
      await handleFailure(taskId, nodeId, stage, `auto-check failed: exit ${result.exitCode}, expected ${expectedExitCode}`)
    }
  }
}
