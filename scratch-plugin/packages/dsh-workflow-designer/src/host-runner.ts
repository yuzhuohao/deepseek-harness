/**
 * Host task runner: wraps ctx.apiProxy to create agent sessions for each
 * workflow stage, send the stage prompt (goal + handoff + skills + task
 * inputs), and inspect the session for completion + structured output.
 *
 * Adapted from dsh-task-board's HostExecutionRunner pattern.
 *
 * @module @huawe/dsh-workflow-designer/host-runner
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'

/** Build an RPC request envelope. */
function request<T>(payload: T): { rpcId: RpcId; payload: T } {
  return { rpcId: `workflow-${randomUUID()}` as RpcId, payload }
}

/** Build a thrown Error from an RPC error result. */
function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

/** One session-list row. */
type SessionSummary = Extract<
  Awaited<ReturnType<ApiProxy['sessions']['list']>>['result'],
  { ok: true }
>['value']['items'][number]

/** Session inspection outcome. */
export type StageInspection =
  | { outcome: 'pending' }
  | { outcome: 'succeeded'; output: string; structured: { status: string; summary: string; changedPaths: string[]; decisions: Array<{ key: string; value: string }>; unresolved: string[] } | undefined }
  | { outcome: 'failed'; error: string }
  | { outcome: 'cancelled'; error: string }

/** A post-create launch failure that still carries the sessionId. */
export class StageLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super(`stage session ${sessionId} failed during launch: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'StageLaunchError'
  }
}

/** The stage launch input. */
export interface StageLaunchInput {
  workspaceId: string
  workflowName: string
  stageTitle: string
  stageGoal: string
  completionInstruction: string
  handoff: string
  skills: string[]
  taskInputs: Record<string, string>
  /** Rejection comment from a previous human review (if re-spawned after reject). */
  rejectionComment?: string | undefined
  /** Previous attempt's structured output (if re-spawned after reject/retry). */
  previousOutput?: string | undefined
  /** Forbidden paths (§5.2): the model must not modify these. */
  forbiddenPaths?: string[]
  /** Sandbox permission preset: 'read-only' | 'workspace-write' | 'danger-full-access'. */
  sandbox?: string | undefined
  /** Agent preset for this stage ('standard' | 'code' | 'cordis' | 'minimal'). */
  agentPreset?: string | undefined
}

/** Auto-check result. */
export interface CheckResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Run an auto-check command in the workspace cwd. */
export function runCheck(command: string, cwd: string, timeoutMs = 60_000): CheckResult {
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  try {
    const result = spawnSync(command, {
      cwd,
      timeout: timeoutMs,
      shell,
      encoding: 'utf8',
    })
    return {
      exitCode: result.status ?? -1,
      stdout: (result.stdout ?? '').slice(0, 8192),
      stderr: (result.stderr ?? '').slice(0, 8192),
      timedOut: result.signal === 'SIGTERM',
    }
  } catch (error) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: String(error instanceof Error ? error.message : error).slice(0, 8192),
      timedOut: false,
    }
  }
}

/** Resolve a workspace id to its filesystem path via the API. */
export async function resolveWorkspacePath(api: ApiProxy, workspaceId: string): Promise<string | undefined> {
  const workspaces = await api.workspace.list(request({}))
  if (!workspaces.result.ok) return undefined
  const ws = workspaces.result.value.items.find(item => item.workspaceId === workspaceId)
  return ws?.path
}

/** Build the prompt text for a stage. */
function buildPrompt(input: StageLaunchInput): string {
  const lines: string[] = []
  lines.push('# ' + input.workflowName + ' — ' + input.stageTitle)
  lines.push('')
  lines.push('## ⚠️ 交卷格式（强制要求）')
  lines.push('完成本阶段后，你**必须**在回复末尾输出一个 JSON 代码块。不输出此 JSON 块，本阶段无法完成，将进入人工审查。')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "status": "complete",')
  lines.push('  "summary": "一句话总结本阶段做了什么",')
  lines.push('  "changedPaths": ["改动的文件路径（相对工作区）"],')
  lines.push('  "decisions": [{"key": "约定名", "value": "约定值"}],')
  lines.push('  "unresolved": ["未解决的问题"]')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('- status: "complete"（完成）/ "blocked"（需要人工介入）/ "failed"（失败）')
  lines.push('- 即使没有改动或决策，也必须输出此 JSON 块（空数组即可）')
  lines.push('- 此 JSON 块必须是你回复的**最后一个内容块**')
  lines.push('')
  lines.push('## 目标')
  lines.push(input.stageGoal)
  lines.push('')
  lines.push('## 完成规则')
  lines.push(input.completionInstruction)
  lines.push('')
  if (input.handoff !== '') {
    lines.push('## 上一阶段交接')
    lines.push(input.handoff)
    lines.push('')
  }
  if (input.rejectionComment !== undefined && input.rejectionComment !== '') {
    lines.push('## 人工驳回意见')
    lines.push('上一轮的交卷被人工驳回，请根据以下意见调整：')
    lines.push(input.rejectionComment)
    lines.push('')
  }
  if (input.previousOutput !== undefined && input.previousOutput !== '') {
    lines.push('## 上一轮交卷')
    lines.push('```json')
    lines.push(input.previousOutput)
    lines.push('```')
    lines.push('')
  }
  if (Object.keys(input.taskInputs).length > 0) {
    lines.push('## 任务输入')
    for (const [key, value] of Object.entries(input.taskInputs)) {
      lines.push('- ' + key + ': ' + value)
    }
    lines.push('')
  }
  if (input.skills.length > 0) {
    lines.push('## 可用 Skill')
    lines.push('请在开始前加载以下 skill：')
    for (const skill of input.skills) {
      if (skill.trim() !== '') lines.push('- ' + skill.trim())
    }
    lines.push('')
  }
  if (input.forbiddenPaths !== undefined && input.forbiddenPaths.length > 0) {
    lines.push('## 禁止修改的路径')
    lines.push('以下路径是已完成阶段的产物，**禁止修改**。交卷时请在 changedPaths 中列出你实际修改的文件。')
    for (const p of input.forbiddenPaths) {
      lines.push('- ' + p)
    }
    lines.push('')
  }
  if (input.sandbox === 'danger-full-access') {
    lines.push('## 权限说明')
    lines.push('本阶段已配置完全访问权限。如果遇到 `[sandbox: file access denied]` 错误，**请立即使用 sandbox_permissions 工具**将权限升级为 `danger-full-access`，理由填写"工作流阶段需要修改工作区外的文件"，然后重试该操作。无需询问用户，升级会自动批准。')
    lines.push('')
  }
  return lines.join('\n')
}

/** Build the completion instruction text for a stage. */
export function buildCompletionInstruction(completion: unknown): string {
  if (typeof completion !== 'object' || completion === null) return '自由完成后交卷。'
  const c = completion as Record<string, unknown>
  switch (c.kind) {
    case 'self-declare':
      return `自声完成：达到以下条件后交卷：${c.doneWhen ?? '（未指定）'}`
    case 'human-confirm':
      return `人工确认：达到以下条件后交卷，等待人工确认：${c.doneWhen ?? '（未指定）'}`
    case 'auto-check':
      return `自动检查：完成后将运行检查命令 \`${c.command ?? ''}\`，期望退出码 ${c.expectedExitCode ?? 0}`
    default:
      return '自由完成后交卷。'
  }
}

/** Try to extract the last valid JSON object with a "status" field. */
function extractStructured(text: string): { status: string; summary: string; changedPaths: string[]; decisions: Array<{ key: string; value: string }>; unresolved: string[] } | undefined {
  // Strategy 1: last ```json ... ``` code block
  const jsonBlocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  for (let i = jsonBlocks.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseStructured(jsonBlocks[i]![1])
    if (parsed !== undefined) return parsed
  }
  // Strategy 2: last ``` ... ``` code block that parses as JSON
  const codeBlocks = [...text.matchAll(/```\s*\n([\s\S]*?)\n```/g)]
  for (let i = codeBlocks.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseStructured(codeBlocks[i]![1])
    if (parsed !== undefined) return parsed
  }
  // Strategy 3: scan for balanced JSON objects with a "status" field.
  // Uses balanced-brace matching (not regex) to handle nested objects correctly.
  const candidates: string[] = []
  let pos = 0
  while (pos < text.length) {
    if (text[pos] !== '{') { pos += 1; continue }
    const end = findBalancedBraceEnd(text, pos)
    if (end === -1) { pos += 1; continue }
    const candidate = text.slice(pos, end + 1)
    const parsed = tryParseStructured(candidate)
    if (parsed !== undefined) candidates.push(candidate)
    pos = end + 1
  }
  if (candidates.length > 0) {
    return tryParseStructured(candidates[candidates.length - 1]!)
  }
  return undefined
}

/** Find the index of the matching closing brace for the `{` at `start`. */
function findBalancedBraceEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Parse a JSON string into the structured submission shape; undefined on failure. */
function tryParseStructured(raw: string): { status: string; summary: string; changedPaths: string[]; decisions: Array<{ key: string; value: string }>; unresolved: string[] } | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.status !== 'string') return undefined
    return {
      status: parsed.status,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      changedPaths: Array.isArray(parsed.changedPaths) ? parsed.changedPaths as string[] : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions as Array<{ key: string; value: string }> : [],
      unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved as string[] : [],
    }
  } catch {
    return undefined
  }
}

/** The runner. */
export class WorkflowRunner {
  constructor(private readonly api: ApiProxy) {}

  /** Send a follow-up message to an existing session (e.g. rejection comment). */
  async sendFollowup(sessionId: string, text: string): Promise<void> {
    const prompted = await this.api.sessions.prompt(request({
      sessionId: sessionId as never,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text }],
    }))
    if (!prompted.result.ok) throw failure(prompted.result.error)
  }

  /** Read file contents from the workspace for the given paths. */
  readChangedFiles(workspacePath: string, paths: string[]): Array<{ path: string; content: string; truncated: boolean }> {
    const results: Array<{ path: string; content: string; truncated: boolean }> = []
    for (const relPath of paths) {
      if (relPath.trim() === '') continue
      try {
        const fullPath = join(workspacePath, relPath)
        const content = readFileSync(fullPath, 'utf8')
        const truncated = content.length > 8192
        results.push({
          path: relPath,
          content: truncated ? content.slice(0, 8192) : content,
          truncated,
        })
      } catch {
        // File not found or unreadable — skip.
      }
    }
    return results
  }

  /** Resolve a workspace id to its filesystem path. */
  async resolveWorkspacePath(workspaceId: string): Promise<string | undefined> {
    return resolveWorkspacePath(this.api, workspaceId)
  }

  /** Launch a stage: verify workspace, create session, send prompt. Returns sessionId. */
  async launchStage(input: StageLaunchInput): Promise<string> {
    // Verify workspace exists.
    const workspaces = await this.api.workspace.list(request({}))
    if (!workspaces.result.ok) throw failure(workspaces.result.error)
    if (!workspaces.result.value.items.some(item => item.workspaceId === input.workspaceId)) {
      throw new Error(`workspace not found: ${input.workspaceId}`)
    }

    // Create session.
    const createPayload: Record<string, unknown> = {
      workspaceId: input.workspaceId as never,
    }
    if (input.sandbox !== undefined && input.sandbox !== 'workspace-write') {
      createPayload.sandboxPolicy = input.sandbox
    }
    if (input.agentPreset !== undefined && input.agentPreset !== '') {
      createPayload.agentPreset = input.agentPreset
    }
    const created = await this.api.sessions.create(request(createPayload))
    if (!created.result.ok) throw failure(created.result.error)
    const sessionId = created.result.value.sessionId

    try {
      // Rename.
      const title = `${input.workflowName} — ${input.stageTitle}`
      const renamed = await this.api.sessions.rename(request({ sessionId, title }))
      if (!renamed.result.ok) throw failure(renamed.result.error)

      // Also send /permission as a reinforcement (some DSH versions use this).
      if (input.sandbox !== undefined && input.sandbox !== 'workspace-write') {
        const permText = `/permission ${input.sandbox}`
        console.log('[workflow-designer] sending permission command:', permText)
        const permCmd = await this.api.sessions.prompt(request({
          sessionId: sessionId as never,
          mode: 'queue' as const,
          content: [{ type: 'text' as const, text: permText }],
        }))
        if (!permCmd.result.ok) {
          console.error('[workflow-designer] permission command failed:', JSON.stringify(permCmd.result.error))
        } else {
          console.log('[workflow-designer] permission command accepted')
        }
      }

      // Send prompt.
      const promptText = buildPrompt(input)
      const prompted = await this.api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: promptText }],
      }))
      if (!prompted.result.ok) throw failure(prompted.result.error)
    } catch (error) {
      throw new StageLaunchError(sessionId, error)
    }
    return sessionId
  }

  /** List all available agent presets. */
  async listAgentPresets(): Promise<Array<{ id: string; name: string; description: string; isDefault: boolean; broken?: string }> | undefined> {
    try {
      const response = await this.api.agentPresets.list(request({}))
      if (!response.result.ok) return undefined
      return response.result.value.presets.map(p => ({
        id: p.id,
        name: p.name ?? p.id,
        description: p.description ?? '',
        isDefault: p.isDefault === true,
        ...(p.broken !== undefined ? { broken: p.broken } : {}),
      }))
    } catch {
      return undefined
    }
  }

  /** List all sessions (for polling). */
  async listSessions(): Promise<readonly SessionSummary[] | undefined> {
    try {
      const response = await this.api.sessions.list(request({}))
      if (!response.result.ok) return undefined
      return response.result.value.items
    } catch {
      return undefined
    }
  }

  /** Inspect a session: is it still running? If settled, extract output. */
  async inspect(sessionId: string, startedAt: number, sessions?: readonly SessionSummary[]): Promise<StageInspection> {
    let items: readonly SessionSummary[]
    if (sessions !== undefined) {
      items = sessions
    } else {
      const response = await this.api.sessions.list(request({}))
      if (!response.result.ok) return { outcome: 'pending' }
      items = response.result.value.items
    }
    const summary = items.find(item => item.sessionId === sessionId)
    if (summary === undefined) return { outcome: 'cancelled', error: 'session no longer exists' }
    if (summary.running) return { outcome: 'pending' }

    // Session settled — walk history to find the last assistant message.
    let lastAssistantText = ''
    let hadErrorTurnEnd = false
    let beforeSeq: number | undefined
    for (let page = 0; page < 20; page += 1) {
      const history = await this.api.sessions.history(request({
        sessionId: summary.sessionId,
        maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }))
      if (!history.result.ok) break
      for (const entry of history.result.value.events) {
        const evt = entry.event
        if (evt.type === 'turn/end') {
          const data = evt.data
          if (typeof data === 'object' && data !== null) {
            const reason = (data as { reason?: unknown }).reason
            if (typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'error') {
              hadErrorTurnEnd = true
            }
          }
        }
        // Capture assistant text from chunk events.
        // DSH event data shape: { turn, step, chunk: { type, text?, ... } }
        // Only capture text-delta chunks (actual model output), NOT
        // reasoning-delta chunks (model's internal thinking).
        if (evt.type === 'assistant/chunk') {
          const data = evt.data
          if (typeof data === 'string') {
            lastAssistantText += data
          } else if (typeof data === 'object' && data !== null) {
            const obj = data as Record<string, unknown>
            const chunk = obj.chunk
            if (typeof chunk === 'object' && chunk !== null) {
              const c = chunk as Record<string, unknown>
              if (c.type === 'text-delta' && typeof c.text === 'string') {
                lastAssistantText += c.text
              } else if (c.type === 'text-delta' && typeof c.delta === 'string') {
                lastAssistantText += c.delta
              }
            }
            // Fallback: legacy formats (data.text / data.delta / data.content).
            const text = obj.text ?? obj.delta ?? obj.content
            if (typeof text === 'string') {
              lastAssistantText += text
            }
          }
        }
      }
      if (!history.result.value.hasMore) break
      const oldest = history.result.value.events.reduce<number | undefined>((oldest, entry) => {
        const time = entry.event.time
        return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
      }, undefined)
      if (oldest !== undefined && oldest <= startedAt) break
      const last = history.result.value.events.at(-1)
      if (last === undefined) break
      beforeSeq = last.event.seq
    }

    if (hadErrorTurnEnd) {
      return { outcome: 'failed', error: 'session ended with error' }
    }
    const structured = extractStructured(lastAssistantText)
    return { outcome: 'succeeded', output: lastAssistantText, structured }
  }
}
